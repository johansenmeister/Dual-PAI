/**
 * Kontrakt-test: effort-heuristikken
 *
 * Feilen som ble rettet var stille: `msg.includes(signal)` traff INNI ord, så
 * «justere» ble lest som fartssignalet «just» og nedgraderte innsatsen. Den
 * feilet ikke — den skrev bare feil verdi i `META.yaml`, 533 ganger.
 *
 * Testene speiler mønsteret fra `security-validator.test.ts`: assert både at
 * riktig signal treffer OG at det gale ikke gjør det. Det er den asymmetrien
 * som fanger en regresjon tilbake til substring-matching.
 *
 * MÅLT 2026-09-22 mot den gamle implementasjonen — dette er tilfellene som
 * avdekket feilen, og de er nå regresjonsvakter:
 *
 *   «Kan du justere tabellen i runbooken?»              → Fast   (skulle vært Standard)
 *   «Vi har fast pris på denne serveren…»               → Fast   (skulle vært Standard)
 *   «Gjør en grundig gjennomgang av hele hooksystemet…» → Standard (skulle vært Extended)
 */

import { describe, expect, test } from "bun:test";
import { STAMME_MIN, detectEffortLevel } from "../.opencode/pai-core/handlers/format-reminder";

async function nivå(melding: string): Promise<string> {
	return (await detectEffortLevel(melding)).level;
}

describe("substring-feilen skal ikke kunne komme tilbake", () => {
	test("«justere» er ikke fartssignalet «just»", async () => {
		expect(await nivå("Kan du justere tabellen i runbooken?")).toBe("Standard");
	});

	test("«fast pris» er ikke fartssignalet «fast»", async () => {
		expect(await nivå("Vi har fast pris på denne serveren, oppdater fakturaen")).toBe("Standard");
	});

	test("«just» alene senker ikke dybden — SKILL.md lover det eksplisitt", async () => {
		expect(await nivå("just fix the typo in line 4 please, nothing else needed")).toBe("Standard");
	});

	test("«enkelte» er ikke fartssignalet «enkel»", async () => {
		// Denne fanger en regresjon tilbake til substring-matching selv etter at
		// «just» er fjernet: «enkelte» er et vanlig norsk ord som inneholder et
		// signal som fortsatt står i lista. Uten den slipper mutasjonen
		// «harOrd bruker substring» gjennom — målt 2026-09-22.
		expect(await nivå("Enkelte av testene feiler fortsatt etter denne endringen")).toBe("Standard");
	});

	test("æøå deles ikke i biter av tokenizeren", async () => {
		// «påse» inneholder ikke noe signal. Med \w-basert tokenisering ville
		// den blitt delt i «p» og «se», og en fremtidig kort stamme ville truffet.
		expect(await nivå("Du må påse at dette er riktig før vi går videre her")).toBe("Standard");
	});
});

describe("norske signaler treffer", () => {
	test("«grundig» gir dybde", async () => {
		expect(await nivå("Gjør en grundig gjennomgang av hele hooksystemet og finn alle defekter")).toBe(
			"Extended"
		);
	});

	test("«raskt» gir fart", async () => {
		expect(await nivå("Kan du fikse dette raskt?")).toBe("Fast");
	});

	test("bøyning fanges av stammen, ikke av oppramsing", async () => {
		for (const m of [
			"Vi må refaktorere hele adapterlaget og migrere tilstanden",
			"Denne refaktoreringen berører flere moduler enn vi trodde",
			"Migreringen av tilstanden må skje før vi rører adapteren",
		]) {
			expect(await nivå(m)).toBe("Advanced");
		}
	});
});

describe("engelske signaler er uendret", () => {
	test("«thorough» gir dybde når prompten er lang nok", async () => {
		expect(await nivå(`thorough review please. ${"x".repeat(520)}`)).toBe("Deep");
	});

	test("«refactor» gir bredde", async () => {
		expect(await nivå("we need to refactor the adapter layer before anything else")).toBe("Advanced");
	});
});

describe("grunnlinje", () => {
	test("vanlig melding gir Standard", async () => {
		expect(await nivå("Les docs/dual-harness/handoff.md først, deretter docs/dual-harness/plan.md")).toBe(
			"Standard"
		);
	});

	test("hilsen gir Instant", async () => {
		expect(await nivå("hei")).toBe("Instant");
	});

	test("kaster aldri — tom, rar og veldig lang inndata", async () => {
		for (const m of ["", "   ", "🙂🙂🙂", "x".repeat(5000)]) {
			expect(typeof (await nivå(m))).toBe("string");
		}
	});
});

describe("stammene er lange nok til å være trygge", () => {
	/**
	 * Vaktpost. «just» er fire tegn og var nok til å treffe «justere». Legger
	 * noen en kort stamme inn i listene, er substring-feilen tilbake — og den
	 * feiler ikke av seg selv. Den blir bare stille feil igjen.
	 */
	/**
	 * Grensen pinnes HER, ikke bare leses fra kilden. Leser testen tallet uten
	 * å pinne det, kan en som senker `STAMME_MIN` svekke vakten uten at noe
	 * faller — og det er nøyaktig den stille veien feilen kom inn første gang.
	 */
	test("grensen er seks tegn", () => {
		expect(STAMME_MIN).toBe(6);
	});

	test(`ingen stamme er kortere enn ${STAMME_MIN} tegn`, async () => {
		const kilde = await Bun.file(
			new URL("../.opencode/pai-core/handlers/format-reminder.ts", import.meta.url)
		).text();

		const blokker = kilde.match(/const (?:DYBDE|BREDDE)_STAMMER = \[([^\]]+)\]/g) ?? [];
		expect(blokker.length).toBe(2);

		for (const blokk of blokker) {
			for (const treff of blokk.matchAll(/"([^"]+)"/g)) {
				expect(treff[1].length).toBeGreaterThanOrEqual(STAMME_MIN);
			}
		}
	});
});
