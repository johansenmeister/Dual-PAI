/**
 * Contract test: SuggestSkills' signal collector (#444)
 *
 * What fails silently here: a store shape the collector does not read gives an empty
 * corpus, and the scan reports "nothing new" as if the frustration signal were clean.
 * Explicit ratings (`score`) dropped as malformed, month buckets listed as sessions,
 * or a window judged by mtime (the tree is synced with git) all look like a quiet month.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collect,
	collectRegistries,
	collectSessions,
	parseFrustrations,
} from "../.opencode/skills/Utilities/SuggestSkills/Tools/CollectSignals";

const TOOL = join(import.meta.dir, "..", ".opencode", "skills", "Utilities", "SuggestSkills", "Tools", "CollectSignals.ts");
const NOW = new Date("2026-10-15T12:00:00Z");
const SINCE = new Date("2026-09-01T00:00:00Z");

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tree(): string {
	const root = mkdtempSync(join(tmpdir(), "suggest-skills-"));
	roots.push(root);
	return root;
}

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

const rows = (...r: object[]) => `${r.map((x) => JSON.stringify(x)).join("\n")}\n`;

describe("parseFrustrations", () => {
	test("both row shapes count: explicit `score`/`comment` and implicit `rating`/`sentiment_summary`", () => {
		const f = join(tree(), "ratings.jsonl");
		write(
			f,
			rows(
				{ score: 2, comment: "broke it again", timestamp: "2026-10-01T10:00:00Z", source: "explicit" },
				{ rating: 3, sentiment_summary: "Mild frustration", timestamp: "2026-10-02T10:00:00Z", source: "implicit", harness: "claude" },
			),
		);
		const out = parseFrustrations(f, 4, SINCE, [], []);
		expect(out).toEqual([
			{ date: "2026-10-01", rating: 2, source: "explicit", harness: "", note: "broke it again" },
			{ date: "2026-10-02", rating: 3, source: "implicit", harness: "claude", note: "Mild frustration" },
		]);
	});

	test("above the cut, before the window, and malformed rows stay out; malformed ones are counted", () => {
		const f = join(tree(), "ratings.jsonl");
		write(
			f,
			`${rows(
				{ rating: 5, sentiment_summary: "neutral", timestamp: "2026-10-01T10:00:00Z" },
				{ rating: 1, sentiment_summary: "too old", timestamp: "2026-08-01T10:00:00Z" },
				{ rating: 1, timestamp: "not a date" },
				{ rating: 1 },
			)}{not json\n`,
		);
		const warnings: string[] = [];
		expect(parseFrustrations(f, 4, SINCE, warnings, [])).toEqual([]);
		expect(warnings).toEqual(["ratings: skipped 3 malformed/incomplete line(s)"]);
	});

	test("control characters in a note become spaces, and a long note is capped", () => {
		const f = join(tree(), "ratings.jsonl");
		write(f, rows({ score: 1, comment: `a\u0007b\nc${"x".repeat(600)}`, timestamp: "2026-10-01T10:00:00Z" }));
		const [row] = parseFrustrations(f, 4, SINCE, [], []);
		expect(row.note.startsWith("a b c")).toBe(true);
		expect(row.note.length).toBe(500);
	});

	test("a missing store is reported, not fatal", () => {
		const missing: string[] = [];
		expect(parseFrustrations(null, 4, SINCE, [], missing)).toEqual([]);
		expect(missing).toEqual(["ratings"]);
	});
});

describe("collectSessions", () => {
	test("month buckets are walked, not listed as sessions; top-level session dirs count too", () => {
		const work = join(tree(), "WORK");
		write(join(work, "2026-10", "2026-10-03T09-00-00_fix-backup", "META.yaml"), 'title: "fix backup"\nharness: claude\n');
		write(join(work, "2026-09-20T08-00-00_old-style", "META.yaml"), "title: old style\n");
		const out = collectSessions(work, SINCE, [], []);
		expect(out.map((s) => s.slug)).toEqual(["2026-10-03T09-00-00_fix-backup", "2026-09-20T08-00-00_old-style"]);
		expect(out[0]).toEqual({ slug: "2026-10-03T09-00-00_fix-backup", date: "2026-10-03", title: "fix backup", harness: "claude" });
	});

	test("the window is judged by the session's own date, not mtime (git sync resets mtime)", () => {
		const work = join(tree(), "WORK");
		const old = join(work, "2026-08", "2026-08-10T09-00-00_old-session");
		const fresh = join(work, "named-project");
		write(join(old, "META.yaml"), "title: old\n");
		write(join(fresh, "META.yaml"), "title: named\nstarted_at: 2026-10-05T10:00:00.000Z\n");
		// A fresh pull: the old session looks new on disk, the new one looks old.
		utimesSync(old, NOW, NOW);
		utimesSync(fresh, new Date("2026-01-01"), new Date("2026-01-01"));
		const out = collectSessions(work, SINCE, [], []);
		expect(out.map((s) => [s.slug, s.date])).toEqual([["named-project", "2026-10-05"]]);
	});

	test("a dir with no date in the name or META.yaml is skipped with a warning; no title falls back to the slug", () => {
		const work = join(tree(), "WORK");
		mkdirSync(join(work, "no-date-at-all"), { recursive: true });
		mkdirSync(join(work, "2026-10", "2026-10-04T10-00-00_bare"), { recursive: true });
		const warnings: string[] = [];
		const out = collectSessions(work, SINCE, warnings, []);
		expect(out).toEqual([{ slug: "2026-10-04T10-00-00_bare", date: "2026-10-04", title: "2026-10-04T10-00-00_bare", harness: "" }]);
		expect(warnings).toEqual(["work-sessions: skipped 1 dir(s) with no date in the name or META.yaml"]);
	});
});

describe("collectRegistries", () => {
	test("flat and Category/Skill both found, with workflows and paths relative to the tree", () => {
		const skills = join(tree(), "skills");
		write(join(skills, "Flat", "SKILL.md"), "---\nname: Flat\ndescription: A flat skill. USE WHEN flat.\n---\n");
		write(join(skills, "Cat", "SKILL.md"), "---\nname: Cat\ndescription: >\n  A folded\n  description.\n---\n");
		write(join(skills, "Cat", "Deep", "SKILL.md"), "---\nname: Deep\ndescription: Nested.\n---\n");
		write(join(skills, "Cat", "Deep", "Workflows", "Run.md"), "# Run\n");
		// Tools/ and Workflows/ are never walked for skills, also under a flat skill (depth 2).
		write(join(skills, "Flat", "Tools", "SKILL.md"), "---\nname: NotASkill\n---\n");
		write(join(skills, "Cat", "Deep", "Tools", "Inner", "SKILL.md"), "---\nname: NotASkill\n---\n");
		const out = collectRegistries(skills, [], []);
		expect(out).toEqual([
			{ kind: "skill", name: "Cat", path: "Cat/SKILL.md", description: "A folded description." },
			{ kind: "skill", name: "Deep", path: "Cat/Deep/SKILL.md", description: "Nested." },
			{ kind: "skill", name: "Flat", path: "Flat/SKILL.md", description: "A flat skill. USE WHEN flat." },
			{ kind: "workflow", name: "Deep/Run", path: "Cat/Deep/Workflows/Run.md", description: "" },
		]);
	});

	test("a SKILL.md without name: is a warning, not a crash", () => {
		const skills = join(tree(), "skills");
		write(join(skills, "Broken", "SKILL.md"), "---\ndescription: no name\n---\n");
		const warnings: string[] = [];
		expect(collectRegistries(skills, warnings, [])).toEqual([]);
		expect(warnings).toEqual(["skills: Broken/SKILL.md unreadable or missing name:"]);
	});
});

describe("collect", () => {
	function fullTree(): string {
		const root = tree();
		write(join(root, "MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl"), rows({ rating: 2, sentiment_summary: "x", timestamp: "2026-10-10T10:00:00Z" }));
		write(join(root, "MEMORY", "WORK", "2026-10", "2026-10-10T10-00-00_a", "META.yaml"), "title: a\n");
		write(join(root, "skills", "A", "SKILL.md"), "---\nname: A\ndescription: a\n---\n");
		return root;
	}

	test("every store resolves under --root, and two runs give the same corpus", () => {
		const root = fullTree();
		const a = collect(["--root", root], NOW);
		expect(a.missing).toEqual([]);
		expect([a.sessions.length, a.frustrations.length, a.registries.length]).toEqual([1, 1, 1]);
		expect(a.window).toEqual({ days: 45, since: "2026-08-31", maxRating: 4 });
		expect(collect(["--root", root], NOW)).toEqual(a);
	});

	test("an empty install is a valid, empty corpus", () => {
		const c = collect(["--root", tree()], NOW);
		expect(c.missing).toEqual(["work-sessions", "ratings", "skills"]);
		expect(c.warnings).toEqual([]);
	});

	test("a bad explicit path is reported, never silently replaced by the default", () => {
		const root = fullTree();
		const c = collect(["--root", root, "--ratings", join(root, "nope.jsonl")], NOW);
		expect(c.frustrations).toEqual([]);
		expect(c.warnings).toContain(`ratings: --ratings path ${join(root, "nope.jsonl")} does not exist`);
	});

	test("garbage and out-of-range numbers warn and fall back or clamp", () => {
		const c = collect(["--root", tree(), "--days", "abc", "--max-rating", "99"], NOW);
		expect(c.window.days).toBe(45);
		expect(c.window.maxRating).toBe(10);
		expect(c.warnings).toEqual(["--days: not an integer (abc); using 45", "--max-rating: 99 above 10; clamped"]);
	});

	test("without --root, PAI_HOME is the root", () => {
		expect(collect([], NOW).sources.root).toBe(process.env.PAI_HOME as string);
	});
});

describe("CLI", () => {
	test("prints the corpus as JSON and exits 0, also from another working directory", () => {
		const root = tree();
		const r = Bun.spawnSync(["bun", TOOL, "--root", root], { cwd: tmpdir() });
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout.toString()).missing).toEqual(["work-sessions", "ratings", "skills"]);
	});

	test("without --root or PAI_HOME, the root is the .opencode the tool lives in", () => {
		const r = Bun.spawnSync(["bun", TOOL, "--days", "1"], { cwd: tmpdir(), env: { ...process.env, PAI_HOME: "" } });
		expect(r.exitCode).toBe(0);
		expect(JSON.parse(r.stdout.toString()).sources.root).toBe(join(import.meta.dir, "..", ".opencode"));
	});

	test("--help prints usage and no corpus", () => {
		const r = Bun.spawnSync(["bun", TOOL, "--help"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toStartWith("CollectSignals");
	});
});
