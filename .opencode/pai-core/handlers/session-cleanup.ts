/**
 * Session Cleanup Handler
 *
 * Ported from PAI v4.0.3 SessionCleanup.hook.ts
 * Triggered by: session.ended / session.idle (event bus)
 *
 * PURPOSE:
 * Finalizes a session by:
 * 1. Marking the current work directory as COMPLETED in PRD.md / META.yaml
 * 2. Clearing the current-work.json state file
 * 3. Cleaning up session-names.json entries (prevents ghost entries)
 *
 * COORDINATES WITH: learning-capture.ts (both run at session end)
 * MUST RUN AFTER: learning-capture.ts (learning capture uses state before clear)
 *
 * @module session-cleanup
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import {
	clearCurrentWork,
	getCurrentWorkStateFile,
	getStateDir,
	resolveSessionDir,
} from "../lib/paths";

/**
 * Mark the active work directory as COMPLETED and clear session state.
 *
 * @param sessionId - OpenCode session ID
 */
export async function cleanupSession(sessionId?: string, arbeidskatalog?: string | null): Promise<void> {
	try {
		const stateDir = getStateDir();

		// Kun den sesjons-scopede fila. Legacy-fallbacken plukket opp en
		// ANNEN økts tilstand når denne økten ikke hadde noen — og ryddet
		// dermed i den andres arbeid.
		const stateFile =
			sessionId && fs.existsSync(getCurrentWorkStateFile(sessionId))
				? getCurrentWorkStateFile(sessionId)
				: null;

		// `completeWorkSession` kjører først i teardown og rydder tilstanden, så
		// her fantes den aldri, og PRD-en ble aldri markert (M-48). Teardown slår
		// derfor opp katalogen før noe ryddes, og sender den med.
		if (!stateFile && !arbeidskatalog) {
			fileLog("[SessionCleanup] No current work state to clean up", "debug");
			return;
		}

		const state = stateFile ? JSON.parse(fs.readFileSync(stateFile, "utf-8")) : {};

		// Guard: don't process another session's state. This is only meaningful now
		// that setCurrentWorkPath() actually stamps session_id — previously this
		// field was never written, making the guard dead code.
		if (sessionId && state.session_id && state.session_id !== sessionId) {
			fileLog("[SessionCleanup] State belongs to different session — skipping", "warn");
			return;
		}

		const rawWorkDir = state.work_dir || state.session_dir || arbeidskatalog;

		if (rawWorkDir) {
			// rawWorkDir may be an absolute path (pre-fix state) or WORK-dir-relative
			// (new state) — resolveSessionDir() handles both. See lib/paths.ts.
			const workPath = resolveSessionDir(rawWorkDir);
			if (!workPath) return;
			const completedAt = new Date().toISOString();
			let marked = false;

			// Primary: update the PRD's frontmatter (`PRD.md`, or an older
			// `PRD-<dato>-<slug>.md`, M-47)
			const { finnPrd } = await import("./prd-sync");
			const prdPath = finnPrd(workPath);
			if (prdPath) {
				let content = fs.readFileSync(prdPath, "utf-8");
				content = content.replace(/^status: ACTIVE$/m, "status: COMPLETED");
				content = content.replace(/^completed_at: null$/m, `completed_at: "${completedAt}"`);
				fs.writeFileSync(prdPath, content, "utf-8");
				marked = true;
				fileLog(`[SessionCleanup] Marked PRD.md as COMPLETED: ${rawWorkDir}`, "info");
			}

			// Legacy fallback: META.yaml
			const metaPath = path.join(workPath, "META.yaml");
			if (fs.existsSync(metaPath)) {
				let content = fs.readFileSync(metaPath, "utf-8");
				content = content.replace(/^status: "ACTIVE"$/m, 'status: "COMPLETED"');
				content = content.replace(/^completed_at: null$/m, `completed_at: "${completedAt}"`);
				fs.writeFileSync(metaPath, content, "utf-8");
				if (!marked) {
					marked = true;
					fileLog(`[SessionCleanup] Marked META.yaml as COMPLETED: ${rawWorkDir}`, "info");
				}
			}

			if (!marked) {
				fileLog(`[SessionCleanup] No PRD.md or META.yaml found in ${workPath}`, "debug");
			}
		}

		// Delete state file. Use clearCurrentWork() rather than unlinking `stateFile`
		// directly so the legacy mirror is also cleared — but only if it still
		// belongs to this session (clearCurrentWork re-checks session_id itself),
		// so a session B active in the meantime never gets its state wiped by A's
		// cleanup even though both may share the legacy file.
		const sid = sessionId || state.session_id;
		await clearCurrentWork(sid || undefined);
		fileLog("[SessionCleanup] Cleared session work state", "info");
		if (sid) {
			const snPath = path.join(stateDir, "session-names.json");
			try {
				if (fs.existsSync(snPath)) {
					const names = JSON.parse(fs.readFileSync(snPath, "utf-8"));
					if (names[sid]) {
						delete names[sid];
						fs.writeFileSync(snPath, JSON.stringify(names, null, 2), "utf-8");
						fileLog(`[SessionCleanup] Removed session ${sid} from session-names.json`, "info");
					}
				}
			} catch (err) {
				fileLogError("[SessionCleanup] Failed to clean session-names.json", err);
			}
		}

		fileLog("[SessionCleanup] Session cleanup complete", "info");
	} catch (error) {
		fileLogError("[SessionCleanup] Cleanup failed (non-blocking)", error);
		// Don't rethrow — session end must not be disrupted
	}
}
