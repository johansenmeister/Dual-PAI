/**
 * Kontrakt-test: indeksen over læringene i sesjonskonteksten (#315)
 *
 * En læring i `MEMORY/LEARNING/` nådde aldri en ny økt. På jobb gjentok en
 * økt en feil som en læring fra 2026-09-15 beskrev, fordi ingenting i
 * konteksten leste katalogen. Indeksen gir tittel og sti for de håndskrevne
 * læringene, nyeste først, og går med `loadUserSystemContext`, som både
 * launcheren (Claude) og `context.build` (v2) bruker.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { læringsindeks, loadUserSystemContext } from "../.opencode/pai-core/dispatch/context";

const kataloger: string[] = [];

afterAll(() => {
	for (const k of kataloger) rmSync(k, { recursive: true, force: true });
});

function nyKatalog(): string {
	const k = mkdtempSync(join(tmpdir(), "pai-laeringsindeks-"));
	kataloger.push(k);
	return k;
}

describe("læringsindeks", () => {
	test("ingen katalog gir null", () => {
		expect(læringsindeks(join(tmpdir(), "pai-finnes-ikke-laering"))).toBeNull();
	});

	test("tittel og sti, nyeste først, og bare filene rett i katalogen", () => {
		const k = nyKatalog();
		writeFileSync(join(k, "2026-09-15-portainer.md"), "# Portainer og secret-lekkasje i eget output\n\nTekst");
		writeFileSync(join(k, "2026-10-06-komodo.md"), "**Dato:** 2026-10-06\n\n# Komodo-loggen viser secrets\n");
		writeFileSync(join(k, "notat.txt"), "# ikke markdown");
		mkdirSync(join(k, "ALGORITHM"));
		writeFileSync(join(k, "ALGORITHM", "2026-10-07-auto.md"), "# Automatisk fanget");

		const linjer = (læringsindeks(k) ?? "").split("\n").slice(1);
		expect(linjer).toEqual([
			`- 2026-10-06 Komodo-loggen viser secrets (${join(k, "2026-10-06-komodo.md")})`,
			`- 2026-09-15 Portainer og secret-lekkasje i eget output (${join(k, "2026-09-15-portainer.md")})`,
		]);
	});

	test("uten dato i navnet brukes mtime, uten overskrift filnavnet", () => {
		const k = nyKatalog();
		const fil = join(k, "infrastructure-safety-rules.md");
		writeFileSync(fil, "Ingen overskrift her\n");
		const tid = new Date("2026-08-01T12:00:00Z");
		utimesSync(fil, tid, tid);
		expect(læringsindeks(k)).toContain(`- 2026-08-01 infrastructure-safety-rules (${fil})`);
	});

	test("over taket står de eldste igjen som et antall", () => {
		const k = nyKatalog();
		for (let i = 1; i <= 32; i++) {
			const dag = String(i).padStart(2, "0");
			writeFileSync(join(k, `2026-0${i <= 31 ? 7 : 8}-${i <= 31 ? dag : "01"}-l.md`), `# L${i}`);
		}
		const linjer = (læringsindeks(k) ?? "").split("\n").slice(1);
		expect(linjer).toHaveLength(31);
		expect(linjer[0]).toContain("2026-08-01 L32");
		expect(linjer[30]).toBe(`- … 2 older in ${k}`);
	});

	test("tom katalog gir null, så ingen tom seksjon", () => {
		expect(læringsindeks(nyKatalog())).toBeNull();
	});
});

describe("loadUserSystemContext tar med indeksen", () => {
	test("læringene under PAI_HOME står i konteksten", async () => {
		const hjem = process.env.PAI_HOME as string;
		const k = join(hjem, "MEMORY", "LEARNING");
		mkdirSync(k, { recursive: true });
		const fil = join(k, "2026-10-06-kontekst-test.md");
		writeFileSync(fil, "# Læringen som skal nå neste økt\n");
		try {
			const res = await loadUserSystemContext();
			expect(res?.context).toContain("--- Learnings from earlier sessions ---");
			expect(res?.context).toContain(`- 2026-10-06 Læringen som skal nå neste økt (${fil})`);
		} finally {
			rmSync(fil, { force: true });
		}
	});
});
