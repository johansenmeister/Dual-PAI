/**
 * The `pai` command as a file on PATH (#476).
 *
 * The installer has put `pai` in the login shell's profile as a function, and a
 * shell that does not read the profile has no `pai`: the agents' shell tools,
 * `ssh host 'cmd'`, cron and systemd. `~/.local/bin/pai` is a small script that
 * does what the function does, so every shell with `~/.local/bin` on PATH finds
 * it. The function stays for interactive shells.
 *
 * `PAI-Install/cli/shell-setup.ts` writes it, and `pai doctor` says when it is
 * missing or runs another PAI (`maskin-helse.ts`).
 *
 * @module PAI/Tools/pai-command
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Marks a `pai` command PAI wrote; a file without it is never overwritten. */
export const PAI_COMMAND_MARKER = "# PAI command — written by PAI-Install/cli/shell-setup.ts";

export function paiCommandPath(home: string): string {
	return join(home, ".local", "bin", "pai");
}

/** The script for the repo in `installDir`, the same steps as the shell function. */
export function paiCommandScript(installDir: string): string {
	const dir = `'${installDir.replaceAll("'", `'\\''`)}'`;
	return [
		"#!/bin/sh",
		`${PAI_COMMAND_MARKER} (#476).`,
		"# The pai function in the shell profile does the same for interactive shells.",
		`cd ${dir} || exit 1`,
		'if [ -x "$HOME/.bun/bin/bun" ]; then',
		'  exec "$HOME/.bun/bin/bun" run .opencode/PAI/Tools/pai.ts "$@"',
		"fi",
		'exec bun run .opencode/PAI/Tools/pai.ts "$@"',
		"",
	].join("\n");
}

export type PaiCommandState = "ok" | "missing" | "other" | "foreign";

/** `other`: PAI wrote it, for another repo or an older script. `foreign`: PAI did not write it. */
export function paiCommandState(home: string, installDir: string): PaiCommandState {
	const path = paiCommandPath(home);
	if (!existsSync(path)) return "missing";
	const text = readFileSync(path, "utf-8");
	if (!text.includes(PAI_COMMAND_MARKER)) return "foreign";
	return text === paiCommandScript(installDir) ? "ok" : "other";
}

/** Writes the script unless a file PAI did not write is there. Returns the state before. */
export function writePaiCommand(home: string, installDir: string): PaiCommandState {
	const state = paiCommandState(home, installDir);
	if (state === "ok" || state === "foreign") return state;
	const path = paiCommandPath(home);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, paiCommandScript(installDir));
	chmodSync(tmp, 0o755);
	renameSync(tmp, path);
	return state;
}
