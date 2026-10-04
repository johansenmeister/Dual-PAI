/**
 * Kontrakt-test: hvilke første meldinger som gir en arbeidsøkt (M-54, K53)
 *
 * `isTrivialMessage` sjekket hilsen- og kvitteringsmønstrene også over 25 tegn,
 * og de var bare forankret i starten. «Ja, kjør gjennom hele kandidatlista og
 * lag én PR per kandidat» ga derfor ingen arbeidsøkt, og PRD-en, tittelen og
 * læringene fra første tur gikk tapt (MÅLT 2026-09-29). Funksjonen hadde ingen
 * tester; samme hull som K23 fant i sikkerhetsvakten: at det trivielle stoppes,
 * sier ingenting om at det meningsfulle slipper gjennom.
 *
 * @module tests/triviell-melding
 */

import { describe, expect, test } from "bun:test";
import { isTrivialMessage } from "../.opencode/pai-core/handlers/work-tracker";

/** Ekte førstemeldinger av den typen brukeren skriver. Hver skal gi en arbeidsøkt. */
const MENINGSFULLE = [
	"Ja, kjør gjennom hele kandidatlista og lag én PR per kandidat",
	"Ok, bygg K48 først og så K51 etterpå, med tester",
	"Klar for neste fase: skriv planen for jobb-harnesset",
	"Nice, men nå må vi også rette launcheren i pai.ts",
	"No wait, the migration must keep the old column around",
	"Thanks, now please add the same check to pai doctor",
	"Jaså, da må vi se på reaperen også før vi merger",
	"Kjør gjennom hele kandidatlista og lag én PR per kandidat",
	"Les docs/dual-harness/handoff.md først, deretter planen",
	"/commit og push grenen når testene er grønne",
];

/** Meldinger som ikke er arbeid. Hver skal stoppes. */
const TRIVIELLE = [
	"ok",
	"Ja",
	"takk!",
	"hei",
	"8",
	"Thanks, sounds good, perfect!!",
	"Okay okay, got it, great, thanks!!",
	"Guten Morgen, hallo, ja, danke!!",
	"9 - bra jobbet med refaktoreringen av launcheren",
	"10/10 — akkurat det jeg trengte i dag, takk",
];

describe("isTrivialMessage (M-54, K53)", () => {
	for (const m of MENINGSFULLE) {
		test(`gir arbeidsøkt: «${m}»`, () => {
			expect(isTrivialMessage(m)).toBe(false);
		});
	}
	for (const m of TRIVIELLE) {
		test(`stoppes: «${m}»`, () => {
			expect(isTrivialMessage(m)).toBe(true);
		});
	}
});
