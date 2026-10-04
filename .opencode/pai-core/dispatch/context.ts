/**
 * PAI Core — bygging av systemkontekst
 *
 * Flyttet uendret fra `plugins/pai-unified.ts` (`loadUserSystemContext`).
 *
 * Importerer ingen motor.
 *
 * @module pai-core/dispatch/context
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fileLog, fileLogError } from "../lib/file-logger";

/**
 * PAI-katalogen, løst modul-relativt — ikke via `getPaiHome()`.
 *
 * Det er en bevisst forskjell. `getPaiHome()` prøver cwd først, så en økt
 * startet i et prosjekt med sin egen `.opencode/` ville fått FEIL PAI-tre.
 * Denne fila ligger i `.opencode/pai-core/dispatch/`, så `../../PAI` treffer
 * alltid det treet koden faktisk ble lastet fra — nøyaktig samme oppløsning
 * som `PLUGIN_DIR/../PAI` ga i pluginen.
 *
 * Merk at loaderen ikke realpath-er: `~/.opencode` er en symlink inn i
 * repoet, og fordi stien holder seg innenfor `.opencode/` er den gyldig
 * gjennom symlinken også.
 */
const PAI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "PAI");

/**
 * Read a file safely, returning null if not found (async)
 */
async function readFileSafe(filePath: string): Promise<string | null> {
	try {
		await fs.promises.access(filePath);
		return await fs.promises.readFile(filePath, "utf-8");
	} catch (error) {
		// Distinguish file-not-found from real I/O errors
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code === "ENOENT") {
			return null; // File not found - expected case
		}
		// Real I/O error - rethrow for caller to handle
		throw error;
	}
}

export interface UserContextResult {
	context: string;
	filesLoaded: number;
}

/**
 * Load user context — Steering Rules + User Identity
 *
 * The PAI Core Skill (Algorithm, ISC, Capabilities) is loaded via the
 * skill system (tier: "always") — NOT here. This function loads only
 * the dynamic, user-specific context that can't live in static skill files:
 *
 * 1. System AISTEERINGRULES.md (behavioral governance)
 * 2. User Identity files (ABOUTME, TELOS, DAIDENTITY) if they exist
 */
export async function loadUserSystemContext(): Promise<UserContextResult | null> {
	try {
		const contextParts: string[] = [];

		// 0. PAI Core Skill (the Algorithm + response formats) — injected in full.
		// OpenCode's native skill discovery only exposes name/description and loads
		// bodies on-demand; the core skill must be always-on for the response
		// formats to apply, so it cannot rely on the skill tool.
		const coreSkillPath = path.join(PAI_DIR, "SKILL.md");
		const coreSkillRaw = await readFileSafe(coreSkillPath);
		if (coreSkillRaw) {
			const coreSkill = coreSkillRaw.replace(/^---\n[\s\S]*?\n---\n/, "");
			contextParts.push(`--- PAI Core Skill (The Algorithm) ---\n${coreSkill}`);
			fileLog("Loaded PAI/SKILL.md (core skill, always-on)");
		}

		// 1. System Steering Rules (if exists)
		const systemSteeringPath = path.join(PAI_DIR, "AISTEERINGRULES.md");
		const systemSteering = await readFileSafe(systemSteeringPath);
		if (systemSteering) {
			contextParts.push(`--- System Steering Rules ---\n${systemSteering}`);
			fileLog("Loaded PAI/AISTEERINGRULES.md");
		}

		// 2. User Identity Files (if exist) — CRITICAL: Must know the user!
		const userDir = path.join(PAI_DIR, "USER");
		const userFiles = [
			{ file: "ABOUTME.md", label: "User Profile" },
			{ file: "TELOS/TELOS.md", label: "Life Goals" },
			{ file: "DAIDENTITY.md", label: "AI Identity" },
			{ file: "INFRASTRUCTURE.md", label: "Infrastructure Access" },
			{ file: "AISTEERINGRULES.md", label: "User Steering Rules" },
		];

		for (const { file, label } of userFiles) {
			const filePath = path.join(userDir, file);
			const content = await readFileSafe(filePath);
			if (content) {
				contextParts.push(`--- ${label} ---\n${content}`);
				fileLog(`Loaded PAI/USER/${file}`);
			}
		}

		if (contextParts.length === 0) {
			fileLog("No user context files found — PAI Core loaded via skill system");
			return null;
		}

		// Combine all context — contextParts.length is the accurate total file count
		const fullContext = contextParts.join("\n\n");
		const size = Buffer.byteLength(fullContext, "utf-8");
		fileLog(`User context loaded: ${size} bytes (${contextParts.length} files)`);

		return {
			context: `<system-reminder>\nPAI CONTEXT (Core Skill + User Context)\n\n${fullContext}\n\n---\nThe PAI Core Skill above is always active. Other skills load on-demand via the skill tool (see available_skills).\n</system-reminder>`,
			filesLoaded: contextParts.length,
		};
	} catch (error) {
		fileLogError("Failed to load user system context", error);
		// Return null to signal failure - caller should handle
		return null;
	}
}
