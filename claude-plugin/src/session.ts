/**
 * Claude-adapter — hvilken økt kjører denne MCP-serveren i?
 *
 * MCP-protokollen bærer ingen sesjons-ID, og Claude Code sender ingen.
 * OpenCodes `tool()` får en `ToolContext` med `sessionID`; her finnes ikke
 * motstykket. Verktøyene leser per-økt-tilstand, så uten ID-en er de blinde.
 *
 * Tre lag, i rekkefølge, og hvert lag er svakere enn det over:
 *
 *   1. FORELDERENS PID. MÅLT 2026-09-22: MCP-serveren er et DIREKTE barn av
 *      motorprosessen — `dybde=0 comm=bun`, `dybde=1 comm=claude`. Og
 *      `SessionStart` kjenner både sesjons-ID-en og motorens pid, så den
 *      legger igjen en peker i `STATE/sessions/by-ppid/<pid>.json`.
 *      Dette er det normale tilfellet og det eneste eksakte.
 *
 *   2. EKSPLISITT ARGUMENT. Hvert verktøy tar et valgfritt `session_id`.
 *      Modellen kan oppgi det når den vet bedre — ID-en står i konteksten
 *      `SessionStart` injiserer.
 *
 *   3. ARBEIDSKATALOG. Nyeste peker med samme `cwd`. To samtidige økter i
 *      samme katalog kan ikke skilles slik, og det er derfor dette er siste
 *      utvei og ikke første.
 *
 * Finner ingen av dem noe, svarer verktøyet «vet ikke». Å gjette ville gitt
 * et selvsikkert svar om FEIL økts subagenter, og det er verre enn tomhånds.
 *
 * @module claude-plugin/session
 */

import { readFileSync } from "node:fs";
import {
	finnSesjonForKatalog,
	finnSesjonForProsess,
} from "../../.opencode/pai-core/lib/session-pointer";

/**
 * Plukk ppid ut av en `/proc/<pid>/stat`-linje.
 *
 * Egen, ren funksjon fordi den er den eneste delen som kan være SUBTILT
 * feil. Formatet er `pid (comm) state ppid …`, og `comm` kan inneholde både
 * mellomrom og parenteser — et program kan hete `my (weird) name`. Splitter
 * man linja rått på mellomrom, treffer man likevel riktig for `bun` og
 * `claude`, så feilen er usynlig helt til noe heter noe annet.
 *
 * Det er nøyaktig den fellen en mutasjonstest mot den ekte prosessen IKKE
 * fanger, og grunnen til at denne tar en streng framfor å lese fila selv.
 */
export function ppidFraStat(stat: string): number | null {
	const slutt = stat.lastIndexOf(")");
	if (slutt === -1) return null;
	// Etter «) » kommer state, så ppid.
	const felt = stat.slice(slutt + 2).trim().split(/\s+/);
	const ppid = Number(felt[1]);
	return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
}

/** Forelderens pid, lest ut av `/proc/<pid>/stat`. */
export function forelderPid(pid = process.pid): number | null {
	try {
		return ppidFraStat(readFileSync(`/proc/${pid}/stat`, "utf-8"));
	} catch {
		return null;
	}
}

export interface SesjonsOppslag {
	sessionId: string | null;
	/** Hvilket lag som svarte. Går alltid med i loggen, så en feil ID kan spores. */
	kilde: "argument" | "forelder" | "katalog" | "ukjent";
}

/**
 * Slå opp øktens ID.
 *
 * @param eksplisitt `session_id` fra verktøykallet, hvis modellen oppga det.
 */
export function finnSesjon(eksplisitt?: string): SesjonsOppslag {
	// Lag 2 først når den er oppgitt: en modell som sier hvilken økt den
	// mener, vet noe vi ikke kan utlede.
	if (eksplisitt && eksplisitt.trim() !== "") {
		return { sessionId: eksplisitt.trim(), kilde: "argument" };
	}

	const ppid = forelderPid();
	if (ppid !== null) {
		const fraPeker = finnSesjonForProsess(ppid);
		if (fraPeker) return { sessionId: fraPeker, kilde: "forelder" };
	}

	const fraKatalog = finnSesjonForKatalog(process.cwd());
	if (fraKatalog) return { sessionId: fraKatalog, kilde: "katalog" };

	return { sessionId: null, kilde: "ukjent" };
}
