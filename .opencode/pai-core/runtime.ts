/**
 * PAI Core — kjøretidshjelpere
 *
 * Sesjonsnøkler, kapabiliteter og logging. Importerer ingen motor.
 *
 * @module pai-core/runtime
 */

import { fileLog, fileLogError } from "./lib/file-logger";
import type { Harness, PaiCapabilities } from "./types";

export { fileLog, fileLogError };

/** Motorprefiks i sesjonsnøkkelen. Kort, fordi det havner i hvert filnavn. */
const HARNESS_PREFIX: Record<Harness, string> = {
	opencode2: "o2",
	claude: "cc",
};

/** Alt utenfor dette erstattes, så nøkkelen alltid er et trygt filnavn. */
const UNSAFE_IN_FILENAME = /[^A-Za-z0-9_-]/g;

/**
 * Utled sesjonsnøkkelen som brukes i ALLE filnavn under STATE/.
 *
 * To egenskaper som må holde, og som `tests/session-key.test.ts` låser:
 *
 * 1. Nøkkelen er aldri lik den rå ID-en. Ellers kan en fil skrevet før
 *    innføringen forveksles med en skrevet etter.
 * 2. Samme rå ID under to motorer gir aldri samme nøkkel. To harness deler
 *    MEMORY-tre, og en kollisjon der ville latt den ene overskrive den andres
 *    tilstand uten noe spor.
 *
 * Tom eller manglende ID gir en `unknown`-nøkkel framfor å kaste — kjernen
 * skal aldri velte på en hendelse som mangler felter.
 */
export function sessionKeyFor(harness: Harness, sessionId: string | undefined | null): string {
	const prefix = HARNESS_PREFIX[harness] ?? "xx";
	const raw = typeof sessionId === "string" ? sessionId.trim() : "";
	if (raw.length === 0) {
		return `${prefix}_unknown`;
	}
	return `${prefix}_${raw.replace(UNSAFE_IN_FILENAME, "-")}`;
}

/**
 * Er `kandidat` nøkkelen `sessionKeyFor` gir for denne sesjons-ID-en under
 * EN AV motorene?
 *
 * For lesere som finner en nøkkel på disk og skal handle på den — reaperen
 * sletter meldingsbufferne under nøkkelen. En nøkkel som ikke kan ha kommet
 * fra `sessionKeyFor` med nettopp denne ID-en, skal ikke kunne peke den mot
 * en annen økts filer. `_unknown`-nøkkelen godtas aldri: den er felles
 * skuff for alle økter uten ID.
 */
export function erSessionKeyFor(kandidat: unknown, sessionId: string): kandidat is string {
	if (typeof kandidat !== "string" || sessionId.trim().length === 0) return false;
	return (Object.keys(HARNESS_PREFIX) as Harness[]).some(
		(harness) => sessionKeyFor(harness, sessionId) === kandidat
	);
}

/**
 * Hvilken motor kjører denne prosessen?
 *
 * Leses fra `PAI_HARNESS`, ikke tredd gjennom hver funksjonssignatur. Det er
 * riktig plassering, ikke en snarvei: én prosess er alltid ÉN motor, hele
 * livet. Det er prosess-konfigurasjon på linje med `PAI_HOME` og
 * `PAI_ENABLED` — ikke tilstand som endrer seg underveis, som er det
 * modulvariabler brukes til og som batch 5 nettopp fjernet.
 *
 * Alternativet var å legge `harness` på fire JSONL-skrivere og alt som
 * kaller dem. Det ville gjort signaturene verre uten å gjøre svaret riktigere.
 *
 * Default er `opencode2`, OpenCode-motoren som er igjen etter at v1 ble
 * slettet. Den var `opencode` (v1) til da.
 */
export function currentHarness(): Harness {
	return process.env.PAI_HARNESS?.trim() === "claude" ? "claude" : "opencode2";
}

/**
 * Kapabiliteter per motor.
 *
 * Observability er OpenCode-only etter brukerens beslutning. Voice er fjernet
 * helt — se lib/response-format.ts for linja den parset.
 */
export function capabilitiesFor(harness: Harness): PaiCapabilities {
	return {
		observability: harness === "opencode2",
		// Se PaiCapabilities: gatet på motor, ALDRI på om alias-fila finnes.
		// Den ligger i repoet begge motorene kjører fra.
		agentAliases: harness === "claude",
	};
}
