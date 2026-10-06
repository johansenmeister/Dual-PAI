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

/** Så mange læringer står i indeksen; resten er eldre og finnes med `ls`. */
const LÆRINGSINDEKS_MAKS = 30;

/**
 * Læringskatalogen, løst som `PAI_DIR` over: `PAI_HOME` når den er satt
 * (testene, Claude-hooken), ellers treet koden ble lastet fra. `getLearningDir()`
 * prøver cwd først, og launcheren setter ikke `PAI_HOME`.
 */
function læringskatalog(): string {
	const hjem = process.env.PAI_HOME?.trim() || path.join(PAI_DIR, "..");
	return path.join(hjem, "MEMORY", "LEARNING");
}

/**
 * Indeks over de håndskrevne læringene (#315)
 *
 * En læring i `MEMORY/LEARNING/` nådde aldri en ny økt: ingenting i
 * konteksten leste katalogen, og README-ens «learning readback» fantes ikke
 * etter porten. På jobb gjentok en økt en feil som en læring fra 2026-09-15
 * beskrev. Indeksen gir én linje per læring, nyeste først, med tittelen og
 * stien, så modellen kan åpne dem som angår oppgaven.
 *
 * Bare filene rett i katalogen: det er dem modellen skriver selv. Under-
 * katalogene (`ALGORITHM/`, `SYSTEM/` …) fylles av fangsten automatisk, er
 * mange og sier lite hver.
 */
export function læringsindeks(katalog: string = læringskatalog()): string | null {
	let navn: string[];
	try {
		navn = fs.readdirSync(katalog).filter((n) => n.endsWith(".md"));
	} catch {
		return null;
	}
	const rader = navn
		.map((n) => {
			const fil = path.join(katalog, n);
			let tekst = "";
			let mtime = 0;
			try {
				const stat = fs.statSync(fil);
				if (!stat.isFile()) return null;
				mtime = stat.mtimeMs;
				tekst = fs.readFileSync(fil, "utf-8").slice(0, 1024);
			} catch {
				return null;
			}
			const dato = n.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? new Date(mtime).toISOString().slice(0, 10);
			const tittel = tekst.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? n.replace(/\.md$/, "");
			return { dato, n, linje: `- ${dato} ${tittel} (${fil})` };
		})
		.filter((r): r is { dato: string; n: string; linje: string } => r !== null)
		.sort((a, b) => b.dato.localeCompare(a.dato) || b.n.localeCompare(a.n));
	if (rader.length === 0) return null;
	const viste = rader.slice(0, LÆRINGSINDEKS_MAKS).map((r) => r.linje);
	if (rader.length > LÆRINGSINDEKS_MAKS) {
		viste.push(`- … ${rader.length - LÆRINGSINDEKS_MAKS} older in ${katalog}`);
	}
	return [
		"Lessons written in earlier sessions, newest first. Before acting on a task, open those whose title touches it, or the kind of step you are about to take: they record mistakes that must not repeat.",
		...viste,
	].join("\n");
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
 * 3. An index of the hand-written learnings in MEMORY/LEARNING/
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

		// 3. Indeks over læringene fra tidligere økter (#315)
		const indeks = læringsindeks();
		if (indeks) {
			contextParts.push(`--- Learnings from earlier sessions ---\n${indeks}`);
			fileLog("Loaded the learning index from MEMORY/LEARNING");
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
