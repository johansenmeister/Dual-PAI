/**
 * Last Response Cache Handler
 *
 * Ported from PAI v4.0.3 LastResponseCache.hook.ts
 * Triggered by: message.updated (assistant role, event bus)
 *
 * PURPOSE:
 * Caches the last assistant response text to disk so RatingCapture
 * (which fires on user message) can access the previous response
 * for context-aware rating analysis.
 *
 * This bridges the gap where the rating arrives AFTER the response —
 * RatingCapture needs to know WHAT it's rating.
 *
 * STORAGE: MEMORY/STATE/last-response.txt (max 2000 chars, trimmed)
 *
 * @module last-response-cache
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import { ensureDir, getStateDir } from "../lib/paths";

const MAX_CACHE_LENGTH = 2000;

/**
 * Get session-scoped cache filename to prevent cross-session overwrites.
 * Falls back to "last-response.txt" for backward compat when no sessionId given.
 *
 * @param sessionId - OpenCode session ID (sanitized for use in filenames)
 */
function getCacheFilename(sessionId?: string): string {
	if (!sessionId || sessionId === "unknown") return "last-response.txt";
	// Sanitize: keep only alphanumeric, hyphens, underscores — strip path chars
	const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	return `last-response-${safe}.txt`;
}

/**
 * Cache the assistant response for later use by RatingCapture.
 * Uses session-scoped filename to prevent cross-session overwrites.
 *
 * @param responseText - Full assistant response text
 * @param sessionId - OpenCode session ID (optional, for scoping)
 */
export async function cacheLastResponse(responseText: string, sessionId?: string): Promise<void> {
	if (!responseText || responseText.trim().length === 0) return;

	try {
		const stateDir = getStateDir();
		await ensureDir(stateDir);

		const cachePath = path.join(stateDir, getCacheFilename(sessionId));
		const truncated = responseText.slice(0, MAX_CACHE_LENGTH);

		await fs.promises.writeFile(cachePath, truncated, "utf-8");
		fileLog(
			`[LastResponseCache] Cached ${truncated.length} chars (session: ${sessionId ?? "global"})`,
			"debug"
		);
	} catch (error) {
		fileLogError("[LastResponseCache] Failed to write cache", error);
		// Non-blocking — rating capture will just work without context
	}
}

/**
 * Fjern øktens bufrede svar. Kalles sist i teardown.
 *
 * Svaret er kontekst for sentimentanalysen av NESTE brukermelding i samme
 * økt; når økten er over, har det ingen leser. Den globale
 * `last-response.txt` (ingen sesjons-ID) røres aldri herfra.
 */
export async function clearLastResponse(sessionId: string): Promise<void> {
	if (!sessionId || sessionId === "unknown") return;
	await fs.promises.rm(path.join(getStateDir(), getCacheFilename(sessionId)), { force: true });
}

/**
 * Read the cached last response (for use by RatingCapture).
 * Uses session-scoped filename to prevent reading stale cross-session data.
 *
 * @param sessionId - OpenCode session ID (optional, for scoping)
 * @returns Cached response text, or null if not available
 */
export async function readLastResponse(sessionId?: string): Promise<string | null> {
	try {
		const cachePath = path.join(getStateDir(), getCacheFilename(sessionId));
		return await fs.promises.readFile(cachePath, "utf-8");
	} catch {
		return null;
	}
}
