/**
 * claude-transcripts.ts — where Claude Code keeps its session transcripts.
 *
 * SessionHarvester and ActivityParser parse Claude Code's JSONL transcripts,
 * but looked for them in `~/.opencode/projects`, which neither engine writes.
 * Claude Code writes `<config dir>/projects/<slug>/<session>.jsonl`, and
 * OpenCode v2 keeps its sessions in `opencode.db`, in another format. Both
 * tools found nothing and said only that the directory was missing.
 *
 * The slug is Claude Code's own (read from 2.1.283): every character outside
 * [a-zA-Z0-9] becomes "-", and a slug over 200 characters is cut and given a
 * hash suffix. The hash is not reproduced here; the long case is matched on
 * the prefix instead. `env` is an argument, so a test never reads the user's
 * own transcripts.
 *
 * @module claude-transcripts
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_SLUG = 200;

export interface Transcript {
	name: string;
	path: string;
	mtime: number;
}

/** `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
	const config = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
	return join(config, "projects");
}

/** The directory Claude Code uses for sessions started in `cwd`. */
export function claudeProjectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const root = claudeProjectsDir(env);
	const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
	if (slug.length <= MAX_SLUG) return join(root, slug);
	const prefix = `${slug.slice(0, MAX_SLUG)}-`;
	const match = subdirectories(root).find((d) => d.startsWith(prefix));
	return join(root, match ?? slug.slice(0, MAX_SLUG));
}

/** Every project directory under `claudeProjectsDir`, for readers that span all of them. */
export function allClaudeProjectDirs(env: NodeJS.ProcessEnv = process.env): string[] {
	const root = claudeProjectsDir(env);
	return subdirectories(root).map((d) => join(root, d));
}

/**
 * The session transcripts in `dirs`, newest first. Only the top level counts:
 * a session's own subdirectory holds its subagents and tool results.
 */
export function listTranscripts(dirs: string[]): Transcript[] {
	const found: Transcript[] = [];
	for (const dir of dirs) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(dir, name);
			try {
				const stat = statSync(path);
				if (stat.isFile()) found.push({ name, path, mtime: stat.mtime.getTime() });
			} catch {
				// removed between readdir and stat
			}
		}
	}
	return found.sort((a, b) => b.mtime - a.mtime);
}

function subdirectories(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
}
