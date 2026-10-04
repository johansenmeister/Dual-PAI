/**
 * Agent Capture Handler
 *
 * Equivalent to PAI v2.4 AgentOutputCapture hook.
 * Captures subagent (Task tool) outputs and persists to MEMORY/RESEARCH/
 *
 * @module agent-capture
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import { ensureDir, getResearchDir, getTimestamp, getYearMonth, slugify } from "../lib/paths";
import { somObjekt, somTekst } from "../lib/payload";
import { isSubagentTool } from "../lib/tool-names";

/**
 * Agent output structure
 */
export interface AgentOutput {
	agentType: string;
	description: string;
	result: string;
	timestamp: string;
	duration?: number;
}

/**
 * Capture result
 */
export interface CaptureAgentResult {
	success: boolean;
	filepath?: string;
	error?: string;
}

/**
 * Extract agent type from Task tool args
 */
function extractAgentType(args: Record<string, unknown>): string {
	return somTekst(args.subagent_type) || "general-purpose";
}

/**
 * Extract description from Task tool args
 */
function extractDescription(args: Record<string, unknown>): string {
	return somTekst(args.description) || "Agent task";
}

/**
 * Extract result text from tool output
 *
 * Handles various output formats from Task tool
 */
function extractResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (result && typeof result === "object") {
		// { output }, { result } eller { message }, i den rekkefølgen. Første
		// felt som ER en streng vinner — også en tom en, som da hopper over
		// fangsten under framfor å lagre `{"output": ""}` som en fil.
		const felt = somObjekt(result);
		for (const navn of ["output", "result", "message"]) {
			const verdi = felt[navn];
			if (typeof verdi === "string") return verdi;
		}

		// Stringify object
		return JSON.stringify(result, null, 2);
	}

	return String(result || "No output");
}

/**
 * Generate summary from result text
 *
 * Takes first 100 chars or first line, whichever is shorter
 */
function generateSummary(text: string): string {
	const firstLine = text.split("\n")[0].trim();
	const truncated = firstLine.slice(0, 100);
	return truncated.length < firstLine.length ? `${truncated}...` : truncated;
}

/**
 * Capture agent output
 *
 * Called after Task tool completes.
 * Writes to MEMORY/RESEARCH/{YYYY-MM}/AGENT-{type}_{timestamp}_{slug}.md
 */
/**
 * Monoton teller for filnavn. Nullstilles per prosess, som er nok: PID-en
 * skiller prosessene fra hverandre.
 */
let captureCounter = 0;

export async function captureAgentOutput(
	args: Record<string, unknown>,
	result: unknown
): Promise<CaptureAgentResult> {
	try {
		const agentType = extractAgentType(args);
		const description = extractDescription(args);
		const resultText = extractResultText(result);

		// Don't capture empty results
		if (!resultText || resultText.length < 10) {
			fileLog("Agent output too short, skipping capture", "debug");
			return { success: true };
		}

		// Ensure directory exists
		const researchDir = getResearchDir();
		const yearMonth = getYearMonth();
		const monthDir = path.join(researchDir, yearMonth);
		await ensureDir(monthDir);

		// Generate filename
		// M-06: `getTimestamp()` har SEKUNDoppløsning. To agenter som fullfører
		// innenfor samme sekund — helt vanlig ved parallell spawning — fikk
		// identisk filnavn, og den andre overskrev den første i stillhet.
		//
		// Suffikset har tre ledd, og alle trengs:
		//   millisekunder  leselig og sorterbart
		//   PID            skiller PROSESSER, dit systemet er på vei
		//   teller         skiller kall i SAMME millisekund og prosess
		//
		// Første forsøk hadde bare de to første, og testen avslørte at to
		// agenter startet med `Promise.all` fortsatt kolliderte — de traff
		// samme millisekund i samme prosess.
		const timestamp = getTimestamp();
		const unik = `${String(Date.now() % 1000).padStart(3, "0")}-${process.pid}-${++captureCounter}`;
		const slug = slugify(description.slice(0, 30));
		const filename = `AGENT-${agentType}_${timestamp}-${unik}_${slug}.md`;
		const filepath = path.join(monthDir, filename);

		// Generate markdown content
		const summary = generateSummary(resultText);
		const content = `# Agent Output: ${agentType}

**Description:** ${description}
**Timestamp:** ${new Date().toISOString()}
**Agent Type:** ${agentType}

---

## Summary

${summary}

---

## Full Output

${resultText}

---

*Captured by AgentOutputCapture handler*
`;

		await fs.promises.writeFile(filepath, content);
		fileLog(`Agent output captured: ${filename}`, "info");

		return { success: true, filepath };
	} catch (error) {
		fileLogError("Failed to capture agent output", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Check if tool is a Task (subagent) tool
 *
 * Navnetabellen bor i `lib/tool-names.ts` fordi tre handlere trengte den og
 * hadde tre litt ulike kopier. Den viktigste forskjellen den rydder: Claude
 * Codes subagent-verktøy heter `Agent`, ikke `Task` (målt 2026-09-22), så
 * den gamle testen her traff aldri under Claude.
 */
export function isTaskTool(toolName: string): boolean {
	return isSubagentTool(toolName);
}

/**
 * Get recent agent outputs
 */
export async function getRecentAgentOutputs(limit = 10): Promise<AgentOutput[]> {
	try {
		const researchDir = getResearchDir();
		const yearMonth = getYearMonth();
		const monthDir = path.join(researchDir, yearMonth);

		const files = await fs.promises.readdir(monthDir);
		const agentFiles = files
			.filter((f) => f.startsWith("AGENT-") && f.endsWith(".md"))
			.sort()
			.reverse()
			.slice(0, limit);

		const outputs: AgentOutput[] = [];

		for (const file of agentFiles) {
			try {
				const content = await fs.promises.readFile(path.join(monthDir, file), "utf-8");

				// Parse agent type from filename
				const match = file.match(/^AGENT-([^_]+)_/);
				const agentType = match ? match[1] : "unknown";

				// Extract description from content
				const descMatch = content.match(/\*\*Description:\*\* (.+)/);
				const description = descMatch ? descMatch[1] : file;

				outputs.push({
					agentType,
					description,
					result: content,
					timestamp: new Date().toISOString(),
				});
			} catch {
				// Skip files that can't be read
			}
		}

		return outputs;
	} catch {
		return [];
	}
}
