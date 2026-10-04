/**
 * ISC Validator Handler
 *
 * Validates that ISC.json was properly populated during algorithm execution.
 * Ported from PAI v2.5 ISCValidator.ts handler.
 *
 * VALIDATION RULES:
 * 1. ISC.json criteria array must be non-empty after algorithm execution
 * 2. ISC.json must have been modified since session start
 * 3. THREAD.md should not have _Pending..._ placeholders
 * 4. LEARN phase must produce algorithm-reflections.jsonl write (v3.1: LEARN artifact gate)
 *
 * BEHAVIOR:
 * - WARNS if validation fails (logs to file-logger)
 * - Can optionally return blocking signal (not implemented yet in OpenCode)
 *
 * @module isc-validator
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import { getCurrentWorkPath, getLearningDir } from "../lib/paths";

/**
 * ISC Data structure
 */
interface ISCData {
	criteria: { description: string; status: string }[] | string[];
	anti_criteria: string[];
	updated_at?: string;
}

/**
 * Validation result
 */
export interface ISCValidationResult {
	valid: boolean;
	warnings: string[];
	errors: string[];
	algorithmDetected: boolean;
	criteriaCount: number;
}

/**
 * Read ISC.json from session path
 */
function readISC(sessionPath: string): ISCData | null {
	try {
		const iscPath = path.join(sessionPath, "ISC.json");
		if (!fs.existsSync(iscPath)) return null;
		return JSON.parse(fs.readFileSync(iscPath, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Read THREAD.md from session path
 */
function readThread(sessionPath: string): string | null {
	try {
		const threadPath = path.join(sessionPath, "THREAD.md");
		if (!fs.existsSync(threadPath)) return null;
		return fs.readFileSync(threadPath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Read META.yaml to get session start time
 */
function getSessionStartTime(sessionPath: string): Date | null {
	try {
		const metaPath = path.join(sessionPath, "META.yaml");
		if (!fs.existsSync(metaPath)) return null;
		const content = fs.readFileSync(metaPath, "utf-8");
		const match = content.match(/started_at:\s*(.+)/);
		if (match) {
			return new Date(match[1]);
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Get file modification time
 */
function getFileModTime(filePath: string): Date | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const stats = fs.statSync(filePath);
		return stats.mtime;
	} catch {
		return null;
	}
}

/**
 * Detect if LEARN phase is present in the response text
 */
function detectLearnPhase(responseText: string): boolean {
	const learnMarkers = [
		"━━━ 📚 LEARN",
		"LEARN ━━━ 7/7",
	];
	return learnMarkers.some((marker) => responseText.includes(marker));
}

/**
 * Validate that LEARN phase produced a JSONL reflection write to disk.
 *
 * Rationale: The Algorithm requires writing reflections to
 * MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl during LEARN.
 * When the DA writes LEARN text but forgets the JSONL, the learning is
 * lost on session end. This check catches that gap at response time.
 *
 * Returns a warning string if LEARN phase detected but no recent JSONL
 * write, or null if everything is fine.
 */
const REQUIRED_REFLECTION_FIELDS = [
	"timestamp",
	"effort_level",
	"task_description",
	"implied_sentiment",
	"reflection_q1",
	"reflection_q2",
	"reflection_q3",
];

/**
 * Shape check on the entry that was just written.
 *
 * Valid JSON was never enough: the schema drifted into four variants because
 * every session hand-assembled the line from a prose example. Recent sessions
 * wrote ts/task/q1_self with a free-text outcome, which MineReflections could
 * not read at all — 17 of 29 entries reached the analysis blank.
 */
function validateReflectionShape(lastLine: string): string | null {
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(lastLine) as Record<string, unknown>;
	} catch {
		return null; // the integrity check above already reported this
	}

	const missing = REQUIRED_REFLECTION_FIELDS.filter(
		(field) => record[field] === undefined || record[field] === "",
	);
	if (missing.length > 0) {
		return `LEARN artifact skjemaavvik: siste refleksjon mangler ${missing.join(", ")} — skriv den med 'bun PAI/Tools/WriteReflection.ts' i stedet for håndlaget JSON`;
	}

	if (typeof record.implied_sentiment !== "number") {
		return `LEARN artifact skjemaavvik: implied_sentiment er ${typeof record.implied_sentiment}, ikke et tall 1-10 — skriv refleksjonen med 'bun PAI/Tools/WriteReflection.ts'`;
	}

	return null;
}

function validateLearnArtifact(responseText: string): string | null {
	if (!detectLearnPhase(responseText)) return null;

	try {
		const learningDir = getLearningDir();
		const reflectionsPath = path.join(learningDir, "REFLECTIONS", "algorithm-reflections.jsonl");

		if (!fs.existsSync(reflectionsPath)) {
			return "LEARN phase detected but reflections JSONL file missing entirely — learning will be lost";
		}

		const stats = fs.statSync(reflectionsPath);
		const secondsSinceWrite = (Date.now() - stats.mtimeMs) / 1000;

		// The JSONL should have been written within the last 120s (this response).
		// If it hasn't been touched in >120s, the DA likely forgot to write it.
		if (secondsSinceWrite > 120) {
			return `LEARN phase detected but reflections JSONL not written in ${Math.round(secondsSinceWrite)}s — learning may not be persisted`;
		}

		// Integrity: every non-empty line must be valid JSON. A partially written
		// or otherwise corrupt line silently breaks every downstream consumer
		// (MineReflections, AlgorithmUpgrade) — the mtime check alone misses this.
		const badLines: number[] = [];
		const raw = fs.readFileSync(reflectionsPath, "utf-8");
		raw.split("\n").forEach((line, index) => {
			if (!line.trim()) return;
			try {
				JSON.parse(line);
			} catch {
				badLines.push(index + 1);
			}
		});
		if (badLines.length > 0) {
			const shown = badLines.slice(0, 5).join(", ");
			const suffix = badLines.length > 5 ? " …" : "";
			return `LEARN artifact corrupt: ${badLines.length} ugyldig(e) JSONL-linje(r) i algorithm-reflections.jsonl (linje ${shown}${suffix}) — reparer før mining`;
		}

		// Only the entry from this session is checked for shape; older lines are
		// legacy schemas that MineReflections normalizes on read.
		const entries = raw.split("\n").filter((line) => line.trim());
		const shapeProblem = validateReflectionShape(entries[entries.length - 1] ?? "");
		if (shapeProblem) return shapeProblem;

		fileLog(
			`[ISCValidator] ✓ LEARN artifact verified (written ${Math.round(secondsSinceWrite)}s ago, JSONL valid)`,
		);
		return null;
	} catch (error) {
		fileLogError("[ISCValidator] LEARN artifact check failed", error);
		return null; // Don't block on I/O errors
	}
}

/**
 * Log validation results to file logger.
 * Extracted so it can be called from both the early-return path (no session)
 * and the normal path (with session checks).
 */
function logValidationResults(result: ISCValidationResult): void {
	if (result.errors.length > 0) {
		fileLog("[ISCValidator] ERRORS:");
		for (const e of result.errors) {
			fileLog(`  ❌ ${e}`, "error");
		}
		result.valid = false;
	}

	if (result.warnings.length > 0) {
		fileLog("[ISCValidator] WARNINGS:");
		for (const w of result.warnings) {
			fileLog(`  ⚠️  ${w}`, "warn");
		}
	}

	if (result.valid && result.warnings.length === 0) {
		if (result.algorithmDetected) {
			fileLog(`[ISCValidator] ✓ Validation passed (${result.criteriaCount} criteria)`);
		}
	}
}

/**
 * Detect if algorithm was attempted in response text
 */
function detectAlgorithmExecution(responseText: string): boolean {
	const algorithmMarkers = [
		"OBSERVE",
		"📦 CAPABILITIES",
		"ISC TRACKER",
		"🎯 ISC",
		"IDEAL STATE",
		"PAI ALGORITHM",
		"🤖 PAI",
		"TASK:",
		"VERIFY",
		"━━━",
	];

	return algorithmMarkers.some((marker) =>
		responseText.toUpperCase().includes(marker.toUpperCase())
	);
}

/**
 * Validate ISC.json for current work session
 *
 * @param responseText - The assistant's response text (to detect algorithm execution)
 * @returns Validation result with warnings and errors
 */
export async function validateISC(
	responseText: string = "",
	sessionId?: string
): Promise<ISCValidationResult> {
	const result: ISCValidationResult = {
		valid: true,
		warnings: [],
		errors: [],
		algorithmDetected: false,
		criteriaCount: 0,
	};

	try {
		// Check if algorithm was attempted (needed even if no session)
		result.algorithmDetected = detectAlgorithmExecution(responseText);

		// Rule 0: LEARN artifact check (global file, independent of work session)
		// Must run BEFORE sessionPath gate — JSONL is not session-scoped
		{
			const learnWarning = validateLearnArtifact(responseText);
			if (learnWarning) {
				result.warnings.push(learnWarning);
			}
		}

		// Get current work session path
		const sessionPath = await getCurrentWorkPath(sessionId);
		if (!sessionPath) {
			fileLog("[ISCValidator] No active work session - skipping session checks");
			// Still log results if warnings exist (e.g., from Rule 0)
			logValidationResults(result);
			return result;
		}

		// Read ISC.json
		const isc = readISC(sessionPath);
		if (!isc) {
			if (result.algorithmDetected) {
				result.errors.push("ISC.json not found after algorithm execution");
				result.valid = false;
			}
			return result;
		}

		// Count criteria
		result.criteriaCount = Array.isArray(isc.criteria) ? isc.criteria.length : 0;

		// Rule 1: If algorithm was attempted, criteria should be non-empty
		if (result.algorithmDetected && result.criteriaCount === 0) {
			result.warnings.push(
				"ISC.json criteria array is EMPTY - algorithm may not have executed properly"
			);
		}

		// Rule 2: Check if ISC.json was modified after session start
		const sessionStart = getSessionStartTime(sessionPath);
		const iscPath = path.join(sessionPath, "ISC.json");
		const iscModTime = getFileModTime(iscPath);

		if (sessionStart && iscModTime && iscModTime <= sessionStart) {
			if (result.algorithmDetected) {
				result.warnings.push(
					"ISC.json not modified since session start - no updates during algorithm execution"
				);
			}
		}

		// Rule 3: Check THREAD.md for pending placeholders
		const thread = readThread(sessionPath);
		if (thread) {
			const pendingCount = (thread.match(/_Pending\.\.\._/g) || []).length;
			if (pendingCount > 0) {
				result.warnings.push(
					`THREAD.md has ${pendingCount} phases still marked _Pending..._ - algorithm phases not logged`
				);
			}
		}

		// Log results and return
		logValidationResults(result);
		return result;
	} catch (error) {
		fileLogError("[ISCValidator] Validation failed", error);
		return result;
	}
}

/**
 * Get ISC criteria count for current session
 * Useful for status displays
 */
export async function getISCCriteriaCount(sessionId?: string): Promise<number> {
	try {
		const sessionPath = await getCurrentWorkPath(sessionId);
		if (!sessionPath) return 0;

		const isc = readISC(sessionPath);
		if (!isc) return 0;

		return Array.isArray(isc.criteria) ? isc.criteria.length : 0;
	} catch {
		return 0;
	}
}

/**
 * Update ISC criteria
 * Called when algorithm creates/updates ISC
 */
export async function updateISCCriteria(
	criteria: { description: string; status: string }[],
	sessionId?: string
): Promise<boolean> {
	try {
		const sessionPath = await getCurrentWorkPath(sessionId);
		if (!sessionPath) {
			fileLog("[ISCValidator] No active session - cannot update ISC");
			return false;
		}

		const iscPath = path.join(sessionPath, "ISC.json");

		// Read existing ISC or create new
		let isc: ISCData = { criteria: [], anti_criteria: [] };
		try {
			if (fs.existsSync(iscPath)) {
				isc = JSON.parse(fs.readFileSync(iscPath, "utf-8"));
			}
		} catch {
			// Use default
		}

		// Update criteria
		isc.criteria = criteria;
		isc.updated_at = new Date().toISOString();

		// Write back
		fs.writeFileSync(iscPath, JSON.stringify(isc, null, 2));
		fileLog(`[ISCValidator] Updated ISC with ${criteria.length} criteria`);

		return true;
	} catch (error) {
		fileLogError("[ISCValidator] Failed to update ISC", error);
		return false;
	}
}
