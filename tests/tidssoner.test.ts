/**
 * Kontrakt-test for tidsstempler i MEMORY (M-25)
 *
 * PAI skrev MEMORY-tidsstempler i **amerikansk Pacific-tid** på en maskin i
 * Norge. En fangst skrevet 00:00:51 lokalt fikk navnet `2026-09-22-150051`
 * og `timestamp: 2026-09-22T15:00:51` — feil både på klokkeslett og dato.
 *
 * Verre: `getYearMonth()` velger månedskatalogen ut fra LOKAL tid. En fangst
 * kunne derfor havne i `2026-09/` med `2026-08-…` i filnavnet, og
 * kronologien i læringstreet var ikke til å stole på.
 *
 * Tre steder hadde hver sin kopi — `lib/time.ts`, `RelationshipReflect.ts`
 * og `FailureCapture.ts`. De to siste brukte i tillegg idiomet
 * `new Date(d.toLocaleString('en-US', {timeZone}))`, som re-parser en
 * formatert streng som lokaltid og dermed forskyver TO ganger.
 *
 * @module tests/tidssoner
 */

import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getPrincipal } from "../.opencode/pai-core/lib/identity";
import { getLocalDate, getLocalTimestamp, getYearMonth } from "../.opencode/pai-core/lib/time";

const REPO = join(import.meta.dir, "..");

function samleTs(katalog: string, ut: string[] = []): string[] {
	for (const navn of readdirSync(katalog)) {
		const sti = join(katalog, navn);
		if (statSync(sti).isDirectory()) samleTs(sti, ut);
		else if (navn.endsWith(".ts")) ut.push(sti);
	}
	return ut;
}

describe("ingen hardkodet tidssone i kode som skriver MEMORY", () => {
	test("America/Los_Angeles finnes ikke i noen kodesti", () => {
		// Vakten mot at en fjerde kopi sniker seg inn. Tre fantes, hver med
		// sin egen implementasjon, og ingen test så dem.
		const kataloger = [
			join(REPO, ".opencode", "pai-core"),
			join(REPO, ".opencode", "pai-adapters"),
			join(REPO, ".opencode", "PAI", "Tools"),
			join(REPO, "claude-plugin", "src"),
		];
		const syndere: string[] = [];
		for (const k of kataloger) {
			for (const fil of samleTs(k)) {
				const tekst = require("node:fs").readFileSync(fil, "utf-8");
				// Kommentarer som FORKLARER M-25 er lov; kode er ikke.
				for (const linje of tekst.split("\n")) {
					if (!linje.includes("America/Los_Angeles")) continue;
					const trimmet = linje.trim();
					if (trimmet.startsWith("*") || trimmet.startsWith("//")) continue;
					syndere.push(`${fil.replace(REPO, "")}: ${trimmet}`);
				}
			}
		}
		expect(syndere).toEqual([]);
	});

	test("det doble-forskyvnings-idiomet finnes ikke", () => {
		// `new Date(x.toLocaleString(..., {timeZone}))` er feil uansett sone.
		const kataloger = [join(REPO, ".opencode", "PAI", "Tools"), join(REPO, ".opencode", "pai-core")];
		const syndere: string[] = [];
		for (const k of kataloger) {
			for (const fil of samleTs(k)) {
				const tekst = require("node:fs").readFileSync(fil, "utf-8");
				// Per LINJE med kommentarfiltrering, ikke over hele filteksten:
				// dokumentasjonen som forklarer M-25 siterer nødvendigvis
				// idiomet, og en test som feller sin egen forklaring tvinger
				// fram at forklaringen fjernes. Da mister neste leser grunnen.
				for (const linje of tekst.split("\n")) {
					const trimmet = linje.trim();
					if (trimmet.startsWith("*") || trimmet.startsWith("//")) continue;
					if (/new Date\([^)]*\.toLocaleString\([^)]*timeZone/.test(linje)) {
						syndere.push(`${fil.replace(REPO, "")}: ${trimmet}`);
					}
				}
			}
		}
		expect(syndere).toEqual([]);
	});
});

afterAll(() => setSystemTime());

describe("tidsstemplene er den konfigurerte sonens", () => {
	test("tidsstemplet er internt konsistent med getLocalDate", () => {
		// ERSTATTET 2026-09-23. Testen het «følger systemklokka» og
		// sammenlignet mot maskinens time. Den kodet M-25-antakelsen om at
		// MASKINEN bestemmer sonen — og ble feil da M-01 ble lukket og den
		// KONFIGURERTE sonen tok over. Kontrakten testen over dekker nå.
		//
		// Det som er verdt å låse her er noe annet: at datodelen av
		// tidsstemplet og `getLocalDate()` ikke kan divergere. De leser samme
		// kilde, og skal fortsette å gjøre det.
		expect(getLocalTimestamp().slice(0, 10)).toBe(getLocalDate());
	});

	test("getLocalDate og getYearMonth er enige om måneden", () => {
		expect(getLocalDate().slice(0, 7)).toBe(getYearMonth());
	});

	test("de er enige OVER et månedsskifte også", () => {
		// MUTASJONSTESTEN AVSLØRTE AT DEN FORRIGE IKKE HOLDT: å løsrive
		// `getYearMonth()` fra `getLocalDate()` gikk rett gjennom, fordi den
		// konfigurerte sonen og maskinens sone er i samme måned nesten hele
		// tiden. Feilen krever et månedsskifte for å bli synlig.
		//
		// Her fryses klokka til et tidspunkt der de ER uenige: 30. september
		// kl. 20:00 UTC er allerede 1. oktober i Kiritimati (UTC+14). Leser
		// `getYearMonth()` maskinens tid framfor den konfigurerte sonen,
		// svarer den «2026-10» mens datoen sier «2026-09».
		const grense = new Date("2026-09-30T20:00:00.000Z");
		setSystemTime(grense);
		try {
			expect(getLocalDate().slice(0, 7)).toBe(getYearMonth());
		} finally {
			setSystemTime();
		}
	});

	test("den KONFIGURERTE sonen brukes, ikke maskinens (M-01)", () => {
		// M-01 sto åpen fra registeret ble startet: `principal.timezone` i
		// settings.json ble aldri lest. M-25 byttet Pacific mot maskinens
		// lokaltid og lot den konfigurerte sonen ligge — halve defekten.
		//
		// Asymmetrien som gjør testen verdt noe: den sammenligner mot det
		// `getPrincipal()` faktisk sier, ikke mot en hardkodet sone. Byttes
		// implementasjonen tilbake til maskinlokal, faller den kun hvis de
		// to er ULIKE — så testen sier fra når det betyr noe.
		const tz = getPrincipal().timezone;
		const forventet = new Date().toLocaleString("sv-SE", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
		});
		expect(getLocalTimestamp().slice(0, 13)).toBe(forventet.replace(" ", "T").slice(0, 13));
	});

	test("en ugyldig sone faller tilbake framfor å kaste", () => {
		// En feilskrevet settings.json skal ikke kunne stoppe en hook.
		expect(() => getLocalTimestamp()).not.toThrow();
	});

	test("formatet er ISO-lignende, ikke amerikansk", () => {
		expect(getLocalTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
	});
});
