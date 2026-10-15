/**
 * Claude Code's auto memory, kept in the tree (#438)
 *
 * Claude Code saves what the user corrects or prefers as one file per memory,
 * with a `MEMORY.md` index it loads into every session. By default that is
 * `~/.claude/projects/<slug>/memory/`: outside the repo, so OpenCode never
 * sees it, autosync never takes it to the other machine, and git never backs
 * it up. On a work machine 18 rules had piled up there before anyone noticed.
 *
 * `pai --claude` points Claude Code's `autoMemoryDirectory` at `MEMORY/AUTO/`
 * instead, and `dispatch/context.ts` gives OpenCode the same index. MEMORY is
 * synced by git between the owner's machines, so the rules follow.
 *
 * MEASURED (Claude Code 2.1.283, `claude -p` with `--settings
 * '{"autoMemoryDirectory":"<dir>"}'`): the model answered from a `MEMORY.md`
 * in that directory, and its system prompt named it as the memory directory;
 * the same question without the setting got "unknown". Read from the binary,
 * not measured: the path must be absolute (or start with `~/`), and the key is read
 * from policy settings, `--settings`, user settings and, in a trusted
 * workspace, the local settings, but not from a checked-in
 * `.claude/settings.json`.
 *
 * @module pai-core/lib/auto-memory
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Lines of the index that reach OpenCode; the rest are named, not shown. */
const INDEX_MAX_LINES = 200;

/** `MEMORY/AUTO` under a `.opencode` directory: where Claude Code's memory lives. */
export function autoMemoryDir(opencodeDir: string): string {
	return join(opencodeDir, "MEMORY", "AUTO");
}

/**
 * The index for OpenCode's context, or null when there is none.
 *
 * Claude Code loads `MEMORY.md` itself, so this is only for the other engine.
 * The links in the index are relative to `dir`, so the header names it.
 */
export function autoMemoryIndex(dir: string): string | null {
	let text: string;
	try {
		text = readFileSync(join(dir, "MEMORY.md"), "utf-8");
	} catch {
		return null;
	}
	const lines = text.split("\n").filter((l) => l.trim() !== "");
	if (lines.length === 0) return null;
	const shown = lines.slice(0, INDEX_MAX_LINES);
	if (lines.length > INDEX_MAX_LINES) {
		shown.push(`- … ${lines.length - INDEX_MAX_LINES} more lines in ${join(dir, "MEMORY.md")}`);
	}
	return [
		`Memories saved in earlier sessions, in ${dir}: the user's corrections and preferences, and facts about the environment. They apply in this engine too. Each line links a file in that directory; before acting on a task, open the ones that touch it.`,
		...shown,
	].join("\n");
}
