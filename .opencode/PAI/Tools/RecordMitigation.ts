#!/usr/bin/env bun
/**
 * ============================================================================
 * RECORDMITIGATION — log that a reflection theme has been acted on
 * ============================================================================
 *
 * PURPOSE:
 * Appends one record to MEMORY/LEARNING/MITIGATIONS/mitigations.jsonl.
 * MineReflections reads the ledger and sorts every theme into three buckets:
 * regression (evidence dated after the fix), new (no fix recorded), and
 * addressed (all evidence predates the fix).
 *
 * WHY THIS EXISTS:
 * Nothing used to mark a theme as handled. infrastructure-safety-rules.md was
 * written 2026-08-14 in response to the FTPS incident, and a month later the
 * mining job still reported those same incidents as the top new finding —
 * while the one entry that genuinely mattered (2026-09-02, same failure class,
 * after the fix) was ranked no differently. The ledger makes that difference
 * visible.
 *
 * NEVER TRIM THE REFLECTIONS LOG. A deleted entry cannot prove a regression.
 *
 * USAGE:
 *   bun RecordMitigation.ts --theme "..." --artifact PATH [--commit SHA] \
 *     [--date 2026-09-19] [--note "..."] [--covers ts1,ts2] [--dry-run]
 *
 *   bun RecordMitigation.ts --list
 *
 * EXIT CODES: 0 ok · 1 invalid arguments · 2 write-back failed
 *
 * ============================================================================
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MITIGATIONS_PATH, loadMitigations, type Mitigation } from "./MineReflections";

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

function today(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Ids are sequential so the model can cite them: M1, M2, M3. */
function nextId(existing: Mitigation[]): string {
	const numbers = existing
		.map((m) => /^M(\d+)$/i.exec(m.id)?.[1])
		.filter((n): n is string => Boolean(n))
		.map(Number);
	return `M${(numbers.length > 0 ? Math.max(...numbers) : 0) + 1}`;
}

function usage(): void {
	console.error(
		[
			"Usage: bun RecordMitigation.ts --theme <text> [--artifact <path>] [--commit <sha>]",
			"         [--date YYYY-MM-DD] [--note <text>] [--covers <ts,ts>] [--dry-run]",
			"",
			"   or: bun RecordMitigation.ts --list",
			"",
			"The theme text is what the model matches against, so phrase it the way the",
			"mining report phrases the theme, not the way the fix is implemented.",
		].join("\n"),
	);
}

function runList(): void {
	const existing = loadMitigations();
	if (existing.length === 0) {
		console.log(`No mitigations recorded yet (${MITIGATIONS_PATH})`);
		return;
	}
	console.log(`${existing.length} mitigation(s) in ${MITIGATIONS_PATH}\n`);
	for (const m of existing) {
		console.log(`${m.id}  ${m.mitigated_at}  ${m.theme}`);
		const source = [m.artifact, m.commit].filter(Boolean).join(" · ");
		if (source) console.log(`      ${source}`);
		if (m.note) console.log(`      ${m.note}`);
	}
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));

	if (args.list === true) {
		runList();
		return;
	}

	const theme = argString(args, "theme");
	if (!theme) {
		console.error("--theme is required.\n");
		usage();
		process.exit(1);
	}

	const date = argString(args, "date") || today();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		console.error(`--date must be YYYY-MM-DD, got "${date}"`);
		process.exit(1);
	}

	const artifact = argString(args, "artifact");
	const commit = argString(args, "commit");
	if (!artifact && !commit) {
		console.error("Record at least one of --artifact or --commit: a mitigation nobody can find is not a mitigation.");
		process.exit(1);
	}

	const covers = argString(args, "covers")
		.split(",")
		.map((c) => c.trim())
		.filter(Boolean);

	const existing = loadMitigations();
	const record: Mitigation = {
		id: nextId(existing),
		theme,
		mitigated_at: date,
		...(artifact ? { artifact } : {}),
		...(commit ? { commit } : {}),
		...(argString(args, "note") ? { note: argString(args, "note") } : {}),
		...(covers.length > 0 ? { covers_entries: covers } : {}),
	};

	const line = JSON.stringify(record);

	if (args["dry-run"] === true) {
		console.log(line);
		console.log("[DRY RUN] Nothing appended.");
		return;
	}

	fs.mkdirSync(path.dirname(MITIGATIONS_PATH), { recursive: true });

	if (fs.existsSync(MITIGATIONS_PATH)) {
		const current = fs.readFileSync(MITIGATIONS_PATH, "utf-8");
		if (current.length > 0 && !current.endsWith("\n")) {
			fs.appendFileSync(MITIGATIONS_PATH, "\n", "utf-8");
		}
	}

	fs.appendFileSync(MITIGATIONS_PATH, `${line}\n`, "utf-8");

	const readBack = loadMitigations().find((m) => m.id === record.id);
	if (!readBack) {
		console.error("Write-back check FAILED: the record is not readable from the ledger.");
		process.exit(2);
	}

	console.log(`✓ ${record.id} recorded: ${record.theme}`);
	console.log(`  mitigated ${record.mitigated_at} → ${MITIGATIONS_PATH}`);
}

if (import.meta.main) {
	main();
}
