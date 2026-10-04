#!/usr/bin/env bun
/**
 * ============================================================================
 * MINEREFLECTIONS — Monthly algorithm reflection mining + email report
 * ============================================================================
 *
 * PURPOSE:
 * Analyzes MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl for recurring
 * themes, generates a markdown report, writes it to SYNTHESIS/, and emails the
 * report inline via Gmail SMTP.
 *
 * USAGE:
 *   bun MineReflections.ts                  # Analyze + email report
 *   bun MineReflections.ts --dry-run        # Analyze only, no email, stdout
 *   bun MineReflections.ts --no-email       # Analyze + write file, skip email
 *   bun MineReflections.ts --no-llm         # Stats only, skip LLM analysis
 *   bun MineReflections.ts --since 2026-07  # Only analyze entries since date
 *   bun MineReflections.ts --health-check   # Dead man's switch: did this month run?
 *
 * SCHEDULED:
 *   Monthly via cron: 0 9 1 * * bun ~/.opencode/PAI/Tools/MineReflections.ts
 *   Health check:     0 9 2 * * bun ~/.opencode/PAI/Tools/MineReflections.ts --health-check
 *
 * SCHEMA NORMALIZATION:
 * The log has accumulated four shapes over time: canonical v3.7.0 entries,
 * short-form rows (ts/task/q1_self), incident records written by other
 * runtimes, and the original 2026-07 form. readReflections() flattens all of
 * them into one NormalizedEntry, so the analysis sees the whole dataset rather
 * than the canonical subset. Teach new field names to FIELD_ALIASES below —
 * nothing downstream should ever learn about a second shape.
 *
 * ENVIRONMENT (.env):
 *   GMAIL_USER=you@gmail.com            # Sender/recipient email
 *   GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx   # Gmail app password
 *
 * ============================================================================
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import * as nodemailer from "nodemailer";
import { getDAName } from "../../pai-core/lib/identity";
import { inference } from "./Inference";

// ─── Configuration ───────────────────────────────────────────────────────────

const PAI_DIR =
	process.env.PAI_DIR || path.join(homedir(), ".opencode");

const REFLECTIONS_PATH = path.join(
	PAI_DIR,
	"MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl",
);

const SYNTHESIS_DIR = path.join(PAI_DIR, "MEMORY/LEARNING/SYNTHESIS");

// Analyse kjøres via PAI Inference.ts (Claude Opus 5, level smart) — se runAnalysis.

type EntryKind = "reflection" | "incident";
type Signal = "HIGH" | "MEDIUM" | "LOW";
type RawEntry = Record<string, unknown>;

/**
 * One reflection, flattened to a single shape regardless of the schema its
 * source line used. Optional fields stay undefined when the source did not
 * record them — never defaulted to a passing value, since that used to make
 * unparsed entries look like flawless runs.
 */
interface NormalizedEntry {
	id: number;
	timestamp: string;
	kind: EntryKind;
	task: string;
	effort: string;
	sentiment?: number;
	severity?: string;
	within_budget?: boolean;
	criteria_failed?: number;
	rework_count?: number;
	q1: string;
	q2: string;
	q3: string;
	signal: Signal;
	signal_reason: string;
}

interface LoadMeta {
	schemaCounts: Record<string, number>;
	malformed: number;
	contentless: number;
}


/**
 * A theme that has already been acted on.
 *
 * The ledger is append-only and the reflections log is never trimmed, because
 * the most valuable thing the data can say is that a fix did NOT hold. Deleting
 * mined entries would destroy exactly that signal.
 */
export interface Mitigation {
	id: string;
	theme: string;
	mitigated_at: string;
	artifact?: string;
	commit?: string;
	note?: string;
	covers_entries?: string[];
}

export const MITIGATIONS_PATH = path.join(
	PAI_DIR,
	"MEMORY/LEARNING/MITIGATIONS/mitigations.jsonl",
);

export function loadMitigations(): Mitigation[] {
	if (!fs.existsSync(MITIGATIONS_PATH)) return [];

	const records: Mitigation[] = [];
	for (const line of fs.readFileSync(MITIGATIONS_PATH, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line) as Mitigation;
			if (record.id && record.theme && record.mitigated_at) {
				records.push(record);
			} else {
				console.error(`Mitigation missing id/theme/mitigated_at, skipped: ${line.slice(0, 80)}`);
			}
		} catch {
			console.error(`Malformed mitigation line, skipped: ${line.slice(0, 80)}`);
		}
	}
	return records;
}

type CandidateStatus = "regression" | "new" | "addressed";



interface ThemeCandidate {
	theme: string;
	frequency: number;
	signal: "HIGH" | "MEDIUM" | "LOW";
	supporting: string[];
	root_cause: string;
	proposed_fix: string;
	target: string;
	effort: string;
	/** Set by the model: which ledger entry already covers this theme. */
	mitigation_id?: string | null;
}

/** A candidate after the dates have been compared against its mitigation. */
interface ClassifiedCandidate extends ThemeCandidate {
	status: CandidateStatus;
	mitigation?: Mitigation;
	entries_after_fix: string[];
}

interface MiningReport {
	entries_analyzed: number;
	date_range: string;
	high_signal_count: number;
	incident_count: number;
	over_budget_count: number;
	failed_criteria_count: number;
	rework_count_total: number;
	avg_sentiment: number;
	sentiment_coverage: number;
	schema_counts: Record<string, number>;
	malformed_lines: number;
	contentless_entries: number;
	mitigations_loaded: number;
	upgrade_candidates: ClassifiedCandidate[];
	q1_warnings: string[];
	q3_insights: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadEnv(): void {
	const envPath = path.join(PAI_DIR, ".env");
	if (!fs.existsSync(envPath)) return;
	const content = fs.readFileSync(envPath, "utf-8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx <= 0) continue;
		const key = trimmed.substring(0, eqIdx).trim();
		const val = trimmed.substring(eqIdx + 1).trim();
		if (!process.env[key]) process.env[key] = val;
	}
}

// Field aliases, newest schema first. Every name the log has ever used lives
// here; a new writer shape means one more alias, not a second code path.
const FIELD_ALIASES = {
	timestamp: ["timestamp", "ts", "date"],
	task: ["task_description", "task", "title", "session"],
	effort: ["effort_level", "effort"],
	q1: ["reflection_q1", "q1_self", "q1"],
	q2: ["reflection_q2", "q2_algorithm", "q2"],
	q3: ["reflection_q3", "q3_ai", "q3"],
} as const;

function pickString(raw: RawEntry, keys: readonly string[]): string {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function pickNumber(raw: RawEntry, key: string): number | undefined {
	const value = raw[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function detectSchema(raw: RawEntry): string {
	if (typeof raw.incident === "string") return "incident";
	if (typeof raw.reflection_q1 === "string") return "canonical";
	if (typeof raw.q1_self === "string" || typeof raw.q1 === "string") return "short-form";
	return "unrecognized";
}

/** Incident rows carry severity where reflections carry sentiment. */
function severityToSignal(severity: string): Signal {
	const s = severity.toLowerCase();
	if (s === "critical" || s === "high") return "HIGH";
	if (s === "medium") return "MEDIUM";
	return "LOW";
}

/**
 * Signal strength is decided here, deterministically, so the model never has to
 * apply the rules itself — it just reads the label off the entry.
 */
function classifySignal(
	entry: Omit<NormalizedEntry, "signal" | "signal_reason">,
): { signal: Signal; reason: string } {
	const ladder: Signal[] = ["LOW", "MEDIUM", "HIGH"];
	let base: Signal;
	let reason: string;

	if (entry.severity) {
		base = severityToSignal(entry.severity);
		reason = `severity ${entry.severity}`;
	} else if (entry.sentiment !== undefined) {
		base = entry.sentiment <= 5 ? "HIGH" : entry.sentiment <= 7 ? "MEDIUM" : "LOW";
		reason = `sentiment ${entry.sentiment}/10`;
	} else {
		base = "LOW";
		reason = "no sentiment or severity recorded";
	}

	const boosts: string[] = [];
	if (entry.within_budget === false) boosts.push("over budget");
	if ((entry.criteria_failed ?? 0) > 0) boosts.push(`${entry.criteria_failed} failed criteria`);
	if ((entry.rework_count ?? 0) > 0) boosts.push(`${entry.rework_count} rework`);

	if (boosts.length === 0) return { signal: base, reason };

	const bumped = ladder[Math.min(ladder.indexOf(base) + 1, ladder.length - 1)];
	return { signal: bumped, reason: `${reason}; ${boosts.join(", ")} -> boosted` };
}

function normalizeEntry(raw: RawEntry, id: number): NormalizedEntry {
	const isIncident = detectSchema(raw) === "incident";

	// Incidents have no q1/q2/q3, but they carry the same three axes under
	// other names. Map them onto the shared shape: what went wrong, why it
	// happened plus the lesson, and nothing aspirational.
	const q1 = isIncident ? String(raw.incident ?? "") : pickString(raw, FIELD_ALIASES.q1);
	const q2 = isIncident
		? [
			  raw.root_cause ? `Root cause: ${raw.root_cause}` : "",
			  raw.lesson ? `Lesson: ${raw.lesson}` : "",
		  ]
			  .filter(Boolean)
			  .join(" ")
		: pickString(raw, FIELD_ALIASES.q2);
	const q3 = isIncident ? "" : pickString(raw, FIELD_ALIASES.q3);

	const base = {
		id,
		timestamp: pickString(raw, FIELD_ALIASES.timestamp),
		kind: (isIncident ? "incident" : "reflection") as EntryKind,
		task: pickString(raw, FIELD_ALIASES.task) || "unknown",
		effort: pickString(raw, FIELD_ALIASES.effort),
		sentiment: pickNumber(raw, "implied_sentiment"),
		severity: typeof raw.severity === "string" ? raw.severity : undefined,
		within_budget: typeof raw.within_budget === "boolean" ? raw.within_budget : undefined,
		criteria_failed: pickNumber(raw, "criteria_failed"),
		rework_count: pickNumber(raw, "rework_count"),
		q1,
		q2,
		q3,
	};

	const { signal, reason } = classifySignal(base);
	return { ...base, signal, signal_reason: reason };
}

function readReflections(since?: string): { entries: NormalizedEntry[]; meta: LoadMeta } {
	const meta: LoadMeta = { schemaCounts: {}, malformed: 0, contentless: 0 };
	if (!fs.existsSync(REFLECTIONS_PATH)) return { entries: [], meta };

	const lines = fs
		.readFileSync(REFLECTIONS_PATH, "utf-8")
		.split("\n")
		.filter((l) => l.trim());

	const entries: NormalizedEntry[] = [];
	for (const line of lines) {
		let raw: RawEntry;
		try {
			raw = JSON.parse(line) as RawEntry;
		} catch {
			meta.malformed++;
			continue;
		}

		const schema = detectSchema(raw);
		meta.schemaCounts[schema] = (meta.schemaCounts[schema] ?? 0) + 1;

		const entry = normalizeEntry(raw, entries.length + 1);

		// Older entries are filtered out by --since; entries with no timestamp
		// at all are kept rather than silently dropped.
		if (since && entry.timestamp && entry.timestamp < since) continue;

		if (!entry.q1 && !entry.q2 && !entry.q3) {
			meta.contentless++;
			continue;
		}

		entries.push(entry);
	}

	return { entries, meta };
}

function truncate(str: string, max: number): string {
	return str.length <= max ? str : `${str.slice(0, max - 3)}...`;
}

function computeStats(entries: NormalizedEntry[]) {
	const sentiments = entries
		.map((e) => e.sentiment)
		.filter((s): s is number => s !== undefined);
	const avgSentiment =
		sentiments.length > 0
			? Math.round((sentiments.reduce((a, b) => a + b, 0) / sentiments.length) * 10) / 10
			: 0;

	return {
		highSignal: entries.filter((e) => e.signal === "HIGH").length,
		overBudget: entries.filter((e) => e.within_budget === false).length,
		failedCriteria: entries.filter((e) => (e.criteria_failed ?? 0) > 0).length,
		reworkTotal: entries.reduce((sum, e) => sum + (e.rework_count ?? 0), 0),
		avgSentiment,
		sentimentCoverage: sentiments.length,
		incidents: entries.filter((e) => e.kind === "incident").length,
	};
}

function formatSchemaCounts(counts: Record<string, number>): string {
	const parts = Object.entries(counts).map(([name, n]) => `${name}=${n}`);
	return parts.length > 0 ? parts.join(", ") : "none";
}

/** Everything in a report except the LLM's findings. */
function buildReportBase(
	entries: NormalizedEntry[],
	meta: LoadMeta,
	mitigations: Mitigation[] = [],
): Omit<MiningReport, "upgrade_candidates" | "q1_warnings" | "q3_insights"> {
	const stats = computeStats(entries);
	const timestamps = entries.map((e) => e.timestamp).filter(Boolean).sort();

	return {
		entries_analyzed: entries.length,
		date_range:
			timestamps.length > 0
				? `${timestamps[0].slice(0, 16)} -> ${timestamps[timestamps.length - 1].slice(0, 16)}`
				: "unknown",
		high_signal_count: stats.highSignal,
		incident_count: stats.incidents,
		over_budget_count: stats.overBudget,
		failed_criteria_count: stats.failedCriteria,
		rework_count_total: stats.reworkTotal,
		avg_sentiment: stats.avgSentiment,
		sentiment_coverage: stats.sentimentCoverage,
		schema_counts: meta.schemaCounts,
		malformed_lines: meta.malformed,
		contentless_entries: meta.contentless,
		mitigations_loaded: mitigations.length,
	};
}

// ─── Mitigation classification ───────────────────────────────────────────────

function formatMitigationsForPrompt(mitigations: Mitigation[]): string {
	if (mitigations.length === 0) return "(none recorded yet)";
	return mitigations
		.map(
			(m) =>
				`${m.id} | fixed ${m.mitigated_at} | ${m.theme}${m.artifact ? ` | see ${m.artifact}` : ""}`,
		)
		.join("\n");
}

/** "ENTRY 14: quote fragment" -> 14 */
function citedEntryIds(supporting: string[]): number[] {
	const ids: number[] = [];
	for (const item of supporting ?? []) {
		const match = /ENTRY\s+(\d+)/i.exec(item);
		if (match) ids.push(Number(match[1]));
	}
	return ids;
}

/**
 * The model says which mitigation a theme belongs to; the dates decide what
 * that means. Evidence postdating its own fix is a regression, and a fix that
 * did not hold outranks a problem nobody has tried to solve yet.
 */
function classifyCandidates(
	candidates: ThemeCandidate[],
	entries: NormalizedEntry[],
	mitigations: Mitigation[],
): ClassifiedCandidate[] {
	const entryById = new Map(entries.map((e) => [e.id, e]));
	const ledger = new Map(mitigations.map((m) => [m.id.toUpperCase(), m]));

	return candidates.map((candidate) => {
		const mitigation = candidate.mitigation_id
			? ledger.get(String(candidate.mitigation_id).toUpperCase())
			: undefined;

		// An unknown id means the model invented one — treat the theme as new
		// rather than quietly filing it as handled.
		if (!mitigation) {
			return { ...candidate, status: "new" as const, entries_after_fix: [] };
		}

		const fixedOn = mitigation.mitigated_at.slice(0, 10);
		const afterFix = citedEntryIds(candidate.supporting)
			.map((id) => entryById.get(id))
			.filter((e): e is NormalizedEntry => Boolean(e?.timestamp))
			.filter((e) => e.timestamp.slice(0, 10) > fixedOn)
			.map((e) => `ENTRY ${e.id} (${e.timestamp.slice(0, 10)}): ${e.task}`);

		if (afterFix.length > 0) {
			return {
				...candidate,
				signal: "HIGH" as const,
				status: "regression" as const,
				mitigation,
				entries_after_fix: afterFix,
			};
		}

		return {
			...candidate,
			status: "addressed" as const,
			mitigation,
			entries_after_fix: [],
		};
	});
}

// ─── LLM Analysis ────────────────────────────────────────────────────────────

/**
 * One entry, rendered as a fixed block of labelled lines. Same fields, same
 * order, every time, with "not-recorded" spelled out rather than omitted — a
 * small model should not have to guess why a key is missing.
 */
function renderEntry(e: NormalizedEntry): string {
	const metrics = [
		e.sentiment !== undefined ? `sentiment=${e.sentiment}/10` : "sentiment=not-recorded",
		e.severity ? `severity=${e.severity}` : "severity=not-applicable",
		e.within_budget === undefined ? "budget=not-recorded" : `budget=${e.within_budget ? "ok" : "OVER"}`,
		e.criteria_failed === undefined
			? "failed_criteria=not-recorded"
			: `failed_criteria=${e.criteria_failed}`,
		e.rework_count === undefined ? "rework=not-recorded" : `rework=${e.rework_count}`,
	].join(", ");

	return [
		`--- ENTRY ${e.id} ---`,
		`id: ${e.id}`,
		`date: ${e.timestamp || "not-recorded"}`,
		`kind: ${e.kind}`,
		`signal: ${e.signal} (${e.signal_reason})`,
		`task: ${e.task}`,
		`effort: ${e.effort || "not-recorded"}`,
		`metrics: ${metrics}`,
		`q1_what_i_should_have_done_differently: ${truncate(e.q1, 500) || "(none)"}`,
		`q2_what_a_smarter_algorithm_would_do: ${truncate(e.q2, 700) || "(none)"}`,
		`q3_what_a_smarter_ai_would_do: ${truncate(e.q3, 500) || "(none)"}`,
	].join("\n");
}

function buildAnalysisPrompt(
	entries: NormalizedEntry[],
	mitigations: Mitigation[],
): string {
	const blocks = entries.map(renderEntry).join("\n\n");

	return `You are analyzing ${entries.length} reflection entries from the LEARN phase of a personal AI system (PAI).

HOW TO READ AN ENTRY
Every entry below has exactly the same fields, in the same order:
  id      - the number you cite in your evidence
  date    - when it happened
  kind    - "reflection" (a normal session) or "incident" (something broke)
  signal  - HIGH, MEDIUM or LOW. Already computed. Do not recompute it.
  task    - what was being done
  effort  - how large the task was
  metrics - sentiment, severity, budget, failed criteria, rework
  q1      - what the AI should have done differently (execution mistakes)
  q2      - what a smarter algorithm would have done (structural fixes) <-- MOST IMPORTANT
  q3      - what a fundamentally smarter AI would have done (aspirational)

When kind is "incident": q1 is what went wrong, q2 holds the root cause and the
lesson learned, and q3 is empty.
"not-recorded" means the source entry did not contain that field. It does not mean zero.

ENTRIES
${blocks}

ALREADY MITIGATED
These themes have already been acted on. Each line is: id | date fixed | theme.
${formatMitigationsForPrompt(mitigations)}

YOUR TASK
Group the q2 answers into recurring themes. For each theme, name the structural
root cause and propose one concrete fix.

RULES
1. Include a theme only if it appears in 2 or more entries. One entry is enough
   if that entry has signal HIGH.
2. Merge themes that mean the same thing. Never output two themes that overlap.
3. Copy quotes verbatim from the entries above. Never paraphrase a quote.
4. Every item in "supporting" must begin with "ENTRY <id>: " using an id that
   actually appears above.
5. Sort themes by frequency, highest first, then by signal.
6. If you find no recurring themes, return empty arrays.
7. Set "mitigation_id" to the id from ALREADY MITIGATED that covers the theme,
   or null when none does. Report the theme either way — never drop a theme
   because it was mitigated, and never mark one mitigated to make it go away.
   Whether the fix held is decided from the entry dates, not by you.

OUTPUT
Return only the JSON object below. No markdown, no code fences, no explanation.
{
  "upgrade_candidates": [
	{
	  "theme": "short name, 5 to 8 words",
	  "frequency": 3,
	  "signal": "HIGH",
	  "supporting": ["ENTRY 7: verbatim quote fragment"],
	  "root_cause": "the structural issue behind this pattern",
	  "proposed_fix": "a specific change to the algorithm, a skill, or the system",
	  "target": "which PAI files would change",
	  "effort": "Standard",
	  "mitigation_id": null
	}
  ],
  "q1_warnings": ["one recurring execution mistake, one sentence"],
  "q3_insights": ["one aspirational improvement idea, one sentence"]
}

"signal" must be exactly one of: HIGH, MEDIUM, LOW.
"effort" must be exactly one of: Instant, Fast, Standard, Extended.
"mitigation_id" must be an id from ALREADY MITIGATED, or null.
"frequency" must be a number.`;
}

async function runAnalysis(
	entries: NormalizedEntry[],
	meta: LoadMeta,
	mitigations: Mitigation[],
): Promise<MiningReport | null> {
	if (entries.length === 0) return null;

	const prompt = buildAnalysisPrompt(entries, mitigations);
	const systemPrompt =
		"You are a systems analyst mining algorithm performance reflections for recurring patterns. You identify structural issues, cluster themes, and propose concrete fixes. Output only valid JSON.";

	console.log("Calling Claude Opus 5 via Inference.ts (level smart)...");

	const result = await inference({
		systemPrompt,
		userPrompt: prompt,
		level: "smart",
		timeout: 120_000,
	});

	if (!result.success) {
		console.error(`Inference failed: ${result.error ?? "unknown error"}`);
		return null;
	}

	const responseText = result.output;

	// Parse JSON from response (same logic as Inference.ts)
	let parsed: Record<string, unknown> | null = null;
	const objectMatch = responseText.match(/\{[\s\S]*\}/);
	const arrayMatch = responseText.match(/\[[\s\S]*\]/);

	for (const candidate of [objectMatch?.[0], arrayMatch?.[0]]) {
		if (!candidate) continue;
		try {
			parsed = JSON.parse(candidate) as Record<string, unknown>;
			break;
		} catch {
			/* try next */
		}
	}

	if (!parsed) {
		console.error("Failed to parse JSON from inference response");
		console.error("Raw response (first 1000 chars):", responseText.slice(0, 1000));
		return null;
	}

	return {
		...buildReportBase(entries, meta, mitigations),
		upgrade_candidates: classifyCandidates(
			(parsed.upgrade_candidates as ThemeCandidate[]) || [],
			entries,
			mitigations,
		),
		q1_warnings: (parsed.q1_warnings as string[]) || [],
		q3_insights: (parsed.q3_insights as string[]) || [],
	};
}

// ─── Report Generation ───────────────────────────────────────────────────────

function renderCandidates(candidates: ClassifiedCandidate[]): string {
	let md = "";

	candidates.forEach((c, index) => {
		md += `### ${index + 1}. ${c.theme} (${c.frequency}×, ${c.signal})\n`;

		if (c.status === "regression" && c.mitigation) {
			const source = [c.mitigation.id, c.mitigation.artifact, c.mitigation.commit]
				.filter(Boolean)
				.join(", ");
			md += `- **Regression:** mitigated ${c.mitigation.mitigated_at} (${source}) — and it happened again after that:\n`;
			for (const entry of c.entries_after_fix) md += `  - ${entry}\n`;
		}

		md += `- **Root cause:** ${c.root_cause}\n`;
		md += `- **Proposed fix:** ${c.proposed_fix}\n`;
		md += `- **Target files:** ${c.target}\n`;
		md += `- **Effort:** ${c.effort}\n`;
		md += `- **Evidence:**\n`;
		for (const s of c.supporting) md += `  - ${s}\n`;
		md += "\n";
	});

	return md;
}

function generateMarkdown(report: MiningReport): string {
	const now = new Date().toISOString().slice(0, 10);
	const dataIssues = [
		report.malformed_lines > 0 ? `${report.malformed_lines} malformed line(s)` : "",
		report.contentless_entries > 0
			? `${report.contentless_entries} entry/entries without reflection text`
			: "",
		report.schema_counts.unrecognized
			? `${report.schema_counts.unrecognized} unrecognized schema(s)`
			: "",
	].filter(Boolean);

	let md = `# PAI Reflection Mining Report — ${now}

**Entries analyzed:** ${report.entries_analyzed}
**Date range:** ${report.date_range}
**Average sentiment:** ${report.avg_sentiment}/10 (recorded for ${report.sentiment_coverage} of ${report.entries_analyzed} entries)

**Stats:** ${report.high_signal_count} high-signal · ${report.incident_count} incidents · ${report.over_budget_count} over-budget · ${report.failed_criteria_count} with failed criteria · ${report.rework_count_total} total reworks

**Mitigations on record:** ${report.mitigations_loaded}

**Source schemas:** ${formatSchemaCounts(report.schema_counts)}${dataIssues.length > 0 ? ` · ⚠️ ${dataIssues.join(" · ")}` : ""}

---

`;

	if (report.upgrade_candidates.length === 0) {
		md += `## No significant patterns detected

No recurring themes met the threshold (2+ occurrences) this period. Individual reflections are stored in \`MEMORY/LEARNING/REFLECTIONS/\`.

`;
	} else {
		const regressions = report.upgrade_candidates.filter((c) => c.status === "regression");
		const fresh = report.upgrade_candidates.filter((c) => c.status === "new");
		const addressed = report.upgrade_candidates.filter((c) => c.status === "addressed");

		if (regressions.length > 0) {
			md += `## ⚠️ Regressions — fixes that did not hold\n\n`;
			md += `These themes were already mitigated, and the evidence below is dated **after** the fix. A fix that did not hold outranks a problem nobody has tried to solve yet.\n\n`;
			md += renderCandidates(regressions);
		}

		if (fresh.length > 0) {
			md += `## Top Upgrade Candidates\n\n`;
			md += renderCandidates(fresh);
		}

		if (addressed.length > 0) {
			md += `## Already Addressed\n\n`;
			md += `Still recurring in the log, but every supporting entry predates its fix. Listed so the pattern stays visible without competing for attention.\n\n`;
			for (const c of addressed) {
				const m = c.mitigation;
				const source = [m?.id, m?.artifact, m?.commit].filter(Boolean).join(", ");
				md += `- **${c.theme}** (${c.frequency}×) — mitigated ${m?.mitigated_at} (${source})\n`;
			}
			md += "\n";
		}
	}

	if (report.q1_warnings.length > 0) {
		md += `## Execution Pattern Warnings (Q1)\n\n`;
		for (const w of report.q1_warnings) {
			md += `- ${w}\n`;
		}
		md += "\n";
	}

	if (report.q3_insights.length > 0) {
		md += `## Aspirational Insights (Q3)\n\n`;
		for (const w of report.q3_insights) {
			md += `- ${w}\n`;
		}
		md += "\n";
	}

	const regressionCount = report.upgrade_candidates.filter(
		(c) => c.status === "regression",
	).length;

	md += `## Next Steps\n\n`;
	if (regressionCount > 0) {
		md += `- **Regressions first.** The fix already exists and did not hold — strengthen the mechanism rather than writing another rule beside it\n`;
	}
	md += `- Review upgrade candidates and prioritize implementation\n`;
	md += `- Run \`algorithm upgrade\` to generate targeted Algorithm spec changes\n`;
	md += `- Record every fix: \`bun PAI/Tools/RecordMitigation.ts --theme "..." --commit <sha>\`\n`;
	md += `- **Never trim the reflections log.** A deleted entry cannot prove a regression\n`;

	return md;
}

function writeReport(markdown: string): string {
	if (!fs.existsSync(SYNTHESIS_DIR)) {
		fs.mkdirSync(SYNTHESIS_DIR, { recursive: true });
	}
	const now = new Date();
	const slug = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
	const filename = `reflection-patterns-${slug}.md`;
	const filepath = path.join(SYNTHESIS_DIR, filename);
	fs.writeFileSync(filepath, markdown, "utf-8");
	return filepath;
}

// ─── Email ───────────────────────────────────────────────────────────────────

async function sendEmail(
	report: MiningReport,
	markdown: string,
): Promise<boolean> {
	const gmailUser = process.env.GMAIL_USER;
	const gmailPass = process.env.GMAIL_APP_PASSWORD;

	const recipient = process.env.REPORT_RECIPIENT || gmailUser;

	if (!gmailUser || !gmailPass) {
		console.error(
			"Missing GMAIL_USER or GMAIL_APP_PASSWORD in environment. Skipping email.",
		);
		return false;
	}

	if (!recipient) {
		console.error(
			"No recipient — set REPORT_RECIPIENT or GMAIL_USER. Skipping email.",
		);
		return false;
	}

	const transporter = nodemailer.createTransport({
		host: "smtp.gmail.com",
		port: 587,
		secure: false,
		auth: {
			user: gmailUser,
			pass: gmailPass,
		},
	});

	const regressions = report.upgrade_candidates.filter((c) => c.status === "regression").length;
	const fresh = report.upgrade_candidates.filter((c) => c.status === "new").length;

	let subject: string;
	if (regressions > 0) {
		subject = `PAI Reflections — ${regressions} REGRESSION${regressions > 1 ? "S" : ""}, ${fresh} new candidate${fresh === 1 ? "" : "s"} (${report.entries_analyzed} entries)`;
	} else if (fresh > 0) {
		subject = `PAI Reflections — ${fresh} upgrade candidate${fresh > 1 ? "s" : ""} found (${report.entries_analyzed} entries)`;
	} else {
		subject = `PAI Reflections — no new patterns detected (${report.entries_analyzed} entries)`;
	}

	// Convert markdown to simple HTML for email
	const html = markdown
		.replace(/^### (.+)$/gm, '<h3 style="margin-top:20px">$1</h3>')
		.replace(/^## (.+)$/gm, '<h2 style="margin-top:24px">$1</h2>')
		.replace(/^# (.+)$/gm, '<h2 style="margin-top:24px">$1</h2>')
		.replace(/^- (.+)$/gm, '<li style="margin-left:16px">$1</li>')
		.replace(/^\*\*(.+?)\*\*/gm, "<strong>$1</strong>")
		.replace(/\n\n/g, "<br><br>")
		.replace(/\n/g, "<br>");

	const info = await transporter.sendMail({
		from: `"${getDAName()}" <${gmailUser}>`,
		to: recipient,
		subject,
		html: `<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 700px;">${html}</div>`,
	});

	console.log(`Email sent: ${info.messageId}`);
	return true;
}

// ─── Failure escalation ──────────────────────────────────────────────────────

/**
 * The September run died on a Fireworks 404 and nobody noticed for 19 days,
 * because cron's only output went to a log file nobody reads. A failed run now
 * escalates through the same channel a successful one reports through.
 */
async function reportFailure(
	error: unknown,
	subject = "PAI Reflections — mining run FAILED",
): Promise<void> {
	try {
		loadEnv();
		const gmailUser = process.env.GMAIL_USER;
		const gmailPass = process.env.GMAIL_APP_PASSWORD;
		const recipient = process.env.REPORT_RECIPIENT || gmailUser;

		if (!gmailUser || !gmailPass || !recipient) {
			console.error("No mail credentials — failure could not be escalated.");
			return;
		}

		const transporter = nodemailer.createTransport({
			host: "smtp.gmail.com",
			port: 587,
			secure: false,
			auth: { user: gmailUser, pass: gmailPass },
		});

		const detail =
			error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error);

		await transporter.sendMail({
			from: `"${getDAName()}" <${gmailUser}>`,
			to: recipient,
			subject,
			text: [
				`MineReflections failed at ${new Date().toISOString()}.`,
				"",
				detail,
				"",
				`PAI_DIR:     ${PAI_DIR}`,
				`Reflections: ${REFLECTIONS_PATH}`,
			].join("\n"),
		});

		console.error("Failure notification sent.");
	} catch (notifyError) {
		console.error("Could not send failure notification:", notifyError);
	}
}

/**
 * Dead man's switch, scheduled a day after the mining job: if this month has no
 * report, the run either never happened or died before writing one.
 */
async function runHealthCheck(): Promise<void> {
	const now = new Date();
	const slug = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
	const expected = path.join(SYNTHESIS_DIR, `reflection-patterns-${slug}.md`);

	if (fs.existsSync(expected)) {
		console.log(`✓ Mining report present for ${slug}: ${expected}`);
		return;
	}

	console.error(`MISSING: no mining report for ${slug} at ${expected}`);
	await reportFailure(
		new Error(`No reflection mining report exists for ${slug}. The monthly run did not produce ${expected}.`),
		"PAI Reflections — monthly report MISSING",
	);
	process.exit(1);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	loadEnv();

	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const noEmail = args.includes("--no-email");
	const noLlm = args.includes("--no-llm");
	const sinceIdx = args.indexOf("--since");
	const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;

	if (args.includes("--health-check")) {
		await runHealthCheck();
		return;
	}

	console.log("═══ MineReflections — Internal Reflection Mining ═══");
	console.log(`PAI_DIR: ${PAI_DIR}`);
	console.log(`Reflections: ${REFLECTIONS_PATH}`);

	// Read reflections
	const { entries, meta } = readReflections(since);
	const mitigations = loadMitigations();
	console.log(`Entries loaded: ${entries.length}`);
	console.log(`Mitigations on record: ${mitigations.length}`);
	console.log(`Source schemas: ${formatSchemaCounts(meta.schemaCounts)}`);

	// A silent miss here is what let 17 of 29 entries go unread for months.
	if (meta.malformed > 0) {
		console.error(`WARNING: ${meta.malformed} malformed JSONL line(s) skipped — the log has corrupt entries.`);
	}
	if (meta.contentless > 0) {
		console.error(`WARNING: ${meta.contentless} entry/entries carried no reflection text and were excluded.`);
	}
	if (meta.schemaCounts.unrecognized) {
		console.error(`WARNING: ${meta.schemaCounts.unrecognized} entry/entries matched no known schema — add their field names to FIELD_ALIASES.`);
	}

	const emptyFindings = { upgrade_candidates: [], q1_warnings: [], q3_insights: [] };

	if (entries.length === 0) {
		console.log("No reflections found. Nothing to analyze.");
		if (!dryRun && !noEmail) {
			await sendEmail(
				{ ...buildReportBase([], meta, mitigations), ...emptyFindings },
				"# PAI Reflection Mining Report\n\nNo reflections found this period. Run some Standard+ tasks to generate reflections.\n",
			);
		}
		process.exit(0);
	}

	if (entries.length < 2) {
		console.log(
			`Only ${entries.length} entry — minimum 2 required for pattern analysis. Skipping LLM analysis.`,
		);
		const report: MiningReport = {
			...buildReportBase(entries, meta, mitigations),
			...emptyFindings,
		};
		const md = generateMarkdown(report);
		if (dryRun) {
			console.log(`\n${md}`);
		} else {
			const filepath = writeReport(md);
			console.log(`Report written: ${filepath}`);
			if (!noEmail) await sendEmail(report, md);
		}
		process.exit(0);
	}

	// LLM analysis
	let report: MiningReport | null = null;
	if (noLlm) {
		console.log("LLM analysis skipped (--no-llm). Generating stats-only report.");
		report = { ...buildReportBase(entries, meta, mitigations), ...emptyFindings };
	} else {
		console.log("Running LLM pattern analysis (Claude Opus 5 via Inference.ts, 2m timeout)...");
		report = await runAnalysis(entries, meta, mitigations);
	}

	// Thrown, not exited: this is the exact failure that went unnoticed for 19
	// days, so it has to reach reportFailure() rather than end the process here.
	if (!report) {
		throw new Error("LLM pattern analysis produced no report — see the inference error above.");
	}

	// Generate markdown
	const markdown = generateMarkdown(report);

	if (dryRun) {
		console.log(`\n${markdown}`);
		console.log("\n[DRY RUN] No file written, no email sent.");
	} else {
		const filepath = writeReport(markdown);
		console.log(`Report written: ${filepath}`);
		if (!noEmail) {
			await sendEmail(report, markdown);
		} else {
			console.log("Email skipped (--no-email)");
		}
	}
}

if (import.meta.main) {
	main().catch(async (err) => {
		console.error("Fatal error:", err);
		await reportFailure(err);
		process.exit(1);
	});
}
