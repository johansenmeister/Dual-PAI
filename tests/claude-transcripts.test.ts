/**
 * Contract test: SessionHarvester and ActivityParser find Claude Code's transcripts
 *
 * Both tools looked in `~/.opencode/projects`, which no engine writes, and
 * found nothing. Claude Code writes `<config dir>/projects/<slug>/<id>.jsonl`,
 * with every character outside [a-zA-Z0-9] in the cwd turned into "-".
 *
 * @module tests/claude-transcripts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	allClaudeProjectDirs,
	claudeProjectDir,
	claudeProjectsDir,
	listTranscripts,
} from "../.opencode/PAI/Tools/claude-transcripts";

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function home(): string {
	const h = mkdtempSync(join(tmpdir(), "pai-claude-transcripts-"));
	roots.push(h);
	return h;
}

function transcript(dir: string, name: string, mtimeSeconds: number): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, "{}\n");
	utimesSync(path, mtimeSeconds, mtimeSeconds);
	return path;
}

describe("claudeProjectsDir", () => {
	test("~/.claude/projects", () => {
		const h = home();
		expect(claudeProjectsDir({ HOME: h })).toBe(join(h, ".claude", "projects"));
	});

	test("CLAUDE_CONFIG_DIR replaces ~/.claude", () => {
		expect(claudeProjectsDir({ HOME: "/home/x", CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/projects");
	});
});

describe("claudeProjectDir", () => {
	test("dots, slashes and underscores all become '-', like Claude Code's slug", () => {
		const h = home();
		expect(claudeProjectDir("/home/x/.config/my_repo", { HOME: h })).toBe(
			join(h, ".claude", "projects", "-home-x--config-my-repo"),
		);
	});

	test("a slug over 200 characters matches Claude Code's directory by prefix", () => {
		const h = home();
		const cwd = `/${"a".repeat(250)}`;
		const cut = `-${"a".repeat(199)}`;
		const dir = join(h, ".claude", "projects", `${cut}-1x2y3z`);
		mkdirSync(dir, { recursive: true });
		expect(claudeProjectDir(cwd, { HOME: h })).toBe(dir);
	});
});

describe("listTranscripts", () => {
	test("top-level .jsonl only, newest first, across directories", () => {
		const h = home();
		const a = join(h, ".claude", "projects", "-a");
		const b = join(h, ".claude", "projects", "-b");
		const old = transcript(a, "old.jsonl", 1_000);
		const fresh = transcript(b, "fresh.jsonl", 2_000);
		transcript(join(a, "old", "subagents"), "agent-1.jsonl", 3_000);
		writeFileSync(join(a, "notes.txt"), "x");

		// The older directory first, so only the sort can put `fresh` first.
		const found = listTranscripts([a, b]);
		expect(found.map((t) => t.path)).toEqual([fresh, old]);
	});

	test("allClaudeProjectDirs lists the project directories, not loose files", () => {
		const h = home();
		const projects = join(h, ".claude", "projects");
		mkdirSync(join(projects, "-a"), { recursive: true });
		mkdirSync(join(projects, "-b"));
		writeFileSync(join(projects, "stray.jsonl"), "{}\n");
		expect(allClaudeProjectDirs({ HOME: h }).sort()).toEqual([join(projects, "-a"), join(projects, "-b")]);
	});

	test("a missing directory gives an empty list, not an exception", () => {
		expect(listTranscripts([join(home(), "nowhere")])).toEqual([]);
	});
});
