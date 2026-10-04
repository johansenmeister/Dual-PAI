/**
 * Typesjekk-gaten — `tsc --noEmit` over alle kodestier
 *
 * Het `undefined-names.test.ts` og krevde KUN `TS2304`/`TS2552`, fordi
 * repoet hadde 19 gjenværende typefeil av andre klasser og et bredere krav
 * ville falt med en gang. De 19 er ryddet, så gaten er utvidet til NULL
 * feil av enhver klasse.
 *
 * Grunnen til at den finnes står fortsatt: TO GANGER etterlot batch
 * 3-splitten et navn uimportert på den ene siden og ueksportert på den
 * andre, og BEGGE ganger var det stumt:
 *
 *   M-20  `ReviewMode` i `roborev-trigger.ts` → `tools.ts:165`. Kun en
 *         typeannotasjon, så den ble erased og ingenting feilet i drift.
 *   M-21  `sanitizeForMarkdown` i `session-registry.ts` → `tools.ts:58`.
 *         Denne var et EKTE KALL. `session_registry`-verktøyet kastet
 *         `ReferenceError` i enhver OpenCode-økt med minst én subagent i
 *         registeret — og ingen test, ingen lint og ingen røyktest så det.
 *
 * Biome fanget M-20 bare INDIREKTE, via den ubrukte deklarasjonen på den
 * andre siden. Den ser ikke på tvers av filer, så et navn som mangler i
 * KONSUMENTEN er usynlig for den. Det er `tsc` som ser det.
 *
 * Den utvidede gaten fant M-30 i samme slengen: åtte `fileLog`-kall i
 * `model-config.ts` sendte taggen som melding og meldingen som nivå, så
 * hele diagnostikken fra fila var uleselig.
 *
 * `Tools/` er med. Den er utviklerverktøy og ikke en driftskodesti, men
 * `MigrationValidator.ts` bar en defekt av nøyaktig M-21s klasse —
 * `readManifest()` kalt uten den påkrevde stien, i en sjekk merket
 * `critical` — og den typen feil er hele grunnen til at vakten står.
 *
 * @module tests/typecheck
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

/** Alt som typesjekkes: driftskodestiene pluss utviklerverktøyene. */
const KATALOGER = [
	join(REPO, ".opencode", "pai-core"),
	join(REPO, ".opencode", "pai-adapters"),
	join(REPO, "claude-plugin", "src"),
	join(REPO, "claude-plugin", "bin"),
	join(REPO, "claude-plugin", "mcp"),
	join(REPO, "Tools"),
	join(REPO, ".opencode", "PAI", "Tools"),
	// K12: utenfor gaten samlet den 13 feil ingen så, tre av dem ekte (M-52).
	join(REPO, "PAI-Install"),
];

/**
 * Kataloger med EGET byggoppsett, som ikke skal sjekkes med flaggene under.
 *
 * `pipeline-monitor-ui` er et Vite-prosjekt med sin egen `tsconfig.json` og
 * sine egne avhengigheter; med flaggene her feiler den på importer den selv
 * løser. Biome holder seg unna av samme grunn (`PAI/Tools/*.ts` i
 * `biome.json`, ikke `**`).
 */
const UTELATT = new Set(["pipeline-monitor-ui", "node_modules"]);

/**
 * Flaggene MÅ stå her og ikke i en `tsconfig.json`. Repoet har ingen, og
 * `tsc` uten flagg antar CommonJS og avviser `import`-formen hver eneste
 * fil bruker.
 */
const TSC_FLAGG = [
	"--noEmit",
	"--skipLibCheck",
	"--target",
	"esnext",
	"--module",
	"preserve",
	"--moduleResolution",
	"bundler",
	"--types",
	"bun",
];

function samleTs(katalog: string, ut: string[] = []): string[] {
	for (const navn of readdirSync(katalog)) {
		const sti = join(katalog, navn);
		if (statSync(sti).isDirectory()) {
			if (!UTELATT.has(navn)) samleTs(sti, ut);
		} else if (navn.endsWith(".ts")) ut.push(sti);
	}
	return ut;
}

describe("typesjekk", () => {
	/**
	 * Egen test, og den kommer FØRST med vilje. Kan ikke `tsc` kjøre i det
	 * hele tatt, produserer den null feillinjer — og en gate som krever
	 * «null feil» ville da bestått STILLE. Det er nøyaktig feilklassen
	 * vakten finnes for, så evnen til å kjøre testes separat.
	 */
	test("tsc kan kjøre", () => {
		const p = Bun.spawnSync(["bunx", "tsc", "--version"], { cwd: REPO });
		const utdata = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);

		expect(utdata).toMatch(/^Version \d+\.\d+/);
	}, 60_000);

	test("tsc --noEmit gir null feil", () => {
		const filer = KATALOGER.flatMap((k) => samleTs(k));
		expect(filer.length).toBeGreaterThan(50);

		const p = Bun.spawnSync(["bunx", "tsc", ...TSC_FLAGG, ...filer], { cwd: REPO });
		const utdata = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);

		const feil = utdata.split("\n").filter((l) => /error TS\d+/.test(l));

		// Feillinjene i meldingen, ikke bare antallet: uten dem må den som
		// får testen rød kjøre kommandoen på nytt for å se hva som falt.
		expect(feil.join("\n")).toBe("");

		// Exit-koden i tillegg, fordi en `tsc` som feiler FØR den ser på
		// koden (manglende typer, ugyldig flagg) kan gi null `error TS`-
		// linjer. Da skal gaten falle, ikke bestå.
		expect(p.exitCode).toBe(0);
	}, 120_000);
});
