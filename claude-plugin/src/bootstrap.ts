/**
 * Claude-adapter — oppstartsvakt
 *
 * Side-effect-modul. Den MÅ importeres først i `bin/pai-hook.ts`, før noe
 * annet, fordi den setter miljøet de andre modulene leser.
 *
 * ESM evaluerer importer i rekkefølge, så en import på førsteplass kjører
 * før kroppen til alt som står under den. Det er hele mekanismen — flyttes
 * linja ned, virker den ikke lenger, og ingenting feiler synlig.
 *
 * Fire ting settes opp her:
 *
 *   1. `console.*` omdirigeres til fileLog. **stdout er protokollen.**
 *   2. `PAI_HARNESS=claude`, som avgjør loggfil og `harness:`-feltet i JSONL.
 *   3. `PAI_HOME`, utledet fra plugin-roten når den ikke er satt.
 *   4. `PAI_OWNER_PID`, som er det reaperen sjekker liveness på.
 *
 * @module claude-plugin/bootstrap
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileLog, fileLogError } from "../../.opencode/pai-core/lib/file-logger";
import { finnMotorprosess } from "./owner";

export { fileLog, fileLogError };

// === 1. STDOUT ER PROTOKOLLEN ===
//
// Strengere enn OpenCode-sidens «aldri console.log». Der ødelegger en
// feilplassert utskrift TUI-en, som er synlig. Her ødelegger den
// JSON-parsingen av hook-svaret, og Claude Code rapporterer det som en
// generisk hook-feil uten å si hvilken byte som var for mye.
//
// Ingen av handlerne i kjernen bruker console i dag (målt: kun i
// kommentarer). Shimmen finnes for den som legger til én senere — den skal
// havne i loggen, ikke i protokollen.
for (const nivå of ["log", "info", "warn", "error", "debug", "trace"] as const) {
	const merkelapp = nivå.toUpperCase();
	console[nivå] = (...args: unknown[]) => {
		try {
			fileLog(
				`[console.${merkelapp}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`,
				"warn"
			);
		} catch {
			// En logger som kaster skal ikke kunne velte en hook.
		}
	};
}

// === 2. HVILKEN MOTOR ===
//
// Settes ubetinget, som OpenCode-adapteren gjør. `getLogFilePath()` leser
// variabelen ved hvert kall, så dette må stå før første fileLog — ellers
// skriver de to motorene i samme fil, og `clearLog()` i den ene sletter den
// andres logg midt i en økt.
process.env.PAI_HARNESS = "claude";

// === 3. HVOR PAI-TREET LIGGER ===
//
// `getPaiHome()` prøver `cwd/.opencode` og deretter `$HOME/.opencode`. Under
// OpenCode er cwd alltid repoet; under Claude Code er cwd det prosjektet
// brukeren jobber i, og det er som regel ikke dette repoet. Da ville PAI
// skrevet MEMORY inn i et tilfeldig prosjekt.
//
// Plugin-roten vet svaret: `claude-plugin/` ligger ved siden av `.opencode/`
// i samme repo. `CLAUDE_PLUGIN_ROOT` er MÅLT til å peke på den ekte
// katalogen — `--plugin-dir` verken kopierer eller lenker (2026-09-21).
if (!process.env.PAI_HOME?.trim()) {
	const pluginRot = process.env.CLAUDE_PLUGIN_ROOT?.trim() || resolve(import.meta.dir, "..");
	const kandidat = join(dirname(pluginRot), ".opencode");
	if (existsSync(kandidat)) {
		process.env.PAI_HOME = kandidat;
	}
}

// === 4. HVEM EIER ARBEIDSØKTEN ===
//
// Claude Code kjører ÉN PROSESS PER HOOK-EVENT. Denne prosessen er død
// millisekunder etter at den svarer. Skrev vi dens PID i
// `current-work-<sid>.json`, ville neste `SessionStart` sett en død eier og
// reapet en økt brukeren fortsatt sitter i — den dyreste feilen reaperen kan
// gjøre, og grunnen til at `isOwnerAlive` er fail-safe i den retningen den er.
//
// Eieren er motorprosessen, ikke vår egen. `ownerProcess()` i kjernen leser
// disse to variablene; uten dem faller den tilbake på `process.pid`, som er
// riktig for OpenCode og katastrofalt her.
const eier = finnMotorprosess();
if (eier) {
	process.env.PAI_OWNER_PID = String(eier.pid);
	if (eier.start) process.env.PAI_OWNER_PID_START = eier.start;
} else {
	// «Jeg fant ingen eier jeg stoler på.» Kjernen skriver da INGEN pid, og
	// `isOwnerAlive` faller tilbake på alderssjekken — treg, men trygg. Å
	// skrive en PID vi vet er død ville vært verre enn å ikke skrive noen.
	process.env.PAI_OWNER_PID = "ukjent";
	fileLog("[bootstrap] Fant ingen motorprosess i slekten — arbeidsøkten skrives uten pid", "warn");
}
