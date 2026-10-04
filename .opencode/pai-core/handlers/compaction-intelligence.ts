/**
 * Compaction Intelligence Handler
 *
 * Injects PAI-critical context into OpenCode's compaction summary.
 * Uses the experimental.session.compacting hook to ensure the LLM
 * includes subagent registry, ISC criteria, and PRD status in its summary.
 *
 * HOOK: experimental.session.compacting
 * INPUT: { sessionID: string }
 * OUTPUT: { context: string[]; prompt?: string }
 *
 * Kjernen bygger seksjoner; adapteren APPENDER dem (erstatter ikke prompten) så OpenCodes
 * default summary template still runs — we just add PAI-specific sections.
 *
 * @module compaction-intelligence
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import { getStateDir, resolveSessionDir } from "../lib/paths";
import { finnPrd } from "./prd-sync";
import { buildRegistryContext } from "./session-registry";

/**
 * Read the active PRD for a session and extract status information.
 */
function buildPrdContext(sessionId: string): string | null {
	try {
		const stateDir = getStateDir();

		// Check session-scoped work state ONLY (no fallback to prevent cross-session leak)
		const stateFile = path.join(stateDir, `current-work-${sessionId}.json`);
		if (!fs.existsSync(stateFile)) return null;

		const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
		const workDir = state.work_dir || state.session_dir;
		if (!workDir) return null;

		// Read PRD file. `resolveSessionDir` tar både absolutt og relativ form,
		// og avviser en sti utenfor WORK (M-09).
		const sessionDir = resolveSessionDir(workDir);
		if (!sessionDir) return null;
		// `PRD.md`, eller en eldre `PRD-<dato>-<slug>.md` (M-47).
		const prdPath = finnPrd(sessionDir);
		if (!prdPath) return null;

		const prdContent = fs.readFileSync(prdPath, "utf-8");

		// Extract frontmatter fields
		const statusMatch = prdContent.match(/^status:\s*(.+)$/m);
		const progressMatch = prdContent.match(/^verification_summary:\s*"?(\d+\/\d+)"?$/m);
		const failingMatch = prdContent.match(/^failing_criteria:\s*\[([^\]]*)\]$/m);
		const effortMatch = prdContent.match(/^effort_level:\s*(.+)$/m);
		const phaseMatch = prdContent.match(/^(?:last_)?phase:\s*(.+)$/m);

		// Extract ISC criteria (lines starting with - [ ] or - [x])
		const criteria = prdContent.match(/^- \[[ x]\] ISC-[^\n]+/gm) || [];

		const lines = [
			"## Active PRD Status",
			"",
			`**Status:** ${statusMatch?.[1] || "unknown"}`,
			`**Progress:** ${progressMatch?.[1] || "unknown"}`,
			`**Effort Level:** ${effortMatch?.[1] || "unknown"}`,
			`**Last Phase:** ${phaseMatch?.[1] || "unknown"}`,
		];

		if (failingMatch?.[1]?.trim()) {
			lines.push(`**Failing Criteria:** ${failingMatch[1]}`);
		}

		if (criteria.length > 0) {
			lines.push("");
			lines.push("### ISC Criteria (carry forward — these ARE the verification checklist):");
			lines.push("");
			for (const c of criteria) {
				lines.push(c);
			}
		}

		return lines.join("\n");
	} catch (error) {
		fileLogError("[CompactionIntelligence] Failed to read PRD", error);
		return null;
	}
}

/**
 * Build additional context about current Algorithm state.
 * Reads session-specific algorithm state to prevent cross-session bleed.
 */
function buildAlgorithmContext(sessionId: string): string | null {
	try {
		const stateDir = getStateDir();
		// Session-specific state file to prevent cross-session bleed
		const algorithmStatePath = path.join(stateDir, `algorithm-state-${sessionId}.json`);
		if (!fs.existsSync(algorithmStatePath)) return null;

		const state = JSON.parse(fs.readFileSync(algorithmStatePath, "utf-8"));

		const lines = [
			"## Algorithm State",
			"",
			`**Current Phase:** ${state.currentPhase || "unknown"}`,
			`**Effort Level:** ${state.effortLevel || "Standard"}`,
			`**Criteria Count:** ${state.criteriaCount || 0}`,
		];

		if (state.currentTask) {
			lines.push(`**Current Task:** ${state.currentTask}`);
		}

		return lines.join("\n");
	} catch {
		return null;
	}
}

/**
 * Bygg PAI-seksjonene som skal inn i kompakteringssammendraget.
 *
 * Returnerer seksjonene i stedet for å mutere motorens output. Adapteren
 * eier den koblingen — OpenCode tar en `context`-array, Claude Codes
 * PreCompact tar en streng, og kjernen skal ikke kjenne forskjellen.
 *
 * Kaster aldri: kompaktering må ikke feile på grunn av oss. Ved feil
 * returneres det som allerede er bygget.
 */
export async function buildCompactionContext(input: { sessionID: string }): Promise<string[]> {
	const sections: string[] = [];
	try {

		// 1. Subagent Registry (from ADR-012)
		const registryCtx = buildRegistryContext(input.sessionID);
		if (registryCtx) {
			sections.push(registryCtx);
		}

		// 2. Active PRD + ISC Criteria
		const prdCtx = buildPrdContext(input.sessionID);
		if (prdCtx) {
			sections.push(prdCtx);
		}

		// 3. Algorithm State (session-specific to prevent cross-session bleed)
		const algCtx = buildAlgorithmContext(input.sessionID);
		if (algCtx) {
			sections.push(algCtx);
		}

		// 4. Recovery instructions
		sections.push(
			[
				"## Post-Compaction Recovery Tools",
				"",
				"After compaction, these tools are available to recover context:",
				"- `session_registry` — Lists all subagent sessions with their IDs",
				"- `session_results(session_id)` — Retrieves output from a specific subagent",
				"",
				"Subagent data SURVIVES compaction. It is stored in OpenCode's database.",
				"Do NOT claim results are lost — use the tools above to recover them.",
			].join("\n")
		);

		fileLog(
			`[CompactionIntelligence] Bygget ${sections.length} kontekstseksjoner for økt ${input.sessionID}`,
			"info"
		);
	} catch (error) {
		fileLogError("[CompactionIntelligence] Bygging feilet (ikke-blokkerende)", error);
		// Ikke-blokkerende — kompaktering må ikke feile på grunn av oss.
	}
	return sections;
}
