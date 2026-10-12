/**
 * Oppstartsvarsler: tall fra et lokalt speil som brukeren skal se ved øktstart
 *
 * Første bruk er problemloggen i GLPI (#14 steg 2): saker med status 5 Løst
 * venter på at brukeren lukker dem, og ingenting minnet om det. Tallet telles
 * fra markdown-speilet på disken, ikke fra API-et, så oppstarten ikke venter
 * på nettet.
 *
 * Konfigen ligger i en sporet fil under `PAI/USER/`, av samme grunn som
 * `SKRIVEBESKYTTET.json`: den følger bundelen til jobbmaskinene, og hjemme
 * finnes den ikke. Kjernen kjenner verken GLPI eller stiene (M-29).
 *
 * ```json
 * { "varsler": [{
 *   "katalog": "~/repos/example-work-docs/glpi",
 *   "linje": "^status: løst$",
 *   "tekst": "Løste GLPI-saker som venter på at du lukker dem: {n}"
 * }] }
 * ```
 *
 * Hver `.md` under `katalog` (rekursivt, utenom `.git`) som har en linje som
 * treffer `linje`, teller én. Er tallet 0, kommer ingen linje: et varsel som
 * alltid står, er et varsel ingen leser. Manglende fil, ugyldig JSON, en
 * relativ sti eller en ugyldig regex gir ingen varsler og aldri et kast.
 *
 * @module oppstartsvarsel
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getHomePaiDir } from "./paths";
import { ekspander } from "./skrivebeskyttet";

/** Relativt til PAI-treet (`~/.opencode`). */
export const OPPSTARTSVARSEL_FIL = join("PAI", "USER", "OPPSTARTSVARSEL.json");

interface Varsel {
	katalog: string;
	linje: RegExp;
	tekst: string;
}

function lesKonfig(paiDir: string): Varsel[] {
	const fil = join(paiDir, OPPSTARTSVARSEL_FIL);
	if (!existsSync(fil)) return [];
	try {
		const data: unknown = JSON.parse(readFileSync(fil, "utf-8"));
		const liste = (data as { varsler?: unknown } | null)?.varsler;
		if (!Array.isArray(liste)) return [];
		const ut: Varsel[] = [];
		for (const v of liste) {
			const { katalog, linje, tekst } = (v ?? {}) as Record<string, unknown>;
			if (typeof katalog !== "string" || typeof linje !== "string" || typeof tekst !== "string") continue;
			const k = katalog.trim();
			// En relativ sti ville løst seg mot prosessens cwd og betydd noe nytt i hver økt.
			if (!(k === "~" || k.startsWith("~/") || isAbsolute(k))) continue;
			try {
				ut.push({ katalog: ekspander(k), linje: new RegExp(linje, "m"), tekst });
			} catch {
				// Ugyldig regex: hopp over dette varselet, ikke de andre.
			}
		}
		return ut;
	} catch {
		return [];
	}
}

/** `.md`-filene under `rot`, rekursivt, utenom `.git`. */
function markdownfiler(rot: string): string[] {
	const ut: string[] = [];
	const gå = (katalog: string): void => {
		let oppføringer: Dirent[];
		try {
			oppføringer = readdirSync(katalog, { withFileTypes: true });
		} catch {
			return;
		}
		for (const o of oppføringer) {
			if (o.name === ".git") continue;
			const sti = join(katalog, o.name);
			if (o.isDirectory()) gå(sti);
			else if (o.isFile() && o.name.endsWith(".md")) ut.push(sti);
		}
	};
	gå(rot);
	return ut;
}

/** Antall filer under `katalog` med en linje som treffer `linje`. */
export function tell(katalog: string, linje: RegExp): number {
	let n = 0;
	for (const fil of markdownfiler(katalog)) {
		try {
			if (linje.test(readFileSync(fil, "utf-8"))) n++;
		} catch {
			// En fil som forsvant mellom readdir og read, teller ikke.
		}
	}
	return n;
}

/** Én linje per varsel med tall over 0, med `{n}` byttet ut. Tom ellers. */
export function oppstartsvarsler(paiDir: string = getHomePaiDir()): string[] {
	const linjer: string[] = [];
	for (const v of lesKonfig(paiDir)) {
		if (!existsSync(v.katalog)) continue;
		const n = tell(v.katalog, v.linje);
		if (n > 0) linjer.push(v.tekst.replaceAll("{n}", String(n)));
	}
	return linjer;
}
