/**
 * update-counts.ts - Update settings.json with fresh system counts
 *
 * PURPOSE:
 * Updates the counts section of settings.json at the end of each session.
 * Banner and statusline then read from settings.json (instant, no execution).
 *
 * ARCHITECTURE:
 * Stop hook → UpdateCounts → settings.json
 * Session start → Banner reads settings.json (instant)
 * Session start → Statusline reads settings.json (instant)
 *
 * This design ensures:
 * - No spawning/execution at session start
 * - Counts are always available (no waiting)
 * - Single source of truth in settings.json
 *
 * PORTED FROM: PAI v2.5 hooks/handlers/UpdateCounts.ts
 * ADAPTATIONS FOR PAI-OPENCODE:
 * - getPaiDir() → getOpenCodeDir()
 * - hooks/ → plugins/
 * - console.error → fileLog (TUI-safe)
 * - Legacy directory references migrated to .opencode/
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import { getOpenCodeDir } from "../lib/paths";
import { getISOTimestamp } from "../lib/time";

interface Counts {
	skills: number;
	workflows: number;
	plugins: number; // Changed from 'hooks' to 'plugins'
	signals: number;
	files: number;
	updatedAt: string;
}

/**
 * Count files matching criteria recursively
 */
function countFilesRecursive(dir: string, extension?: string): number {
	let count = 0;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				count += countFilesRecursive(fullPath, extension);
			} else if (entry.isFile()) {
				if (!extension || entry.name.endsWith(extension)) {
					count++;
				}
			}
		}
	} catch {
		// Directory doesn't exist or not readable
	}
	return count;
}

/**
 * Count .md files inside any Workflows directory
 */
function countWorkflowFiles(dir: string): number {
	let count = 0;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.toLowerCase() === "workflows") {
					count += countFilesRecursive(fullPath, ".md");
				} else {
					count += countWorkflowFiles(fullPath);
				}
			}
		}
	} catch {
		// Directory doesn't exist or not readable
	}
	return count;
}

/**
 * Count skills: every SKILL.md under skills/, at any depth. The tree is
 * hierarchical (`skills/Infrastructure/Proxmox/SKILL.md`); one level down
 * counted the categories, 9 of 57.
 */
function countSkills(openCodeDir: string): number {
	let count = 0;
	const walk = (dir: string) => {
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) walk(join(dir, entry.name));
				else if (entry.name === "SKILL.md") count++;
			}
		} catch {
			// skills directory doesn't exist
		}
	};
	walk(join(openCodeDir, "skills"));
	return count;
}

/**
 * Count plugins (.ts files in plugins/ at depth 1)
 * Note: Changed from countHooks to countPlugins for OpenCode
 */
function countPlugins(openCodeDir: string): number {
	let count = 0;
	const pluginsDir = join(openCodeDir, "plugins");
	try {
		for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".ts")) {
				count++;
			}
		}
	} catch {
		// plugins directory doesn't exist
	}
	return count;
}

/**
 * Count non-empty lines in a JSONL file (signals = rating entries)
 */
function countRatingsLines(filePath: string): number {
	try {
		if (!existsSync(filePath) || !statSync(filePath).isFile()) return 0;
		return readFileSync(filePath, "utf-8")
			.split("\n")
			.filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
}

/**
 * Get all counts
 */
function getCounts(openCodeDir: string): Counts {
	return {
		skills: countSkills(openCodeDir),
		workflows: countWorkflowFiles(join(openCodeDir, "skills")),
		plugins: countPlugins(openCodeDir), // Changed from 'hooks'
		signals: countRatingsLines(join(openCodeDir, "MEMORY/LEARNING/SIGNALS/ratings.jsonl")),
		files: countFilesRecursive(join(openCodeDir, "PAI/USER")),
		updatedAt: getISOTimestamp(), // Using time.ts utility
	};
}

/**
 * Get settings.json path
 */
function getSettingsPath(openCodeDir: string): string {
	return join(openCodeDir, "settings.json");
}

/**
 * Handler called by StopOrchestrator
 */
export async function handleUpdateCounts(): Promise<void> {
	const openCodeDir = getOpenCodeDir();
	const settingsPath = getSettingsPath(openCodeDir);

	try {
		// Get fresh counts
		const counts = getCounts(openCodeDir);

		// Read current settings
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

		// Update counts section
		settings.counts = counts;

		// Write to temp then rename — atomic on POSIX, near-atomic on Windows.
		// settings.json holds user identity, timezone, and voice ID — a crash
		// mid-write must never leave it corrupted.
		const tmpPath = `${settingsPath}.tmp.${process.pid}`;
		writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
		renameSync(tmpPath, settingsPath);

		fileLog(
			`[UpdateCounts] Updated settings.json: ${counts.skills} skills, ${counts.workflows} workflows, ${counts.plugins} plugins, ${counts.signals} signals, ${counts.files} files`,
			"info"
		);
	} catch (error) {
		fileLogError("[UpdateCounts] Failed to update counts", error);
		// Non-fatal - don't throw, let other handlers continue
	}
}

// NOTE: In OpenCode, this module is always imported (never run directly).
// import.meta.main is always false — standalone execution not supported.
// Run: bun .opencode/PAI/Tools/GetCounts.ts to update counts manually.
