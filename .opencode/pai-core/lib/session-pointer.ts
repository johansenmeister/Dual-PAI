/**
 * PAI Core — hvilken økt tilhører denne prosessen?
 *
 * PROBLEMET: MCP-serveren har ingen sesjons-ID. OpenCodes `tool()` får en
 * `ToolContext` med `sessionID`; MCP-protokollen har ingen motsvarighet, og
 * Claude Code sender den ikke. Verktøyene våre leser per-økt-tilstand
 * (`subagent-registry-<sid>.json`), så uten ID-en er de blinde.
 *
 * LØSNINGEN hviler på en MÅLING (2026-09-22): MCP-serveren er et DIREKTE
 * barn av motorprosessen.
 *
 *   dybde=0 pid=68443 comm=bun     ← MCP-serveren
 *   dybde=1 pid=68419 comm=claude  ← MOTOREN
 *
 * Hookene har `sh` og `bash` imellom og må lete oppover (se
 * `claude-plugin/src/owner.ts`); her holder det med forelderen. Og siden
 * `SessionStart` kjenner BÅDE sesjons-ID-en og motorens pid, kan den legge
 * igjen en peker som serveren slår opp i.
 *
 * Pekeren er en fil og ikke en miljøvariabel med vilje: MCP-serveren startes
 * av motoren på et tidspunkt vi ikke styrer, og en variabel satt etterpå
 * ville aldri nådd den.
 *
 * @module pai-core/lib/session-pointer
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileLog } from "./file-logger";
import { getStateDir, readProcessStart } from "./paths";

/** Pekere eldre enn dette er etterlatt av en motor som døde uten teardown. */
const MAKS_ALDER_MS = 24 * 60 * 60 * 1000;

export interface SesjonsPeker {
	sessionId: string;
	/** Motorprosessens pid — filnavnet, gjentatt for lesbarhet. */
	enginePid: number;
	/** Felt 22 fra `/proc/<pid>/stat`. Skiller en gjenbrukt pid fra den opprinnelige. */
	engineStart: string | null;
	cwd: string;
	at: number;
}

function pekerKatalog(): string {
	return join(getStateDir(), "sessions", "by-ppid");
}

function pekerFil(pid: number): string {
	return join(pekerKatalog(), `${pid}.json`);
}

/**
 * Legg igjen pekeren. Kalles fra `session.start`.
 *
 * @param enginePid Motorprosessen, som adapteren allerede har funnet for
 *   eierskapssporingen. Er den ukjent, skrives ingenting — en peker med feil
 *   pid er verre enn ingen, siden serveren da ville lest en annen økts data.
 */
export function skrivSesjonsPeker(sessionId: string, enginePid: number | undefined, cwd: string): void {
	if (!sessionId || sessionId === "unknown" || !enginePid) return;
	try {
		mkdirSync(pekerKatalog(), { recursive: true });
		const peker: SesjonsPeker = {
			sessionId,
			enginePid,
			engineStart: readProcessStart(enginePid),
			cwd,
			at: Date.now(),
		};
		// Temp + rename, som resten av STATE. To økter kan starte samtidig.
		const mål = pekerFil(enginePid);
		const temp = `${mål}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(peker, null, 2), "utf-8");
		renameSync(temp, mål);
		fileLog(`[SesjonsPeker] ${sessionId} ← pid ${enginePid}`, "debug");
	} catch (error) {
		// Ikke-blokkerende: uten peker faller MCP-serveren tilbake på cwd.
		fileLog(`[SesjonsPeker] Kunne ikke skrive: ${String(error)}`, "warn");
	}
}

/** Fjern pekeren. Kalles fra `session.end`. */
export function fjernSesjonsPeker(enginePid: number | undefined): void {
	if (!enginePid) return;
	try {
		if (existsSync(pekerFil(enginePid))) unlinkSync(pekerFil(enginePid));
	} catch {
		// Reaperen tar den. En peker som blir liggende er ufarlig så lenge
		// `engineStart` gjør en gjenbrukt pid synlig.
	}
}

function les(sti: string): SesjonsPeker | null {
	try {
		return JSON.parse(readFileSync(sti, "utf-8")) as SesjonsPeker;
	} catch {
		return null;
	}
}

/**
 * Finn øktens ID for en prosess.
 *
 * @param pid Prosessen som spør — normalt MCP-serverens egen. Forelderen er
 *   motoren (målt), så det er DEN vi slår opp.
 * @param parentPid Forelderen, hvis kalleren allerede kjenner den.
 * @returns `null` når ingen peker matcher. Da skal kalleren si «vet ikke»
 *   framfor å gjette — å lese feil økts register er å svare selvsikkert på
 *   feil spørsmål.
 */
export function finnSesjonForProsess(parentPid: number): string | null {
	const peker = les(pekerFil(parentPid));
	if (!peker) return null;

	// En pid kan være gjenbrukt av operativsystemet. Starttiden avslører det,
	// og uten sjekken ville en ny prosess arvet en død økts identitet.
	if (peker.engineStart !== null) {
		const nå = readProcessStart(parentPid);
		if (nå !== null && nå !== peker.engineStart) {
			fileLog(`[SesjonsPeker] pid ${parentPid} er gjenbrukt — peker forkastet`, "warn");
			return null;
		}
	}
	return peker.sessionId;
}

/**
 * Siste utvei: finn den nyeste pekeren som deler arbeidskatalog.
 *
 * Brukes kun når ppid-oppslaget bommer. To samtidige økter i SAMME katalog
 * kan ikke skilles slik — da vinner den nyeste, og det er et bevisst
 * kompromiss framfor å svare ingenting i det vanlige tilfellet.
 */
export function finnSesjonForKatalog(cwd: string): string | null {
	try {
		const katalog = pekerKatalog();
		if (!existsSync(katalog)) return null;
		let beste: SesjonsPeker | null = null;
		for (const navn of readdirSync(katalog)) {
			if (!navn.endsWith(".json")) continue;
			const peker = les(join(katalog, navn));
			if (!peker || peker.cwd !== cwd) continue;
			if (Date.now() - peker.at > MAKS_ALDER_MS) continue;
			if (!beste || peker.at > beste.at) beste = peker;
		}
		return beste?.sessionId ?? null;
	} catch {
		return null;
	}
}

/** Rydd pekere etter motorer som ikke finnes lenger. Kalles fra reaperen. */
export function ryddPekere(): number {
	let ryddet = 0;
	try {
		const katalog = pekerKatalog();
		if (!existsSync(katalog)) return 0;
		for (const navn of readdirSync(katalog)) {
			if (!navn.endsWith(".json")) continue;
			const sti = join(katalog, navn);
			const peker = les(sti);
			const forGammel = peker ? Date.now() - peker.at > MAKS_ALDER_MS : true;
			// Lever prosessen fortsatt, og med samme starttid? Da står pekeren.
			const lever =
				peker !== null &&
				readProcessStart(peker.enginePid) !== null &&
				(peker.engineStart === null || readProcessStart(peker.enginePid) === peker.engineStart);
			if (!lever || forGammel) {
				unlinkSync(sti);
				ryddet++;
			}
		}
	} catch {
		// Ryddejobb. Feiler den, prøver neste økt igjen.
	}
	return ryddet;
}
