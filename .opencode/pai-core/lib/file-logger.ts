/**
 * PAI-OpenCode File Logger
 *
 * TUI-SAFE LOGGING: NEVER use console.log in OpenCode plugins!
 * Console output corrupts the OpenCode TUI.
 *
 * This module provides file-only logging for debugging plugins.
 *
 * @module file-logger
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { forStorage } from "./secrets";

const DEFAULT_LOG_PATH = "/tmp/pai-opencode-debug.log";

/**
 * Resolve the log path on each call.
 *
 * Uten PAI_HARNESS er stien /tmp/pai-opencode-debug.log. Den var v1s logg;
 * etter at v1 ble slettet, skriver bare prosesser uten motor dit (testene).
 * Begge adapterne setter PAI_HARNESS, og får hver sin fil. PAI_LOG_PATH
 * overstyrer.
 *
 * Deliberately NOT under PAI_HOME: the log must stay writable even when the
 * MEMORY tree is missing or misconfigured, since that is exactly the failure
 * this logger has to report.
 */
export function getLogFilePath(): string {
	const raw = process.env.PAI_LOG_PATH;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed.length > 0) return trimmed;
	}

	// Utled fra motoren når den er kjent. Uten dette måtte hver adapter huske
	// å sette PAI_LOG_PATH, og glemmer den det, skriver begge motorene i
	// samme fil — der `clearLog()` ved oppstart sletter den andres logg midt
	// i en økt. Filnavnet er bitidentisk for OpenCode, som er standarden alle
	// runbooks peker på.
	const harness = process.env.PAI_HARNESS?.trim();
	if (harness && /^[a-z0-9-]+$/.test(harness)) {
		return `/tmp/pai-${harness}-debug.log`;
	}

	return DEFAULT_LOG_PATH;
}

/**
 * Log a message to file (TUI-safe)
 *
 * IMPORTANT: This function NEVER uses console.log
 * All output goes to getLogFilePath() — /tmp/pai-<harness>-debug.log
 *
 * @param message - The message to log
 * @param level - Log level (info, warn, error, debug)
 */
export function fileLog(
	message: string,
	level: "info" | "warn" | "error" | "debug" = "info"
): void {
	try {
		const timestamp = new Date().toISOString();
		const levelPrefix = level.toUpperCase().padEnd(5);
		// Masked: the log sits in /tmp and has held commands with tokens in them.
		const logLine = `[${timestamp}] [${levelPrefix}] ${forStorage(message)}\n`;

		const logPath = getLogFilePath();
		const dir = dirname(logPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		appendFileSync(logPath, logLine);
	} catch {
		// Silent fail - NEVER console.log here!
		// TUI corruption is worse than missing logs
	}
}

/**
 * Log an error with stack trace to file
 *
 * @param message - Error context message
 * @param error - The error object
 */
export function fileLogError(message: string, error: unknown): void {
	const errorMessage =
		error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error);
	fileLog(`${message}: ${errorMessage}`, "error");
}

/**
 * Get the log file path
 * Useful for telling users where to find logs
 */
export function getLogPath(): string {
	return getLogFilePath();
}

/**
 * Clear the log file
 * Useful at session start
 */
export function clearLog(): void {
	try {
		writeFileSync(getLogFilePath(), "");
	} catch {
		// Silent fail
	}
}

/**
 * Info level wrapper
 */
export function info(message: string, meta?: Record<string, unknown>): void {
	const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
	fileLog(`${message}${metaStr}`, "info");
}

/**
 * Warn level wrapper
 */
export function warn(message: string, meta?: Record<string, unknown>): void {
	const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
	fileLog(`${message}${metaStr}`, "warn");
}

/**
 * Error level wrapper
 */
export function error(message: string, meta?: Record<string, unknown>): void {
	const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
	fileLog(`${message}${metaStr}`, "error");
}
