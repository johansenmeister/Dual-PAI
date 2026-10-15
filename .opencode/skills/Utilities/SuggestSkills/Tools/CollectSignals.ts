#!/usr/bin/env bun
/**
 * CollectSignals — deterministic, read-only signal collector for skill-gap discovery.
 *
 * Ported from danielmiessler/LifeOS v7.40.4 (MIT),
 * `LifeOS/install/skills/SuggestSkills/Tools/CollectSignals.ts` (itself from public PR #1798,
 * @rathko). Adapted to this tree:
 *
 *   - Work sessions are nested by month (`MEMORY/WORK/2026-10/<session>/`), and the date and
 *     title come from the directory name and `META.yaml`, not from mtime: the tree is synced
 *     with git, so mtime is the time of the last pull, not of the session.
 *   - Ratings come in two shapes: explicit (`score`, `comment`) and implicit (`rating`,
 *     `sentiment_summary`). Both count; `source` and `harness` are kept.
 *   - Skills sit one or two levels down (`Category/Skill/SKILL.md`), so the tree is walked.
 *   - The root is the PAI home: `--root`, else `PAI_HOME`, else the `.opencode` this file
 *     lives in. No per-store env vars and no loop catalog (this tree has none).
 *
 * Emits a normalized corpus (JSON to stdout) so the model only clusters and judges; it never
 * gathers. Over unchanged stores the output is deterministic (ordering is fully tie-broken).
 * Writes nothing. Anything missing or malformed is reported in `warnings`/`missing`, never
 * fatal: exit 0 even when stores are missing (a fresh install is a valid, empty corpus).
 *
 * Usage:
 *   bun CollectSignals.ts [--root <dir>] [--days <n>] [--max-rating <n>]
 *                         [--ratings <file>] [--work <dir>] [--skills <dir>]
 *
 * @module skills/Utilities/SuggestSkills/Tools/CollectSignals
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_RATINGS_BYTES = 10_000_000; // guard against a huge/FIFO ratings store
const MAX_NOTE_CHARS = 500;
const MAX_TITLE_CHARS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Session = { slug: string; date: string; title: string; harness: string };
export type Frustration = { date: string; rating: number; source: string; harness: string; note: string };
export type RegistryEntry = { kind: "skill" | "workflow"; name: string; path: string; description: string };
export type Corpus = {
	window: { days: number; since: string; maxRating: number };
	sessions: Session[];
	frustrations: Frustration[];
	registries: RegistryEntry[];
	warnings: string[];
	missing: string[];
	sources: Record<string, string>;
};

/** Value for `flag`, or undefined. A following token that is itself a flag is NOT a value. */
function arg(argv: string[], flag: string): string | undefined {
	const i = argv.indexOf(flag);
	if (i < 0 || i + 1 >= argv.length) return undefined;
	const v = argv[i + 1];
	return v.startsWith("-") ? undefined : v;
}

/** Strict integer flag, clamped to [min,max]; warns instead of silently accepting garbage. */
function intArg(argv: string[], flag: string, dflt: number, min: number, max: number, warnings: string[]): number {
	const v = arg(argv, flag);
	if (v === undefined) return dflt;
	if (!/^-?\d+$/.test(v)) {
		warnings.push(`${flag}: not an integer (${v}); using ${dflt}`);
		return dflt;
	}
	let n = Number.parseInt(v, 10);
	if (n < min) {
		warnings.push(`${flag}: ${n} below ${min}; clamped`);
		n = min;
	} else if (n > max) {
		warnings.push(`${flag}: ${n} above ${max}; clamped`);
		n = max;
	}
	return n;
}

/** Explicit path wins; one that does not exist is a warning and null, never a silent default. */
function resolveStore(explicit: string | undefined, fallback: string, label: string, warnings: string[]): string | null {
	if (explicit !== undefined) {
		if (existsSync(explicit)) return explicit;
		warnings.push(`${label}: --${label} path ${explicit} does not exist`);
		return null;
	}
	return existsSync(fallback) ? fallback : null;
}

function clean(s: string, max: number): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
	return s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

export function parseFrustrations(
	file: string | null,
	maxRating: number,
	since: Date,
	warnings: string[],
	missing: string[],
): Frustration[] {
	if (!file) {
		missing.push("ratings");
		return [];
	}
	let raw: string;
	try {
		const st = statSync(file);
		if (!st.isFile()) {
			warnings.push("ratings: not a regular file");
			return [];
		}
		if (st.size > MAX_RATINGS_BYTES) {
			warnings.push(`ratings: too large (${st.size} bytes), skipped`);
			return [];
		}
		raw = readFileSync(file, "utf8");
	} catch (e) {
		warnings.push(`ratings unreadable: ${(e as Error).message}`);
		return [];
	}

	const out: Frustration[] = [];
	let bad = 0;
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let r: Record<string, unknown>;
		try {
			r = JSON.parse(t) as Record<string, unknown>;
		} catch {
			bad++;
			continue;
		}
		// Implicit rows carry `rating`, explicit rows `score`.
		const value = typeof r.rating === "number" ? r.rating : typeof r.score === "number" ? r.score : Number.NaN;
		const ts = typeof r.timestamp === "string" ? r.timestamp : "";
		if (!Number.isFinite(value) || !ts) {
			bad++;
			continue;
		}
		if (value > maxRating) continue;
		const ms = new Date(ts).getTime();
		if (Number.isNaN(ms)) {
			bad++; // an unparseable timestamp is malformed, not "out of window"
			continue;
		}
		if (ms < since.getTime()) continue;
		const note = typeof r.sentiment_summary === "string" ? r.sentiment_summary : typeof r.comment === "string" ? r.comment : "";
		out.push({
			date: new Date(ms).toISOString().slice(0, 10),
			rating: value,
			source: typeof r.source === "string" ? r.source : "",
			harness: typeof r.harness === "string" ? r.harness : "",
			note: clean(note, MAX_NOTE_CHARS),
		});
	}
	if (bad > 0) warnings.push(`ratings: skipped ${bad} malformed/incomplete line(s)`);
	return out.sort(
		(a, b) => a.rating - b.rating || a.date.localeCompare(b.date) || a.note.localeCompare(b.note) || a.harness.localeCompare(b.harness),
	);
}

/** A top-level `META.yaml` scalar, unquoted. The file is flat key: value, so no YAML parser. */
function metaField(yaml: string, key: string): string {
	const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(yaml);
	if (!m) return "";
	const v = m[1].trim();
	if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) {
		return v.slice(1, -1).replace(/\\"/g, '"');
	}
	return v;
}

/** Session date: the name's timestamp prefix, else `started_at`, else none (left out). */
function sessionDate(slug: string, startedAt: string): string | null {
	const fromName = /^(\d{4}-\d{2}-\d{2})T/.exec(slug)?.[1];
	if (fromName) return fromName;
	const ms = startedAt ? new Date(startedAt).getTime() : Number.NaN;
	return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
}

export function collectSessions(dir: string | null, since: Date, warnings: string[], missing: string[]): Session[] {
	if (!dir) {
		missing.push("work-sessions");
		return [];
	}
	const sinceDay = since.toISOString().slice(0, 10);
	const candidates: string[] = [];
	const list = (d: string): string[] => {
		try {
			return readdirSync(d, { withFileTypes: true })
				.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
				.map((e) => e.name);
		} catch (e) {
			warnings.push(`work dir unreadable: ${(e as Error).message}`);
			return [];
		}
	};
	for (const name of list(dir)) {
		// Month buckets hold the sessions; anything else at the top is a session of its own.
		if (/^\d{4}-\d{2}$/.test(name)) for (const s of list(join(dir, name))) candidates.push(join(dir, name, s));
		else candidates.push(join(dir, name));
	}

	const out: Session[] = [];
	let undated = 0;
	for (const path of candidates) {
		const slug = basename(path);
		let meta = "";
		try {
			meta = readFileSync(join(path, "META.yaml"), "utf8");
		} catch {
			/* no META.yaml: fall back to the name */
		}
		const date = sessionDate(slug, metaField(meta, "started_at"));
		if (!date) {
			undated++;
			continue;
		}
		if (date < sinceDay) continue;
		out.push({
			slug,
			date,
			title: clean(metaField(meta, "title") || slug, MAX_TITLE_CHARS),
			harness: metaField(meta, "harness"),
		});
	}
	if (undated > 0) warnings.push(`work-sessions: skipped ${undated} dir(s) with no date in the name or META.yaml`);
	return out.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

/**
 * name + description from a SKILL.md's YAML frontmatter. Handles folded/block scalars
 * (`description: >` / `|`) by gathering the indented continuation lines. Null without `name:`.
 */
function readMeta(skillMd: string): { name: string; description: string } | null {
	let txt: string;
	try {
		txt = readFileSync(skillMd, "utf8");
	} catch {
		return null;
	}
	const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt);
	const block = fm ? fm[1] : txt;
	const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim();
	if (!name) return null;

	let desc =
		/^description:\s*(.+)$/m
			.exec(block)?.[1]
			?.trim()
			.replace(/^["']|["']$/g, "") ?? "";
	if (/^[>|][+-]?\d*$/.test(desc)) {
		const lines = block.split("\n");
		const di = lines.findIndex((l) => /^description:\s*[>|]/.test(l));
		const cont: string[] = [];
		for (let k = di + 1; k < lines.length; k++) {
			if (/^\s+\S/.test(lines[k])) cont.push(lines[k].trim());
			else break;
		}
		desc = cont.join(" ");
	}
	return { name, description: desc };
}

/** Every SKILL.md in the tree, with its `Workflows/*.md` as reusable coverage too. */
export function collectRegistries(skillsDir: string | null, warnings: string[], missing: string[]): RegistryEntry[] {
	if (!skillsDir) {
		missing.push("skills");
		return [];
	}
	const out: RegistryEntry[] = [];
	const walk = (d: string, depth: number): void => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch (e) {
			warnings.push(`skills dir unreadable: ${(e as Error).message}`);
			return;
		}
		if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
			const md = join(d, "SKILL.md");
			const meta = readMeta(md);
			if (!meta) warnings.push(`skills: ${relative(skillsDir, md)} unreadable or missing name:`);
			else {
				out.push({ kind: "skill", name: meta.name, path: relative(skillsDir, md), description: meta.description });
				const wf = join(d, "Workflows");
				if (existsSync(wf)) {
					try {
						for (const f of readdirSync(wf))
							if (f.endsWith(".md"))
								out.push({ kind: "workflow", name: `${meta.name}/${basename(f, ".md")}`, path: relative(skillsDir, join(wf, f)), description: "" });
					} catch {
						/* skip an unreadable Workflows dir */
					}
				}
			}
		}
		// Category/Skill is two levels; a third catches nothing real and keeps the walk cheap.
		if (depth >= 2) return;
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("_") || e.name === "node_modules") continue;
			if (e.name === "Workflows" || e.name === "Tools") continue;
			walk(join(d, e.name), depth + 1);
		}
	};
	walk(skillsDir, 0);
	return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/** The `.opencode` this file lives in: `<root>/skills/Utilities/SuggestSkills/Tools/`. */
function ownRoot(): string {
	return join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "..", "..", "..");
}

export function collect(argv: string[], now: Date = new Date()): Corpus {
	const warnings: string[] = [];
	const missing: string[] = [];

	const root = arg(argv, "--root") ?? (process.env.PAI_HOME?.trim() || ownRoot());
	const days = intArg(argv, "--days", 45, 1, 3650, warnings);
	const maxRating = intArg(argv, "--max-rating", 4, 1, 10, warnings);
	const since = new Date(now.getTime() - days * DAY_MS);

	const ratingsFile = resolveStore(arg(argv, "--ratings"), join(root, "MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl"), "ratings", warnings);
	const workDir = resolveStore(arg(argv, "--work"), join(root, "MEMORY", "WORK"), "work", warnings);
	const skillsDir = resolveStore(arg(argv, "--skills"), join(root, "skills"), "skills", warnings);

	return {
		window: { days, since: since.toISOString().slice(0, 10), maxRating },
		sessions: collectSessions(workDir, since, warnings, missing),
		frustrations: parseFrustrations(ratingsFile, maxRating, since, warnings, missing),
		registries: collectRegistries(skillsDir, warnings, missing),
		warnings,
		missing,
		sources: {
			root,
			ratings: ratingsFile ?? "(none)",
			work: workDir ?? "(none)",
			skills: skillsDir ?? "(none)",
		},
	};
}

const HELP = `CollectSignals — read-only signal collector for skill-gap discovery (writes nothing).

Usage:
  bun CollectSignals.ts [--root <dir>] [--days <n>] [--max-rating <n>]
                        [--ratings <file>] [--work <dir>] [--skills <dir>]

  --root <dir>        PAI home (default: $PAI_HOME, else the .opencode this tool lives in)
  --days <n>          lookback window, 1-3650 (default: 45)
  --max-rating <n>    highest rating still counted as frustration, 1-10 (default: 4)
  --ratings <file>    ratings JSONL (default: <root>/MEMORY/LEARNING/SIGNALS/ratings.jsonl)
  --work <dir>        work sessions (default: <root>/MEMORY/WORK)
  --skills <dir>      skills tree (default: <root>/skills)

Emits the corpus JSON on stdout: { window, sessions, frustrations, registries, warnings, missing, sources }.
`;

if (import.meta.main) {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) process.stdout.write(HELP);
	else process.stdout.write(`${JSON.stringify(collect(argv), null, 2)}\n`);
}
