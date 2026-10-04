/**
 * roborev Code Review Handler
 *
 * Provides AI-powered code review via the roborev CLI tool.
 * roborev is MIT-licensed, fully local, and explicitly supports OpenCode.
 * https://github.com/kenn-io/roborev
 *
 * STATUS 2026-09-22: `roborev` er IKKE installert på noen maskin i dette
 * oppsettet, så `code_review` er død kode i dag — `isRoborevAvailable()`
 * returnerer false og verktøyet svarer med installasjonsveiledning. Det er
 * grunnen til at det ikke har noen Claude Code-motpart i MCP-serveren.
 *
 * Organisasjonen har dessuten byttet navn: `roborev-dev` → `kenn-io`.
 * Kommandoen under er rettet tilsvarende, men er ikke verifisert — ingen av
 * maskinene har brew.
 *
 * TOOLS PROVIDED:
 * - code_review: Runs roborev to review staged/unstaged changes or last commit.
 *   The Algorithm can call this directly during VERIFY or after BUILD phase.
 *
 * HOOKS USED:
 * - (none active) Post-commit hook is managed by roborev itself via `roborev init`.
 *   This handler focuses on the on-demand `code_review` tool the Algorithm uses.
 *
 * SETUP (one-time per developer):
 *   brew install kenn-io/tap/roborev    # org omdøpt fra roborev-dev, ikke testet
 *   roborev init           # installs git post-commit hook
 *   roborev skills install # installs OpenCode skill for roborev
 *
 * USAGE BY THE ALGORITHM:
 *   Call `code_review` tool with mode="dirty" to review uncommitted changes.
 *   Call `code_review` tool with mode="last-commit" to review the last commit.
 *   Call `code_review` tool with mode="fix" to feed findings to the agent.
 *   Call `code_review` tool with mode="refine" for the auto-fix loop.
 *
 * @module roborev-trigger
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileLog, fileLogError } from "../lib/file-logger";

const execFile = promisify(execFileCb);

// --- Types ---

export type ReviewMode = "dirty" | "last-commit" | "fix" | "refine";

interface ReviewResult {
	success: boolean;
	output: string;
	exitCode: number;
}

// --- roborev CLI Helpers ---

/**
 * Check if roborev is installed and available in PATH.
 * Uses a short 5-second timeout — version check should be instant.
 */
export async function isRoborevAvailable(): Promise<boolean> {
	try {
		await execFile("roborev", ["--version"], {
			timeout: 5_000,
			signal: AbortSignal.timeout(5_000),
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Run a roborev command asynchronously and return the result.
 * All output is captured — no TTY needed.
 */
export async function runRoborev(args: string[]): Promise<ReviewResult> {
	fileLog(`[roborev] Running: roborev ${args.join(" ")}`, "info");

	try {
		const { stdout, stderr } = await execFile("roborev", args, {
			encoding: "utf-8",
			timeout: 120_000, // 2 minutes — roborev calls the LLM
			maxBuffer: 10 * 1024 * 1024, // 10 MiB — large reviews can exceed the 1 MiB default
			cwd: process.cwd(),
			signal: AbortSignal.timeout(120_000),
		});

		const output = [stdout, stderr].filter(Boolean).join("\n").trim();

		// Log only metadata — never raw stdout/stderr content (may contain code/secrets).
		// Set DEBUG_ROBOREV=1 in environment to include truncated content for debugging.
		fileLog(
			`[roborev] Exit code: 0, output length: ${output.length}, stdout: ${stdout?.length ?? 0}b, stderr: ${stderr?.length ?? 0}b`,
			"info"
		);
		if (process.env.DEBUG_ROBOREV) {
			if (stdout) fileLog(`[roborev] stdout (debug): ${stdout.slice(0, 500)}`, "info");
			if (stderr) fileLog(`[roborev] stderr (debug): ${stderr.slice(0, 500)}`, "info");
		}

		return { success: true, output: output || "(no output)", exitCode: 0 };
	} catch (err) {
		// execFile rejects for non-zero exit, spawn errors (ENOENT), and timeouts.
		// The error object carries .code, .signal, .stdout, .stderr on ExecFileException.
		const error = err as NodeJS.ErrnoException & {
			stdout?: string;
			stderr?: string;
			signal?: string;
		};

		// Timeout: AbortSignal fires (AbortError) or execFile's own ETIMEDOUT.
		if (error.name === "AbortError" || error.code === "ETIMEDOUT") {
			const msg = "roborev timed out. Try focusing the review with a path argument.";
			fileLog(`[roborev] Timeout: ${msg}`, "warn");
			return { success: false, output: msg, exitCode: 1 };
		}

		// Non-zero exit WITH output — roborev ran but found issues or printed an error.
		// This is the normal "findings" case: exit code 1 + review output in stdout/stderr.
		const captured = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
		if (captured) {
			// error.code is a number (the child's exit code) for normal non-zero exits.
			// It is a string (e.g. "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ENOENT") for
			// Node-level errors. error.status is undefined for promisified execFile.
			const rawCode = (error as NodeJS.ErrnoException).code;
			const exitCode = typeof rawCode === "number" ? rawCode : 1;
			fileLog(`[roborev] Exited with code ${exitCode}, output length: ${captured.length}`, "info");
			return { success: false, output: captured, exitCode };
		}

		// Signal received (not a timeout) — e.g. SIGINT or SIGKILL from outside.
		if (error.signal) {
			const msg = `roborev was terminated by signal ${error.signal}.`;
			fileLog(`[roborev] ${msg}`, "warn");
			return { success: false, output: msg, exitCode: 1 };
		}

		// Spawn failure (e.g. ENOENT — roborev not in PATH) or other unexpected error.
		fileLogError("[roborev] Failed to run roborev", error);
		return {
			success: false,
			output: `Failed to run roborev: ${error.message ?? String(error)}`,
			exitCode: 1,
		};
	}
}
