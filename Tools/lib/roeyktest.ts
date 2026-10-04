/**
 * Felles for røyktestene (`Tools/ClaudeSmoke.ts`, `Tools/V2Smoke.ts`)
 *
 * NYTT FORSØK (K7). En sjekk som krever at modellen gjorde et kall, blir rød
 * når modellen lar være, og det ser likt ut som en regresjon: `V2Smoke` var rød
 * i fire av seks kjøringer 2026-09-26 og 2026-09-28 uten at noe var galt.
 * `medNyttForsøk` kjører steget én gang til når kallene mangler, og aldri når
 * de ble gjort: da er utfallet det som måles, og et rødt utfall er rødt.
 *
 * RAPPORTEN (K43). En rød `ClaudeSmoke` i jobbtreet mistet hvilken sjekk som
 * falt, fordi utskriften ble kuttet og rapporten bare sto i terminalen.
 * `Utskrift` holder alt røyktesten skriver, og en rød kjøring skriver det til
 * `rapport.txt` i arbeidskatalogen.
 *
 * DEN RØDE VEIEN (K46). Exitkoden alene holdt ikke: gjennom launcheren var den
 * alltid 0 (M-51), og Claude Code gir exit 0 med `is_error: true` når API-et
 * feiler etter kallet ([anthropics/claude-code#79500](https://github.com/anthropics/claude-code/issues/79500)).
 * `stegFeil` tar begge, og `--rød` i begge røyktestene prøver veien med en
 * modell som ikke finnes: begge motorene avviser den før API-kallet, med exit 1
 * og feilen i strømmen (MÅLT 2026-10-01, Claude Code 2.1.283 og v2 2.0.18).
 *
 * MERKNADENE (K55). En grønn sjekk kan ha noe verdt å vite, som en ny nøkkel i
 * et verktøykall (K54). `merknaderFra` samler dem til kvitteringen, så de står i
 * git-diffen ved neste bump og ikke forsvinner med terminalen.
 *
 * @module Tools/lib/roeyktest
 */

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Kvittering } from "../../.opencode/PAI/Tools/selvtest";

/** Det røyktesten skriver, i terminalen og i minnet. */
export class Utskrift {
	private readonly linjer: string[] = [];

	log(tekst = ""): void {
		console.log(tekst);
		this.linjer.push(tekst);
	}

	feil(tekst: string): void {
		console.error(tekst);
		this.linjer.push(tekst);
	}

	/** Bare i rapporten: det som er for langt for terminalen, som hele stderr. */
	bareIRapport(tekst: string): void {
		this.linjer.push(tekst);
	}

	/**
	 * Skriv alt til `<dir>/rapport.txt`, med hver hemmelighet byttet ut, og gi
	 * stien. En tom hemmelighet hoppes over: `replaceAll("")` ville satt
	 * erstatningen mellom hvert tegn.
	 */
	skriv(dir: string, hemmeligheter: readonly string[] = []): string {
		let tekst = `${this.linjer.join("\n")}\n`;
		for (const h of hemmeligheter) if (h) tekst = tekst.replaceAll(h, "***");
		const sti = join(dir, "rapport.txt");
		writeFileSync(sti, tekst);
		return sti;
	}
}

/** Et steg som ble kjørt på nytt, og kallene modellen ikke gjorde første gang. */
export interface Omkjøring {
	steg: string;
	uprøvd: string[];
}

export interface Steg {
	/** Arbeidskatalogen. */
	w: string;
	/** Prefikset stegets filer har i arbeidskatalogen (`vakt` for `vakt.log`, `vakt.jsonl`). */
	fil: string;
	/** Slik steget heter i utskriften («steg v»). */
	etikett: string;
	ut: Utskrift;
	/** Fylles med stegene som ble kjørt på nytt, for rapporten. */
	omkjørt: Omkjøring[];
}

/**
 * Kjør et steg, og én gang til når `uprøvd` sier at modellen ikke gjorde et
 * kall steget måler. Ikke mer enn én gang: gjør modellen det ikke da heller,
 * er prompten eller modellen feil, og det skal bli rødt.
 *
 * Exitkoden avgjør ikke: `run` avslår når modellen går utenfor katalogen
 * (`external_directory`), og til 2.0.19 avsluttet det hele kjøringen med exit 1
 * før kallene var gjort (fra 2.0.20 fortsetter modellen, #153). Den som kaller,
 * sjekker exitkoden på forsøket som gjaldt.
 *
 * Første forsøks filer får navnet `<fil>.forsøk1.<resten>` før det nye, så det
 * som leser `<fil>.*` etterpå, leser forsøket som gjaldt, og det første står
 * igjen til diagnose.
 */
export async function medNyttForsøk<K>(s: Steg, kjør: () => Promise<K>, uprøvd: (k: K) => string[]): Promise<K> {
	const første = await kjør();
	const mangler = uprøvd(første);
	if (mangler.length === 0) return første;
	s.ut.log(`  ${s.etikett}: modellen kalte ikke ${mangler.join(", ")}, kjører steget på nytt én gang`);
	s.omkjørt.push({ steg: s.etikett, uprøvd: mangler });
	for (const navn of readdirSync(s.w)) {
		if (navn.startsWith(`${s.fil}.`)) {
			renameSync(join(s.w, navn), join(s.w, `${s.fil}.forsøk1.${navn.slice(s.fil.length + 1)}`));
		}
	}
	return kjør();
}

/**
 * Hvorfor et steg er rødt, eller `undefined` når det er grønt (K46).
 * `strømfeil` er feilen motoren selv meldte i strømmen: `is_error` i Claudes
 * `result`, en `error`-hendelse i v2s. Den gjør steget rødt også ved exit 0.
 */
export function stegFeil(k: { exitCode: number | null; tidsavbrudd: boolean }, strømfeil?: string): string | undefined {
	const exit = `exit ${k.exitCode}${k.tidsavbrudd ? ", tidsavbrudd" : ""}`;
	if (k.exitCode !== 0 || k.tidsavbrudd) return strømfeil ? `${exit}: ${strømfeil}` : exit;
	return strømfeil ? `${exit}, men ${strømfeil}` : undefined;
}

/** Modellen `--rød` kjører med. Finnes ikke hos noen leverandør. */
export const UKJENT_MODELL = "finnes-ikke-modell";

/**
 * Sjekkene `--rød` gjør på første steg, kjørt med `UKJENT_MODELL` (K46): et
 * nytt forsøk, exit ≠ 0 og ikke bare `is_error` (ellers ville M-51 sluppet
 * gjennom), og `rapport.txt` med stegets stderr (K43).
 */
export function rødVeiSjekker(
	steg: string,
	k: { exitCode: number | null },
	feil: string | undefined,
	omkjørt: readonly Omkjøring[],
	rapport: string
): { navn: string; ok: boolean; detalj: string }[] {
	const tekst = existsSync(rapport) ? readFileSync(rapport, "utf-8") : "";
	return [
		{
			navn: `${steg} ble kjørt på nytt, fordi modellen ikke gjorde kallene (K7)`,
			ok: omkjørt.some((o) => o.steg === steg),
			detalj: omkjørt.length > 0 ? omkjørt.map((o) => o.steg).join(", ") : "ingen steg kjørt på nytt",
		},
		{ navn: `${steg} ble rødt`, ok: feil !== undefined, detalj: feil ?? "grønt" },
		{ navn: `${steg} ga exit ≠ 0 (M-51)`, ok: k.exitCode !== 0, detalj: `exit ${k.exitCode}` },
		{
			navn: `rapport.txt har hele stderr fra ${steg} (K43)`,
			ok: tekst.includes(`Hele stderr fra ${steg}:`),
			detalj: tekst ? "stderr mangler i rapporten" : `fant ikke ${rapport}`,
		},
	];
}

/** Merknadene fra sjekkene, i rekkefølge og uten dubletter. Tom når ingen har en. */
export function merknaderFra(sjekker: readonly { merknad?: string }[]): string[] {
	return [...new Set(sjekker.flatMap((s) => (s.merknad ? [s.merknad] : [])))];
}

/**
 * Kvitteringen en grønn røyktest skriver (K4, K13, K36, K55). Felles for begge,
 * så merknadene ikke kan falle ut av den ene uten at en test ser det.
 */
export function lagKvittering(
	versjon: string,
	hooks: number,
	sjekker: readonly { merknad?: string }[],
	adapter?: string | null,
	dato = new Date().toLocaleDateString("sv-SE")
): Kvittering {
	const merknader = merknaderFra(sjekker);
	return {
		versjon,
		dato,
		hooks,
		sjekker: sjekker.length,
		...(adapter ? { adapter } : {}),
		...(merknader.length > 0 ? { merknader } : {}),
	};
}

/** Linjene rapporten får om stegene som ble kjørt på nytt. Tom når ingen ble det. */
export function omkjøringslinjer(omkjørt: readonly Omkjøring[]): string[] {
	if (omkjørt.length === 0) return [];
	return ["", "  Kjørt på nytt (K7):", ...omkjørt.map((o) => `  ↻ ${o.steg}: modellen kalte ikke ${o.uprøvd.join(", ")} første gang`)];
}
