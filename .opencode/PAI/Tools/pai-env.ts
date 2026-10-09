/**
 * Loads `.opencode/.env` into `process.env` for tools that read their keys from
 * the environment (#185).
 *
 * Nothing else loads the file: `pai` starts Bun from the repo root, Bun reads
 * `.env` only from its own cwd, and neither Claude Code nor OpenCode loads it.
 * A tool that reads `process.env.X` calls `loadPaiEnv()` at the top of the file,
 * before the first read.
 *
 * What is already set in the environment wins, so `X=… bun tool.ts` still
 * overrides the file. An empty value counts as unset, both ways.
 *
 * @module PAI/Tools/pai-env
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The `.opencode` tree: `PAI_HOME`, then `OPENCODE_DIR`, then `~/.opencode`. */
export function paiEnvDir(): string {
	const override = process.env.PAI_HOME?.trim() || process.env.OPENCODE_DIR?.trim();
	return override || join(homedir(), ".opencode");
}

/**
 * The `NAME=value` lines of an env file. Takes `export NAME=`, strips one pair
 * of surrounding quotes, and drops a ` # comment` after an unquoted value, as
 * `source` would.
 */
export function parseEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const m = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
		if (!m) continue;
		let value = m[2].trim();
		const q = value[0];
		if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
		else value = value.replace(/\s+#.*$/, "");
		out[m[1]] = value;
	}
	return out;
}

/**
 * Sets every key from `<dir>/.env` that the environment does not already have.
 * Returns the path it read, or null when there is no file.
 */
export function loadPaiEnv(dir: string = paiEnvDir()): string | null {
	const path = join(dir, ".env");
	if (!existsSync(path)) return null;
	for (const [name, value] of Object.entries(parseEnv(readFileSync(path, "utf-8")))) {
		if (value && !process.env[name]) process.env[name] = value;
	}
	return path;
}
