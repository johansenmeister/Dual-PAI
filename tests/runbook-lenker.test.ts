/**
 * Kontrakt-test: lenkene mellom runbookene treffer (K22)
 *
 * En runbook i jobbtreet viste til `maskinlokal-tilstand.md`, som kopiene
 * utelater, og samme peker sto i `pai-harness-public`. K15 ser bare
 * `~/.opencode/…`-stier, ikke lenker mellom dokumentene. Her: hver
 * `](x.md)`-lenke (relativ til fila) og hver `runbooks/x.md` og `guide/x.md` i
 * `runbooks/`, `guide/`, `SETUP.md`, `AGENTS.md` og `PAI/USER/*.md` skal finnes.
 * Testen følger med kopiene, så en utelatt fil gjør `bun test` rød der, etter
 * byggingen.
 *
 * `runbooks/arkiv/` er historikk, ikke nåtilstand, og lenkene der står som de
 * sto (én er død, målt 2026-09-28).
 *
 * @module tests/runbook-lenker
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const REPO = join(import.meta.dir, "..");

/** `](x.md)` og `](x.md#anker)`. Nettadresser og rene ankere er ikke med. */
const LENKE = /\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g;
/** `runbooks/x.md` og `guide/x.md` i løpende tekst, ikke som del av en lengre sti. */
const RUNBOOK = /(?<![\w/.~-])(runbooks|guide)\/([A-Za-z0-9_\-./]+\.md)/g;

export function lenkerI(fil: string, tekst: string): { mål: string; skrevet: string }[] {
	const ut: { mål: string; skrevet: string }[] = [];
	for (const m of tekst.matchAll(LENKE)) {
		const s = m[1] ?? "";
		if (/^[a-z]+:/.test(s)) continue;
		ut.push({ mål: join(dirname(fil), s), skrevet: s });
	}
	for (const m of tekst.matchAll(RUNBOOK)) ut.push({ mål: join(REPO, m[1] ?? "", m[2] ?? ""), skrevet: m[0] });
	return ut;
}

function dokumenter(): string[] {
	const filer = [join(REPO, "AGENTS.md")];
	// SETUP.md og guide/ følger bare med til public (#162), ikke til jobben.
	if (existsSync(join(REPO, "SETUP.md"))) filer.push(join(REPO, "SETUP.md"));
	for (const glob of ["runbooks/**/*.md", "guide/**/*.md"]) {
		for (const f of new Bun.Glob(glob).scanSync({ cwd: REPO })) {
			if (!f.startsWith("runbooks/arkiv/")) filer.push(join(REPO, f));
		}
	}
	for (const f of new Bun.Glob(".opencode/PAI/USER/*.md").scanSync({ cwd: REPO, dot: true })) filer.push(join(REPO, f));
	return filer;
}

describe("lenkene mellom dokumentene (K22)", () => {
	const filer = dokumenter();
	const lenker = filer.flatMap((f) => lenkerI(f, readFileSync(f, "utf-8")).map((l) => ({ fil: f, ...l })));

	test("dokumentene og lenkene er funnet", () => {
		// En glob som ikke treffer, gir null døde lenker og en grønn test. Sjekket
		// ved navn og ikke ved antall: kopiene har færre dokumenter enn opphavet
		// (`pai-harness-public` har 14 og ~7 lenker), og en terskel stilt etter
		// opphavet gjorde testen rød i begge kopiene.
		// `runbooks/` følger ikke med til public (#162, fase 7).
		const runbooks = existsSync(join(REPO, "runbooks")) ? ["runbooks/hooksystemet.md", "runbooks/daglig.md"] : [];
		for (const f of ["AGENTS.md", ...runbooks, ".opencode/PAI/USER/INFRASTRUCTURE.md"]) {
			expect(filer).toContain(join(REPO, f));
		}
		expect(lenker.length).toBeGreaterThan(0);
	});

	test("hver lenke treffer en fil som finnes", () => {
		const døde = lenker.filter((l) => !existsSync(l.mål)).map((l) => `${relative(REPO, l.fil)} → ${l.skrevet}`);
		expect(døde).toEqual([]);
	});
});

describe("lenkerI", () => {
	const fil = join(REPO, "runbooks", "daglig.md");

	test("relativ lenke løses fra fila, med og uten anker", () => {
		expect(lenkerI(fil, "se [x](install.md) og [y](../AGENTS.md#docs)").map((l) => relative(REPO, l.mål))).toEqual([
			"runbooks/install.md",
			"AGENTS.md",
		]);
	});

	test("runbooks/x.md i tekst løses fra repo-roten", () => {
		expect(lenkerI(fil, "står i `runbooks/hooksystemet.md`").map((l) => relative(REPO, l.mål))).toEqual([
			"runbooks/hooksystemet.md",
		]);
	});

	test("guide/x.md i tekst løses fra repo-roten", () => {
		expect(lenkerI(fil, "see `guide/remote-access.md`").map((l) => relative(REPO, l.mål))).toEqual([
			"guide/remote-access.md",
		]);
	});

	test("nettadresser, rene ankere og lengre stier er ikke med", () => {
		expect(lenkerI(fil, "[a](https://x.no/a.md) [b](#avsnitt) ~/repos/pai/runbooks/x.md")).toEqual([]);
	});
});

/** `` `SETUP.md`, "Navn" `` i guidene; navnet kan være brutt over to linjer. */
const STEG = /`SETUP\.md`, "([^"]+)"/g;

export function stegI(tekst: string): string[] {
	return [...tekst.matchAll(STEG)].map((m) => (m[1] ?? "").replace(/\s+/g, " "));
}

// Guidene viser til kjøreplanens steg ved navn, ikke nummer: numrene flyttet seg
// to ganger i #162 fase 3. Et omdøpt steg gjør pekeren død uten at lenketesten ser det.
// `describe.if(false)` hopper over testene, men Bun kjører likevel innmaten når de
// samles inn: lesingen må tåle at SETUP.md mangler (jobben har den ikke).
const SETUP = join(REPO, "SETUP.md");
describe.if(existsSync(SETUP))("guidenes pekere til stegene i SETUP.md", () => {
	const tekst = existsSync(SETUP) ? readFileSync(SETUP, "utf-8") : "";
	const overskrifter = new Set([...tekst.matchAll(/^## Step \d+: (.+)$/gm)].map((m) => m[1]?.trim()));
	const pekere = [...new Bun.Glob("guide/**/*.md").scanSync({ cwd: REPO })].flatMap((f) =>
		stegI(readFileSync(join(REPO, f), "utf-8")).map((navn) => ({ f, navn })),
	);

	test("pekerne er funnet", () => {
		expect(pekere.length).toBeGreaterThan(0);
	});

	test("hvert navn er overskriften på et steg", () => {
		expect(pekere.filter((p) => !overskrifter.has(p.navn)).map((p) => `${p.f} → "${p.navn}"`)).toEqual([]);
	});

	test("et navn brutt over to linjer leses som ett", () => {
		expect(stegI('se `SETUP.md`, "Faults and\nimprovements" her')).toEqual(["Faults and improvements"]);
	});
});
