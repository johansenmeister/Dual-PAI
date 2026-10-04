/**
 * PAI-OpenCode Time Utilities
 *
 * Time formatting functions for consistent timestamps across handlers.
 * Ported from PAI v2.5 hooks/lib/time.ts
 *
 * @module time
 */

import { getPrincipal } from "./identity";

/**
 * Get ISO timestamp (UTC)
 * Format: 2026-02-02T14:30:00.000Z
 */
export function getISOTimestamp(): string {
	return new Date().toISOString();
}

/**
 * Tidssonen PAI skal skrive MEMORY i.
 *
 * **M-01, åpen siden registeret ble startet:** `principal.timezone` i
 * `settings.json` ble aldri lest. M-25 byttet den hardkodede
 * `America/Los_Angeles` til maskinens lokaltid, men lot fortsatt den
 * konfigurerte sonen ligge ubrukt — halve defekten.
 *
 * Rekkefølgen er: konfigurert sone → maskinens egen. `getPrincipal()`
 * defaulter til `"UTC"`, så et oppsett som ikke har valgt noe får UTC, og
 * det er et bevisst valg i `identity.ts` — ikke noe denne fila skal
 * overstyre.
 *
 * En ugyldig sone faller tilbake på maskinen framfor å kaste. En
 * feilskrevet `settings.json` skal ikke kunne stoppe en hook.
 */
function sone(): string | undefined {
	try {
		const tz = getPrincipal().timezone?.trim();
		if (!tz) return undefined;
		// Kaster på ukjent sone; da er `undefined` = maskinens egen.
		new Intl.DateTimeFormat("sv-SE", { timeZone: tz });
		return tz;
	} catch {
		return undefined;
	}
}

/**
 * Tid i PAIs konfigurerte sone, som ISO-lignende streng uten soneangivelse.
 * Format: 2026-02-02T14:30:00
 *
 * **M-25: het `getPSTTimestamp` og var hardkodet til `America/Los_Angeles`.**
 * Det er arvet fra oppstrøms-PAI, som er amerikansk. På en maskin i Norge ga
 * det MEMORY-filer med tidsstempler ni timer bak veggklokka — en fangst
 * skrevet 00:00:51 lokal tid fikk navnet `2026-09-22-150051` og
 * `timestamp: 2026-09-22T15:00:51`, altså feil både på klokkeslett OG dato.
 *
 * Det gjorde ikke bare navnene rare. `getYearMonth()` under bruker LOKAL tid
 * til å velge månedskatalogen, så en fangst kunne havne i `2026-09/` med
 * `2026-08-…` i filnavnet. Kronologien i læringstreet var ikke til å stole på.
 *
 * `sv-SE` beholdes som locale fordi den formaterer som `YYYY-MM-DD HH:MM:SS`
 * — nærmest ISO av alle — men sonen er nå maskinens egen.
 */
export function getLocalTimestamp(): string {
	return new Date()
		.toLocaleString("sv-SE", {
			timeZone: sone(),
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})
		.replace(" ", "T");
}

/**
 * Lokal dato på maskinen.
 * Format: 2026-02-02
 */
export function getLocalDate(): string {
	return getLocalTimestamp().slice(0, 10);
}

/**
 * Get year-month string
 * Format: 2026-02
 *
 * **M-26, lukket:** denne valgte månedskatalogen ut fra maskinens lokale tid
 * mens filnavnet kom fra en annen kilde. Rundt et månedsskifte kunne en fangst
 * derfor havne i `2026-09/` med `2026-08-…` i navnet. Begge leser nå `sone()`,
 * så de KAN ikke divergere — en test låser det.
 *
 * `getDateString()` og `getFilenameTimestamp()` under er fortsatt UTC. De
 * brukes til andre ting enn MEMORY-plassering; blandes de inn her, endres
 * navnene på eksisterende arbeidsøktkataloger.
 */
export function getYearMonth(): string {
	return getLocalDate().slice(0, 7);
}

/**
 * Get date string (YYYY-MM-DD)
 */
export function getDateString(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Get timestamp for filenames (no special chars)
 * Format: 2026-02-02-143000
 */
export function getFilenameTimestamp(): string {
	const now = new Date();
	const date = now.toISOString().slice(0, 10);
	const time = now.toISOString().slice(11, 19).replace(/:/g, "");
	return `${date}-${time}`;
}

/**
 * Get human-readable duration from milliseconds
 */
export function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		return `${hours}h ${minutes % 60}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds % 60}s`;
	}
	return `${seconds}s`;
}

/**
 * Get relative time string (e.g., "2 hours ago")
 */
export function getRelativeTime(date: Date | string): string {
	const now = new Date();
	const then = typeof date === "string" ? new Date(date) : date;
	const diffMs = now.getTime() - then.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
	if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
	if (diffMins > 0) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
	return "just now";
}
