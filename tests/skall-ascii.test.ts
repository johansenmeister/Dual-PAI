/**
 * Kontrakt-test: ingen variabelnavn utenfor ASCII i repoets skallskript (#199)
 *
 * `NØKKEL=$(grep … .env)` er ikke en tilordning i bash, men en kommando, og
 * «command not found» skriver ut hele linja, altså verdien. Det lekket en nøkkel
 * 2026-09-26, og fellen ble gått i to ganger til i #162 fase 2 (`nå=`, `FØRSTE=`).
 * `$FØRSTE` er tilsvarende `$F` fulgt av teksten «ØRSTE». Ingenting fanget det før
 * skriptet kjørte.
 *
 * Dekker sporede `*.sh` og sporede filer uten endelse med en sh/bash-shebang.
 * Markdown med skallblokker er ikke med: der er teksten norsk prosa.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

/** En tilordning eller en `$`-referanse der navnet har en bokstav utenfor ASCII. */
export function ikkeAsciiNavn(linje: string): boolean {
	// Kommentarer, hele linjer og etter « #», er prosa.
	const kode = linje.replace(/(^|\s)#.*$/u, "");
	// Et navn med minst én bokstav utenfor ASCII: `[^\p{ASCII}\P{L}]`.
	const tilordning =
		/(^|[\s;(&|])(?:export\s+|local\s+|declare\s+(?:-\w+\s+)?|readonly\s+)?[\p{L}\p{N}_]*[^\p{ASCII}\P{L}][\p{L}\p{N}_]*=/u;
	const referanse = /\$\{?[A-Za-z0-9_]*[^\p{ASCII}\P{L}]/u;
	return tilordning.test(kode) || referanse.test(kode);
}

function skallskript(): string[] {
	const ls = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: REPO }).stdout.toString().split("\0").filter(Boolean);
	return ls.filter((f) => {
		if (f.endsWith(".sh")) return true;
		if (/\.[A-Za-z0-9]+$/.test(f.split("/").pop() ?? "")) return false;
		try {
			return /^#!.*\b(ba)?sh\b/.test(readFileSync(join(REPO, f), "utf-8").slice(0, 80));
		} catch {
			return false;
		}
	});
}

describe("ikkeAsciiNavn", () => {
	test("fanger tilordninger og referanser med æ, ø og å", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: skallets ${NAVN}, ikke en JS-mal
		for (const l of ["FØRSTE=1", "  nå=$(date)", "export NØKKEL=x", "local blå=1", "x=1; nå=2", 'echo "$FØRSTE"', "[ ${FØRSTE} -eq 1 ]"]) {
			expect(ikkeAsciiNavn(l)).toBe(true);
		}
	});

	test("lar norsk tekst, kommentarer og ASCII-navn være", () => {
		for (const l of [
			'echo "❌ $2: fikk «$UT»"',
			"# «KEY=   # forklaring» tolket som verdien",
			"FIRST=1",
			'echo "Kjøreplanen er ferdig: $MODEL"',
			"FEIL=1 # rød=feil",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: skallets ${NAVN}, ikke en JS-mal
			'say "Installing ${missing[*]}"',
		]) {
			expect(ikkeAsciiNavn(l)).toBe(false);
		}
	});
});

describe("repoets skallskript", () => {
	const filer = skallskript();

	test("finner skriptene (ellers består testen tomt)", () => {
		// Public har 13 (uten `runbooks/` og `docs/`), opphavet over 20.
		expect(filer.length).toBeGreaterThan(10);
		expect(filer).toContain("scripts/sync-end.sh");
	});

	test("ingen variabelnavn utenfor ASCII", () => {
		const treff: string[] = [];
		for (const f of filer) {
			readFileSync(join(REPO, f), "utf-8")
				.split("\n")
				.forEach((l, i) => {
					if (ikkeAsciiNavn(l)) treff.push(`${f}:${i + 1}: ${l.trim()}`);
				});
		}
		expect(treff).toEqual([]);
	});
});
