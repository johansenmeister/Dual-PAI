#!/usr/bin/env bun
/**
 * ============================================================================
 * WRITEREFLECTION — append one schema-valid LEARN reflection to the log
 * ============================================================================
 *
 * PURPOSE:
 * Builds the canonical algorithm-reflections.jsonl entry from arguments,
 * validates it, appends it, and reads it back to prove it landed. The LEARN
 * phase calls this instead of assembling a JSON line by hand.
 *
 * WHY THIS EXISTS:
 * The entry used to be produced by copying a prose example out of the
 * Algorithm spec. It drifted into four incompatible shapes (ts/task/q1_self,
 * incident rows, free-text outcome instead of numeric sentiment), and
 * MineReflections silently read only the canonical subset — 12 of 29 entries —
 * for months. A schema a script owns cannot drift. A schema prose owns does.
 *
 * USAGE:
 *   bun WriteReflection.ts --task "..." --effort Standard --sentiment 8 \
 *     --q1 "..." --q2 "..." --q3 "..." \
 *     [--criteria-count N --criteria-passed N --criteria-failed N] \
 *     [--prd-id PRD-20260919-slug] [--within-budget true] [--rework 0] \
 *     [--dry-run]
 *
 *   bun WriteReflection.ts --check     # classify every line already in the log
 *
 * EXIT CODES:
 *   0  written and verified
 *   1  invalid arguments, invalid schema, or corrupt lines found by --check
 *   2  the line was written but did not read back correctly
 *
 * ============================================================================
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { detectSchema } from "./MineReflections";

const PAI_DIR =
	process.env.PAI_DIR || path.join(homedir(), ".opencode");

const REFLECTIONS_PATH = path.join(
	PAI_DIR,
	"MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl",
);

/** LEARN only runs for Standard+, so the lower tiers are deliberately absent. */
const EFFORT_TIERS = ["Standard", "Extended", "Advanced", "Deep", "Comprehensive"];

const REQUIRED_TEXT_FIELDS = [
	"timestamp",
	"task_description",
	"reflection_q1",
	"reflection_q2",
	"reflection_q3",
];

const OPTIONAL_COUNT_FIELDS = [
	"criteria_count",
	"criteria_passed",
	"criteria_failed",
	"rework_count",
];

// ─── Arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
	const args: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			args[key] = true;
		} else {
			args[key] = next;
			i++;
		}
	}
	return args;
}

function argString(args: Record<string, string | boolean>, key: string): string {
	const value = args[key];
	return typeof value === "string" ? value.trim() : "";
}

function argNumber(
	args: Record<string, string | boolean>,
	key: string,
): number | undefined {
	const value = args[key];
	if (typeof value !== "string") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function argBoolean(
	args: Record<string, string | boolean>,
	key: string,
): boolean | undefined {
	const value = args[key];
	if (value === true) return true;
	if (typeof value !== "string") return undefined;
	const lowered = value.toLowerCase();
	if (["true", "yes", "1"].includes(lowered)) return true;
	if (["false", "no", "0"].includes(lowered)) return false;
	return undefined;
}

/** ISO-8601 with the local UTC offset, matching what the spec's example shows. */
function localIsoTimestamp(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absolute = Math.abs(offsetMinutes);

	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
		`${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
	);
}

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * The single definition of a valid entry. MineReflections still normalizes the
 * older shapes on read, but nothing written from here should ever need it.
 */
function validateRecord(record: Record<string, unknown>): string[] {
	const problems: string[] = [];

	for (const field of REQUIRED_TEXT_FIELDS) {
		const value = record[field];
		if (typeof value !== "string" || !value.trim()) {
			problems.push(`${field}: required, must be a non-empty string`);
		}
	}

	if (
		typeof record.effort_level !== "string" ||
		!EFFORT_TIERS.includes(record.effort_level)
	) {
		problems.push(`effort_level: must be one of ${EFFORT_TIERS.join(", ")}`);
	}

	const sentiment = record.implied_sentiment;
	if (
		typeof sentiment !== "number" ||
		!Number.isInteger(sentiment) ||
		sentiment < 1 ||
		sentiment > 10
	) {
		problems.push(
			"implied_sentiment: must be a whole number from 1 to 10 — your estimate of how satisfied the user is, not a status word",
		);
	}

	for (const field of OPTIONAL_COUNT_FIELDS) {
		const value = record[field];
		if (value !== undefined && (typeof value !== "number" || value < 0)) {
			problems.push(`${field}: must be a number >= 0 when present`);
		}
	}

	if (record.within_budget !== undefined && typeof record.within_budget !== "boolean") {
		problems.push("within_budget: must be true or false");
	}

	return problems;
}

// ─── Modes ───────────────────────────────────────────────────────────────────

/** Classify what is already on disk, without pretending legacy shapes are corrupt. */
function runCheck(): void {
	if (!fs.existsSync(REFLECTIONS_PATH)) {
		console.error(`No reflections file at ${REFLECTIONS_PATH}`);
		process.exit(1);
	}

	const lines = fs
		.readFileSync(REFLECTIONS_PATH, "utf-8")
		.split("\n")
		.filter((l) => l.trim());

	const shapes: Record<string, number> = {};
	const invalidJson: number[] = [];
	const nonCanonical: number[] = [];

	lines.forEach((line, index) => {
		let raw: Record<string, unknown>;
		try {
			raw = JSON.parse(line) as Record<string, unknown>;
		} catch {
			invalidJson.push(index + 1);
			return;
		}
		const shape = detectSchema(raw);
		shapes[shape] = (shapes[shape] ?? 0) + 1;
		if (shape !== "canonical") nonCanonical.push(index + 1);
	});

	console.log(`File: ${REFLECTIONS_PATH}`);
	console.log(`Lines: ${lines.length}`);
	console.log(
		`Shapes: ${Object.entries(shapes).map(([name, n]) => `${name}=${n}`).join(", ") || "none"}`,
	);

	if (nonCanonical.length > 0) {
		console.log(
			`Legacy shapes on line(s) ${nonCanonical.join(", ")} — readable via normalization, but not what the spec mandates.`,
		);
	}

	if (invalidJson.length > 0) {
		console.error(`CORRUPT: ${invalidJson.length} line(s) are not valid JSON: ${invalidJson.join(", ")}`);
		process.exit(1);
	}

	process.exit(0);
}

function usage(): void {
	console.error(
		[
			"Usage: bun WriteReflection.ts --task <text> --effort <tier> --sentiment <1-10> \\",
			"         --q1 <text> --q2 <text> --q3 <text>",
			"         [--criteria-count N] [--criteria-passed N] [--criteria-failed N]",
			"         [--prd-id ID] [--within-budget true|false] [--rework N] [--dry-run]",
			"",
			"   or: bun WriteReflection.ts --check",
			"",
			`Effort tiers: ${EFFORT_TIERS.join(", ")}`,
		].join("\n"),
	);
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));

	if (args.check === true) {
		runCheck();
		return;
	}

	if (args.help === true || Object.keys(args).length === 0) {
		usage();
		process.exit(1);
	}

	const record: Record<string, unknown> = {
		timestamp: argString(args, "timestamp") || localIsoTimestamp(),
		effort_level: argString(args, "effort"),
		task_description: argString(args, "task"),
		criteria_count: argNumber(args, "criteria-count"),
		criteria_passed: argNumber(args, "criteria-passed"),
		criteria_failed: argNumber(args, "criteria-failed"),
		prd_id: argString(args, "prd-id") || undefined,
		implied_sentiment: argNumber(args, "sentiment"),
		reflection_q1: argString(args, "q1"),
		reflection_q2: argString(args, "q2"),
		reflection_q3: argString(args, "q3"),
		within_budget: argBoolean(args, "within-budget"),
		rework_count: argNumber(args, "rework"),
	};

	for (const key of Object.keys(record)) {
		if (record[key] === undefined) delete record[key];
	}

	const problems = validateRecord(record);
	if (problems.length > 0) {
		console.error("Reflection rejected — nothing was written:");
		for (const problem of problems) console.error(`  - ${problem}`);
		console.error("");
		usage();
		process.exit(1);
	}

	const line = JSON.stringify(record);

	if (args["dry-run"] === true) {
		console.log(line);
		console.log("[DRY RUN] Nothing appended.");
		process.exit(0);
	}

	fs.mkdirSync(path.dirname(REFLECTIONS_PATH), { recursive: true });

	// An interrupted previous write leaves the file without a trailing newline,
	// which would silently merge two entries into one corrupt line.
	if (fs.existsSync(REFLECTIONS_PATH)) {
		const existing = fs.readFileSync(REFLECTIONS_PATH, "utf-8");
		if (existing.length > 0 && !existing.endsWith("\n")) {
			fs.appendFileSync(REFLECTIONS_PATH, "\n", "utf-8");
		}
	}

	fs.appendFileSync(REFLECTIONS_PATH, `${line}\n`, "utf-8");

	// Read back: the LEARN gate has been fooled before by a write that looked
	// like it succeeded. Proving the line is on disk costs one read.
	const written = fs
		.readFileSync(REFLECTIONS_PATH, "utf-8")
		.split("\n")
		.filter((l) => l.trim());
	const last = written[written.length - 1];

	if (last !== line) {
		console.error("Write-back check FAILED: the last line on disk is not the line just written.");
		process.exit(2);
	}

	try {
		const problemsOnDisk = validateRecord(JSON.parse(last) as Record<string, unknown>);
		if (problemsOnDisk.length > 0) {
			console.error(`Write-back check FAILED: ${problemsOnDisk.join("; ")}`);
			process.exit(2);
		}
	} catch {
		console.error("Write-back check FAILED: the last line on disk is not valid JSON.");
		process.exit(2);
	}

	console.log(`✓ Reflection appended and verified (line ${written.length}) → ${REFLECTIONS_PATH}`);
}

if (import.meta.main) {
	main();
}
