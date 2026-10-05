/**
 * Kontrakt-test: kommandoene i runbookene og guidene slipper gjennom PAIs vakt (#258)
 *
 * `SETUP.md` steg 5 ba om `curl … | bash`, som vakten (`DANGEROUS_PATTERNS`)
 * blokkerer, og det viste seg først da en agent kjørte kjøreplanen (#256).
 * `runbooks/install.md` steg 10a hadde den samme linja etterpå. Denne testen
 * sjekker hver linje i kodeblokkene (`bash`, `sh`, `shell` eller uten språk) og
 * hver `Run:`-linje i `runbooks/` (ikke arkivet), `guide/` og `SETUP.md`.
 *
 * Noen linjer er ment for brukerens eget skall, før PAI finnes på maskinen
 * (Bun-installeren, ryddingen av en gammel installasjon). De står i UNNTAK med
 * grunnen. Et unntak som ikke treffer noen linje lenger, er rødt, så lista ikke
 * blir stående etter at oppskriften er endret. Filer som mangler (jobben har
 * ikke `guide/`, `SETUP.md` eller `install-fresh.md`), hoppes over.
 *
 * @module tests/doc-kommandoer-vakt
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { DANGEROUS_PATTERNS } from "../.opencode/pai-core/adapters/types";

const REPO = join(import.meta.dir, "..");
const MØNSTRE = ["runbooks/*.md", "guide/**/*.md", "SETUP.md"];

const FØR_PAI = "brukerens eget skall, før PAI er installert på maskinen";

/** Fil → linje (trimmet) → grunnen til at den er ment for brukerens eget skall. */
const UNNTAK: Record<string, Record<string, string>> = {
	"runbooks/install.md": {
		"curl -fsSL https://bun.sh/install | bash": `Bun-installeren, steg 1: ${FØR_PAI}`,
		"rm -rf ~/repos/pai-opencode ~/repos/opencode-config   # gamle kloner": `ryddingen av en gammel installasjon, steg 0: ${FØR_PAI}`,
		"rm -rf ~/.opencode": `symlinken byttes, steg 4: ${FØR_PAI}`,
		"rm -rf ~/.config/opencode": `symlinken byttes, steg 4: ${FØR_PAI}`,
	},
	"runbooks/install-fresh.md": {
		"curl -fsSL https://bun.sh/install | bash": `Bun-installeren: ${FØR_PAI}`,
		"rm -rf ~/.opencode": `symlinken byttes: ${FØR_PAI}`,
		"rm -rf ~/.config/opencode": `symlinken byttes: ${FØR_PAI}`,
	},
};

/** Linjene en agent kan kjøre: kodeblokker med skallspråk eller uten språk, og `Run:`-linjer. */
export function kommandolinjer(md: string): string[] {
	const ut: string[] = [];
	let iBlokk = false;
	let skall = false;
	for (const linje of md.split("\n")) {
		const gjerde = linje.match(/^\s*```(\S*)/);
		if (gjerde) {
			if (iBlokk) iBlokk = false;
			else {
				iBlokk = true;
				skall = ["", "bash", "sh", "shell", "zsh", "console"].includes(gjerde[1] ?? "");
			}
			continue;
		}
		if (iBlokk && skall && linje.trim()) ut.push(linje.trim());
		const run = linje.match(/^Run: `([^`]+)`/);
		if (!iBlokk && run?.[1]) ut.push(run[1]);
	}
	return ut;
}

const filer = MØNSTRE.flatMap((m) => [...new Glob(m).scanSync(REPO)]).sort();

describe("kommandoene i runbookene og guidene mot vakten (#258)", () => {
	test("det er filer å sjekke", () => {
		expect(filer.length).toBeGreaterThan(0);
	});

	test.each(filer.map((f) => [f]))("%s", (f) => {
		const unntak = UNNTAK[f] ?? {};
		const blokkert = kommandolinjer(readFileSync(join(REPO, f), "utf8"))
			.filter((l) => DANGEROUS_PATTERNS.some((m) => m.test(l)))
			.filter((l) => !(l in unntak));
		expect(blokkert).toEqual([]);
	});

	test("hvert unntak treffer en linje som vakten faktisk blokkerer", () => {
		const døde: string[] = [];
		for (const [f, linjer] of Object.entries(UNNTAK)) {
			if (!existsSync(join(REPO, f))) continue;
			const kommandoer = kommandolinjer(readFileSync(join(REPO, f), "utf8"));
			for (const l of Object.keys(linjer)) {
				if (!kommandoer.includes(l) || !DANGEROUS_PATTERNS.some((m) => m.test(l))) døde.push(`${f}: ${l}`);
			}
		}
		expect(døde).toEqual([]);
	});

	test("parseren: et ```ts-gjerde åpner ikke en skallblokk, og lukkingen åpner ingen", () => {
		const md = ["```ts", "rm -rf /", "```", "tekst", "```bash", "ls", "```", "Run: `pwd`"].join("\n");
		expect(kommandolinjer(md)).toEqual(["ls", "pwd"]);
	});
});
