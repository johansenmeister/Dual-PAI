/**
 * Kontrakt-test for integritetssjekken (M-23, M-24)
 *
 * Sjekken kjører ved hver øktslutt og skal si fra når PAI-treet er skadet.
 * Fram til batch 13 gjorde den det motsatte: den ropte ALLTID, om to ting
 * som ikke var galt.
 *
 *   M-23  `plugins/handlers` — stien fra FØR batch 3 flyttet handlerne til
 *         `pai-core/`. «handlers/ directory missing» ved hver øktslutt i ti
 *         batcher, i begge motorene.
 *   M-24  En katalog `MEMORY/WORK/PRD/` som aldri har eksistert. PRD-er er
 *         per arbeidsøkt (`MEMORY/WORK/<økt>/PRD.md`).
 *
 * Det farlige var ikke støyen i seg selv, men at den gjorde sjekken
 * verdiløs: to permanente feil drukner den ene ekte som en dag dukker opp.
 *
 * @module tests/integrity-check
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const OPENCODE = join(REPO, ".opencode");
const KILDE = join(OPENCODE, "pai-core", "handlers", "integrity-check.ts");

describe("integritetssjekken peker på stier som finnes", () => {
	test("handler-katalogen sjekken leter i, eksisterer", async () => {
		// Asymmetrien som gjør testen verdt noe: den sjekker ikke bare at
		// koden nevner en sti, men at stien FINNES og har nok filer til å
		// passere sjekkens egen terskel.
		const kilde = await Bun.file(KILDE).text();
		const treff = kilde.match(/path\.join\(openCodeDir,\s*"([^"]+)",\s*"handlers"\)/);
		if (!treff) throw new Error("fant ingen handlers-sti i integrity-check.ts");

		const katalog = join(OPENCODE, treff[1], "handlers");
		expect(existsSync(katalog)).toBe(true);

		const handlere = readdirSync(katalog).filter((f) => f.endsWith(".ts"));
		expect(handlere.length).toBeGreaterThanOrEqual(14);
	});

	test("den gamle stien plugins/handlers finnes IKKE lenger", () => {
		// Vokter mot at noen «retter tilbake». Fantes begge, ville testen
		// over bestått uten å bevise noe.
		expect(existsSync(join(OPENCODE, "plugins", "handlers"))).toBe(false);
	});

	test("check 5 peker på en fil som finnes — v2-adapteren", async () => {
		// Den pekte på v1s `plugins/pai-unified.ts` til v1 ble slettet. En
		// sjekk mot en slettet fil roper ved hver øktslutt (M-23-klassen).
		const kilde = await Bun.file(KILDE).text();
		expect(kilde).toMatch(/path\.join\(openCodeDir, "pai-adapters", "opencode-v2", "index\.ts"\)/);
		expect(existsSync(join(OPENCODE, "pai-adapters", "opencode-v2", "index.ts"))).toBe(true);
		expect(kilde).not.toContain('"pai-unified.ts"');
	});

	test("sjekken leter ikke lenger etter katalogen MEMORY/WORK/PRD", async () => {
		const kilde = await Bun.file(KILDE).text();
		// Kommentaren om M-24 skal stå, men ingen levende path.join til den.
		expect(kilde).not.toMatch(/path\.join\([^)]*"WORK",\s*"PRD"\)/);
	});
});
