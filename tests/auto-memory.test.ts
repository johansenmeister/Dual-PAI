/**
 * Contract test: Claude Code's auto memory reaches both engines (#438)
 *
 * Corrections saved by Claude Code landed in `~/.claude/projects/<slug>/memory/`,
 * which OpenCode never read; on a work machine 18 rules piled up there. Now
 * `pai --claude` points the memory at `MEMORY/AUTO/`, and the shared context
 * gives OpenCode its index (but not Claude, which loads it itself).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserSystemContext } from "../.opencode/pai-core/dispatch/context";
import { autoMemoryDir, autoMemoryIndex } from "../.opencode/pai-core/lib/auto-memory";

const dirs: string[] = [];

afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "pai-auto-memory-"));
	dirs.push(d);
	return d;
}

function writeIndex(dir: string, text: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "MEMORY.md"), text);
}

describe("autoMemoryIndex", () => {
	test("no index gives null", () => {
		expect(autoMemoryIndex(newDir())).toBeNull();
	});

	test("an empty index gives null", () => {
		const d = newDir();
		writeIndex(d, "\n\n");
		expect(autoMemoryIndex(d)).toBeNull();
	});

	test("the lines, under a header that names the directory the links are relative to", () => {
		const d = newDir();
		writeIndex(d, "- [Local time](local-time.md) — times to the user in their zone\n");
		const index = autoMemoryIndex(d) ?? "";
		expect(index.split("\n")[0]).toContain(d);
		expect(index).toContain("- [Local time](local-time.md) — times to the user in their zone");
	});

	test("a long index is cut, and says how much is left", () => {
		const d = newDir();
		writeIndex(d, Array.from({ length: 205 }, (_, i) => `- line ${i}`).join("\n"));
		const lines = (autoMemoryIndex(d) ?? "").split("\n");
		expect(lines).toContain("- line 199");
		expect(lines).not.toContain("- line 200");
		expect(lines.at(-1)).toContain("5 more lines");
	});
});

describe("loadUserSystemContext and the auto memory", () => {
	let previousHarness: string | undefined;
	let indexFile: string;

	beforeEach(() => {
		previousHarness = process.env.PAI_HARNESS;
		const dir = autoMemoryDir(process.env.PAI_HOME as string);
		writeIndex(dir, "- [Ask first](ask-first.md) — network changes wait for a yes\n");
		indexFile = join(dir, "MEMORY.md");
	});

	afterEach(() => {
		if (previousHarness === undefined) delete process.env.PAI_HARNESS;
		else process.env.PAI_HARNESS = previousHarness;
		rmSync(indexFile, { force: true });
	});

	test("OpenCode gets the index", async () => {
		delete process.env.PAI_HARNESS;
		const res = await loadUserSystemContext();
		expect(res?.context).toContain("--- Memories from earlier sessions ---");
		expect(res?.context).toContain("- [Ask first](ask-first.md) — network changes wait for a yes");
	});

	test("Claude Code does not: it loads MEMORY.md itself", async () => {
		process.env.PAI_HARNESS = "claude";
		expect((await loadUserSystemContext())?.context).not.toContain("Memories from earlier sessions");
	});

	test("the launcher builds Claude's context in its own process, and says so", async () => {
		delete process.env.PAI_HARNESS;
		const res = await loadUserSystemContext({ autoMemory: false });
		expect(res?.context).not.toContain("Memories from earlier sessions");
	});
});
