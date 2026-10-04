/**
 * Døde `~/.opencode/…`-stier i prompt-materialet (K15)
 *
 * PAI er et prompt-system: stiene modellen skal lese, står i markdown. En sti
 * som ikke treffer, er stum. Modellen får en feilet `Read`, og leter (dyrt)
 * eller hopper over steget. Målt 2026-09-28: 279 døde stier i 106 filer, med
 * tre årsaker. Oppstrøms flyttet 12 skills inn i `Thinking/` og `Security/` uten å
 * rette stiene i teksten (`9787c75`), noen stier hadde feil store/små bokstaver
 * fra importen (`Webassessment`), og resten er rester fra det opprinnelige
 * Claude Code-PAI (`Bin/`, `hooks/`, skills som aldri ble portet).
 *
 * Fire klasser er IKKE døde, og regnes ut her i stedet for å stå i baselinen:
 *
 *   - `PAI/USER/SKILLCUSTOMIZATIONS/…`: valgfri med vilje. Hver skill sier
 *     «finnes katalogen, les den; ellers bruk standard».
 *   - `MEMORY/…`: utdata og tilstand som lages når skillen brukes.
 *   - eksempler og plassholdere: `YYYY-MM-DD_`, datoer, `ToolName.ts`.
 *   - `.env` og `settings.json`: maskinlokale og gitignorert, laget ved
 *     installasjonen. De finnes på en installert maskin og ikke i en fersk
 *     klone, så uten regelen avhenger utfallet av maskinen (M-28-klassen).
 *
 * Resten står i `tests/fixtures/dode-stier.json`, som bare kan krympe:
 * `tests/markdown-stier.test.ts` feiler på en ny død sti, og på en oppføring
 * som ikke lenger er død. Skriv baselinen på nytt med
 * `bun tests/lib/markdown-stier.ts`, bare når en sti er rettet.
 *
 * @module tests/lib/markdown-stier
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
export const BASELINE = join(REPO, "tests", "fixtures", "dode-stier.json");

/** Materialet modellen leser, som K15 ble bestilt for. */
const MØNSTRE = ["PAI/*.md", "agents/*.md", "skills/**/SKILL.md", "skills/**/Workflows/*.md"];

/** Stien slutter ved det første tegnet som ikke kan stå i et filnavn her, også `{` og `$`. */
const STI = /~\/\.opencode\/([A-Za-z0-9_\-./]+)/g;

/** Hvorfor en sti som ikke finnes, likevel ikke er død. `null` når den er det. */
export function ikkeDød(sti: string): string | null {
	if (sti.startsWith("PAI/USER/SKILLCUSTOMIZATIONS/")) return "valgfri tilpasning";
	if (sti.startsWith("MEMORY/")) return "lages ved bruk";
	if (sti === ".env" || sti === "settings.json") return "maskinlokal";
	if (/YYYY|\b20\d\d-\d\d|\b20\d{6}|ToolName|A_YOUR_|SkillName/.test(sti)) return "eksempel";
	return null;
}

export interface Oppslag {
	filer: number;
	stier: number;
	/** `fil → sti`, sortert og unik. */
	døde: string[];
}

/**
 * Hver død sti i materialet under `opencodeDir`, som `fil → sti`. `finnes`
 * avgjør om målet finnes (standard: på disken); testen gir en som spør git.
 */
export function dødeStier(
	opencodeDir = join(REPO, ".opencode"),
	finnes: (absolutt: string) => boolean = existsSync,
): Oppslag {
	const filer = new Set<string>();
	for (const m of MØNSTRE) {
		for (const f of new Bun.Glob(m).scanSync({ cwd: opencodeDir, followSymlinks: false })) filer.add(f);
	}
	let stier = 0;
	const døde = new Set<string>();
	for (const fil of filer) {
		for (const m of readFileSync(join(opencodeDir, fil), "utf-8").matchAll(STI)) {
			// Skilletegn etter stien i løpende tekst er ikke en del av den.
			const sti = (m[1] ?? "").replace(/[.,:;)]+$/, "");
			if (!sti) continue;
			stier++;
			if (finnes(join(opencodeDir, sti)) || ikkeDød(sti)) continue;
			døde.add(`${relative(REPO, join(opencodeDir, fil))} → ${sti}`);
		}
	}
	return { filer: filer.size, stier, døde: [...døde].sort() };
}

export function lesBaseline(): string[] {
	return JSON.parse(readFileSync(BASELINE, "utf-8")) as string[];
}

if (import.meta.main) {
	const { døde } = dødeStier();
	writeFileSync(BASELINE, `${JSON.stringify(døde, null, "\t")}\n`);
	console.log(`${døde.length} døde stier skrevet til ${relative(REPO, BASELINE)}`);
}
