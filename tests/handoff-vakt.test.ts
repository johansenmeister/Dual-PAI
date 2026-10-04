/**
 * Kontrakt-test: handoveren holder seg liten, og MÅLT-pekerne treffer (K56)
 *
 * `docs/dual-harness/handoff.md` vokste til 267 KB før noen reagerte, og en ny
 * økt brukte starten sin på å lese den. Den ble delt 2026-09-30: målingene
 * flyttes ordrett til `handoff-arkiv.md`, og én linje står igjen i handoverens
 * «MÅLT — indeks». Tre ting kan gå galt uten at noe sier fra:
 *
 * - handoveren vokser igjen, fordi ingen flytter noe
 * - en «MÅLT: …»-peker i `docs/` dør når en seksjon flyttes eller får ny
 *   overskrift
 * - en seksjon flyttes uten indekslinje, og er dermed borte for en økt som
 *   bare leser handoveren
 * - handoveren blir en logg igjen (#167): en commit-hash utenfor en
 *   MÅLT-seksjon er tilstand som går ut på dato. Hvor `dev`, `jobb-v2` og
 *   kopiene står, regner øktbriefen (`oktstart.sh`) ut; bevisene står i
 *   commit-meldingen
 *
 * Handoveren og arkivet følger ikke med kopiene (`bygg.sh`, `bygg-jobb.sh`),
 * så testen hoppes over når handoveren mangler.
 *
 * @module tests/handoff-vakt
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "..");
const HANDOFF = join(REPO, "docs", "dual-harness", "handoff.md");
const ARKIV = join(REPO, "docs", "dual-harness", "handoff-arkiv.md");

/** Kopiene har ikke handoveren; der hoppes testen over. */
export const HOPP_OVER = !existsSync(HANDOFF);

/** Over dette er det på tide å flytte målinger til arkivet. Fila var 52 KB etter delingen. */
export const MAKS_BYTE = 80_000;

const normaliser = (s: string): string =>
	s
		.replace(/\s+/g, " ")
		.replace(/[\s,…]+$/u, "")
		.trim();

/** Overskriftene i en markdown-tekst, uten `#`-ene og med mellomrom slått sammen. */
export function overskrifter(tekst: string): string[] {
	return tekst
		.split("\n")
		.filter((l) => /^#{1,6} /.test(l))
		.map((l) => normaliser(l.replace(/^#+ /, "")));
}

/**
 * Pekerne til en MÅLT-seksjon: «MÅLT: …» i anførselstegn, også brutt over flere
 * linjer. En peker kan være forkortet («MÅLT: tillegg 10, …»), så den treffer
 * en overskrift den er et prefiks av.
 */
export function målPekere(tekst: string): string[] {
	return [...tekst.matchAll(/«(MÅLT[^»]*)»/gu)].map((m) => normaliser(m[1] ?? ""));
}

export function treffer(peker: string, heads: string[]): boolean {
	return heads.some((h) => h.startsWith(peker));
}

/** Overskriftene under «MÅLT — indeks» i handoveren, som indeksen må ha en linje for. */
export function indeksen(handoff: string): string {
	const start = handoff.indexOf("## MÅLT — indeks");
	if (start < 0) return "";
	const slutt = handoff.indexOf("\n## ", start + 1);
	return handoff.slice(start, slutt < 0 ? undefined : slutt);
}

/** MÅLT-seksjonene i arkivet som ingen peker i indeksen treffer. */
export function utenIndekslinje(arkiv: string, indeks: string): string[] {
	const pekere = [...indeks.matchAll(/«([^»]+)»/gu)].map((m) => normaliser(m[1] ?? ""));
	return overskrifter(arkiv)
		.filter((h) => h.startsWith("MÅLT:"))
		.filter((h) => !pekere.some((p) => h.startsWith(p)));
}

/**
 * Commit-hasher utenfor MÅLT-seksjonene, som «linje N: hash». En seksjon er
 * MÅLT når nærmeste `##`- eller `###`-overskrift begynner med «MÅLT»; en ny
 * `##` nullstiller `###`. En hash er 7–40 heksadesimale tegn med minst ett
 * siffer og én bokstav, som et helt ord.
 */
export function hasherUtenforMålt(tekst: string): string[] {
	const funn: string[] = [];
	let h2 = "";
	let h3 = "";
	tekst.split("\n").forEach((linje, i) => {
		if (linje.startsWith("## ")) [h2, h3] = [linje, ""];
		else if (linje.startsWith("### ")) h3 = linje;
		if (/^#{2,3} MÅLT/u.test(h2) || /^#{3} MÅLT/u.test(h3)) return;
		for (const m of linje.matchAll(/(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?![0-9A-Za-z_])/g)) {
			if (/\d/.test(m[0]) && /[a-f]/.test(m[0])) funn.push(`linje ${i + 1}: ${m[0]}`);
		}
	});
	return funn;
}

describe.skipIf(HOPP_OVER)("handoveren (K56)", () => {
	// `skipIf` kjører likevel kroppen: en lesing her krasjet fila i begge kopiene
	// («1 error», som `Leveranse.sh` ikke telte).
	const handoff = HOPP_OVER ? "" : readFileSync(HANDOFF, "utf-8");
	const arkiv = existsSync(ARKIV) ? readFileSync(ARKIV, "utf-8") : "";
	const heads = [...overskrifter(handoff), ...overskrifter(arkiv)];

	test("arkivet finnes, og indeksen står i handoveren", () => {
		expect(existsSync(ARKIV)).toBe(true);
		expect(indeksen(handoff)).not.toBe("");
	});

	test(`handoveren er under ${MAKS_BYTE} byte`, () => {
		// Rødt her betyr ikke at noe er galt, men at det er på tide: flytt MÅLT-seksjoner
		// som neste steg ikke trenger, til arkivet (Arbeidsmåte, «Hold fila liten»).
		expect(statSync(HANDOFF).size).toBeLessThan(MAKS_BYTE);
	});

	test("hver «MÅLT: …»-peker i docs/ treffer en overskrift i handoveren eller arkivet", () => {
		const døde: string[] = [];
		for (const f of new Bun.Glob("docs/**/*.md").scanSync({ cwd: REPO })) {
			const fil = join(REPO, f);
			for (const p of målPekere(readFileSync(fil, "utf-8"))) {
				if (!treffer(p, heads)) døde.push(`${relative(REPO, fil)} → «${p}»`);
			}
		}
		expect(døde).toEqual([]);
	});

	test("ingen commit-hasher utenfor MÅLT-seksjonene: tilstanden står i øktbriefen (#167)", () => {
		expect(hasherUtenforMålt(handoff)).toEqual([]);
	});

	test("hver MÅLT-seksjon i arkivet har en linje i indeksen", () => {
		expect(utenIndekslinje(arkiv, indeksen(handoff))).toEqual([]);
	});
});

describe("hoppes ikke over i opphavet", () => {
	test("med docs/jobb-harness/ (som bare opphavet har) finnes handoveren, og testen kjører", () => {
		// Ellers ville en feil i hopp-over-betingelsen gjort hele vakten taus.
		if (!existsSync(join(REPO, "docs", "jobb-harness", "JobbTillegg.sh"))) return;
		expect(HOPP_OVER).toBe(false);
	});
});

describe("hjelperne", () => {
	test("hasherUtenforMålt: tilstand meldes, bevis i en MÅLT-seksjon gjør det ikke", () => {
		const tekst = [
			"## Din oppgave nå", // linje 1
			"`jobb-v2` = `8d6aa5d`, dev = c0c8ce4.",
			"### MÅLT: tillegg 12 (2026-10-01)",
			"Adapter-hashen er `215cedb9…`, fra `ed6e17f`.",
			"### Harness-kopiene", // en ny ### under samme ## er ikke MÅLT
			"bygget fra `05d6265`",
			"## MÅLT — indeks",
			"### Claude Code",
			"«MÅLT: x» (`a8b3c5e`)",
			"## Trukket",
			"2026100 og deadbeef og #164 og `bundel/12` og abcdef12x er ikke hasher",
			"### MÅLT: y",
			"## Neste", // en ny ## nullstiller MÅLT-### over seg
			"`9854c87d`",
		].join("\n");
		expect(hasherUtenforMålt(tekst)).toEqual(["linje 2: 8d6aa5d", "linje 2: c0c8ce4", "linje 6: 05d6265", "linje 14: 9854c87d"]);
	});

	test("overskrifter tar alle nivåer og slår sammen mellomrom", () => {
		expect(overskrifter("# A\ntekst\n### MÅLT: fase 1  (x)\n#### d\n#ikke")).toEqual(["A", "MÅLT: fase 1 (x)", "d"]);
	});

	test("en peker brutt over linjer, og en forkortet, treffer", () => {
		const heads = ["MÅLT: tillegg 10, `{env:HOME}` og harness-kopiene (2026-09-29/30)", "MÅLT: fase 7 for v2 (2026-09-26)"];
		const p = målPekere("se «MÅLT: fase 7\n  for v2» og «MÅLT: tillegg 10, …»");
		expect(p).toEqual(["MÅLT: fase 7 for v2", "MÅLT: tillegg 10"]);
		expect(p.every((x) => treffer(x, heads))).toBe(true);
	});

	test("en peker som ikke er et prefiks, treffer ikke", () => {
		expect(treffer("MÅLT: fase 8 for v2", ["MÅLT: fase 7 for v2 (2026-09-26)"])).toBe(false);
		expect(treffer("MÅLT: fase 7 for v2 (2026-09-27)", ["MÅLT: fase 7 for v2"])).toBe(false);
	});

	test("bare pekere som begynner med MÅLT, er med", () => {
		expect(målPekere("«Din oppgave nå» og «Trukket» og «MÅLT: x»")).toEqual(["MÅLT: x"]);
	});

	test("en arkivseksjon uten indekslinje meldes, en med gjør det ikke", () => {
		const arkiv = "## MÅLT — ikke verifiser på nytt\n### MÅLT: a (1)\n### MÅLT: b (2)\n### Annet";
		expect(utenIndekslinje(arkiv, "- «MÅLT: a»: noe")).toEqual(["MÅLT: b (2)"]);
		expect(utenIndekslinje(arkiv, "- «MÅLT: a» og «MÅLT: b»")).toEqual([]);
	});

	test("indeksen slutter ved neste ##-overskrift, ikke ved ###", () => {
		const h = "## A\n«MÅLT: x»\n## MÅLT — indeks\n### C\n«MÅLT: y»\n## Neste\n«MÅLT: z»";
		const i = indeksen(h);
		expect(i).toContain("MÅLT: y");
		expect(i).not.toContain("MÅLT: x");
		expect(i).not.toContain("MÅLT: z");
	});
});
