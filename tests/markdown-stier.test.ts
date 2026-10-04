/**
 * Kontrakt-test: ingen NYE døde `~/.opencode/…`-stier i prompt-materialet (K15)
 *
 * Stiene modellen skal lese, står i markdown, og en som ikke treffer, er stum
 * (H-21-klassen). Målt 2026-09-28: 279, der 51 i 29 filer ble rettet
 * mekanisk (bare der målet fantes), fire klasser er ikke døde (se
 * `tests/lib/markdown-stier.ts`), og resten står i en baseline som bare kan
 * krympe.
 *
 * @module tests/markdown-stier
 */

import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { dødeStier, ikkeDød, lesBaseline } from "./lib/markdown-stier";

const REPO = join(import.meta.dir, "..");

/** Stiene git sporer, med hver foreldrekatalog. `null` utenfor et git-tre (tarball). */
function sporedeStier(): Set<string> | null {
	const proc = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: REPO, stdout: "pipe", stderr: "ignore" });
	if (proc.exitCode !== 0) return null;
	const sett = new Set<string>();
	for (const f of proc.stdout.toString().split("\0").filter(Boolean)) {
		const deler = f.split("/");
		for (let i = 1; i <= deler.length; i++) sett.add(deler.slice(0, i).join("/"));
	}
	return sett;
}

describe("døde stier i prompt-materialet (K15)", () => {
	const funnet = dødeStier();
	const baseline = new Set(lesBaseline());

	test("materialet er lest: over 200 filer og 500 stier", () => {
		// En glob som ikke treffer noe, gir null døde stier og en grønn test.
		expect(funnet.filer).toBeGreaterThan(200);
		expect(funnet.stier).toBeGreaterThan(500);
	});

	test("ingen død sti utenfor baselinen", () => {
		// Står det noe her: rett stien, eller sjekk at målet er committet.
		// Skills ligger under en kategori (`skills/Security/PromptInjection/`).
		expect(funnet.døde.filter((d) => !baseline.has(d))).toEqual([]);
	});

	test("utfallet er det samme i en fersk klone", () => {
		// Et mål som finnes her uten å være sporet (`.env`), er dødt i en fersk
		// klone og i jobbklonen, og da er testen rød der og grønn her (M-28).
		// Fail-open utenfor et git-tre: harnesset kan distribueres som tarball.
		const sporet = sporedeStier();
		if (!sporet) return;
		const iKlone = dødeStier(undefined, (sti) => sporet.has(relative(REPO, sti)));
		expect(iKlone.døde.filter((d) => !funnet.døde.includes(d))).toEqual([]);
	});

	test("baselinen har bare stier som fortsatt er døde", () => {
		// Står det noe her, er den rettet: `bun tests/lib/markdown-stier.ts`.
		const nå = new Set(funnet.døde);
		expect([...baseline].filter((d) => !nå.has(d))).toEqual([]);
	});
});

describe("klassene som ikke er døde", () => {
	test.each([
		["PAI/USER/SKILLCUSTOMIZATIONS/Council/", "valgfri tilpasning"],
		["MEMORY/WORK/20260207-auth/PRD.md", "lages ved bruk"],
		["History/research/YYYY-MM-DD_description/", "eksempel"],
		["History/research/2025-10-26_podcast-analysis/", "eksempel"],
		["PAI/Tools/ToolName.ts", "eksempel"],
		[".env", "maskinlokal"],
		["settings.json", "maskinlokal"],
	])("%s: %s", (sti, grunn) => {
		expect(ikkeDød(sti)).toBe(grunn);
	});

	test.each([
		"skills/PromptInjection/Workflows/Reconnaissance.md",
		"skills/Webassessment/Workflows/pentest/Exploitation.md",
		"History/research/",
		"hooks/lib/notifications.ts",
		"PAI/USER/CONTACTS.md",
		".env.example",
	])("%s er død", (sti) => {
		expect(ikkeDød(sti)).toBeNull();
	});
});
