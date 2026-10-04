/**
 * Agent Execution Guard Handler (v3.0)
 *
 * Validates agent execution patterns — warns when agents are spawned
 * without proper capability selection or background execution settings.
 *
 * Ported from PAI v3.0 AgentExecutionGuard.hook.ts
 *
 * @module agent-execution-guard
 */

import { fileLog, fileLogError } from "../lib/file-logger";
import { subagentFraArgs } from "../lib/tool-names";

interface GuardResult {
	allowed: boolean;
	reason?: string;
}

/**
 * Validate agent execution parameters
 *
 * In OpenCode, we can't block execution like Claude Code hooks can.
 * Instead, we log warnings for suboptimal patterns.
 */
export async function validateAgentExecution(args: unknown): Promise<GuardResult> {
	try {
		// Begge motorenes feltnavn (M-50): v2 sender `agent`, ikke `subagent_type`.
		const { type, prompt } = subagentFraArgs(args);
		const subagentType = type || "unknown";

		// Check 1: Explore agents for simple operations
		// If the prompt suggests a simple grep/glob/read, warn
		const simplePatterns = [
			/find (the|a) file/i,
			/search for/i,
			/look for.*in/i,
			/check if.*exists/i,
		];

		// Småbokstaver: OpenCodes agent heter `explore`, Claudes `Explore`.
		// Med eksakt sammenligning fyrte sjekken aldri under Claude.
		if (subagentType.toLowerCase() === "explore") {
			for (const pattern of simplePatterns) {
				if (pattern.test(prompt)) {
					fileLog(
						`[AgentGuard] Warning: Explore agent for simple operation — consider using Grep/Glob/Read directly`,
						"warn"
					);
					return {
						allowed: true,
						reason:
							"Consider using direct tools (Grep/Glob/Read) instead of Explore agent for simple lookups",
					};
				}
			}
		}

		// Check 2: Agent prompt should have context
		if (prompt.length < 50) {
			fileLog(
				`[AgentGuard] Warning: Agent prompt is very short (${prompt.length} chars) — agents need full context`,
				"warn"
			);
			return {
				allowed: true,
				reason: "Agent prompt is very short. Include: context, task, effort level, output format",
			};
		}

		fileLog(`[AgentGuard] Agent execution OK: ${subagentType}`, "debug");
		return { allowed: true };
	} catch (error) {
		fileLogError("[AgentGuard] Validation failed", error);
		return { allowed: true, reason: "Validation error — allowing execution" };
	}
}

/**
 * Check if an agent should run in background
 */
export function shouldRunInBackground(args: unknown): boolean {
	const { type: subagentType, prompt } = subagentFraArgs(args);

	// Long-running agent types benefit from background execution
	const longRunning = [
		"DeepResearcher",
		"GeminiResearcher",
		"PerplexityResearcher",
		"GrokResearcher",
		"CodexResearcher",
	];

	if (longRunning.includes(subagentType)) return true;
	if (prompt.length > 2000) return true;

	return false;
}
