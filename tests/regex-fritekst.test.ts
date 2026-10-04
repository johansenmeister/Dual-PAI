/**
 * Kontrakt-test: regexer som leser norsk fritekst, kjenner æøå (K30)
 *
 * `\w`, `\W`, `\b`, `\B` og `[a-z]` er ASCII i JavaScript, OGSÅ med `u`-flagget
 * (MÅLT: `"Kjør".match(/\w+/u)` gir «Kj»). M-41 gjorde «Kjør» til «Kj r» i
 * arbeidsøktens tittel, og `\w+:` fant aldri talelinja til en DA med mellomrom i navnet
 * (M-53). Et krav om `u`-flagget ville vært en falsk vakt; kuren er `\p{L}`.
 *
 * Første del er vakten: hver linje i `pai-core/` med en ASCII-klasse står i
 * en telling per fil med grunnen til at ASCII er riktig der. En ny linje gjør
 * testen rød, og da er valget å bruke `\p{L}` eller å føre den opp her.
 * Andre del er rettingene fra samme runde, med æøå i inndataen.
 *
 * @module tests/regex-fritekst
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { extractLearningsFromText } from "../.opencode/pai-core/handlers/learning-capture";
import { parseStructuredResponse } from "../.opencode/pai-core/handlers/response-capture";
import { isValidVoiceCompletion } from "../.opencode/pai-core/handlers/tab-state";
import { collapseObfuscatedSpacing } from "../.opencode/pai-core/lib/sanitizer";

const KJERNE = join(import.meta.dir, "..", ".opencode", "pai-core");

/** Kildeteksten for en ASCII-klasse: `\w`, `\W`, `\b`, `\B`, `[a-z` eller `[A-Z`. */
const ASCII_KLASSE = /\\[wWbB]|\[a-z|\[A-Z/;

/** Linjer med ASCII-klasser som er riktige, per fil under `pai-core/`. */
const ASCII_MED_VILJE: Record<string, { linjer: number; grunn: string }> = {
	"adapters/types.ts": { linjer: 3, grunn: "skallkommandoer (`cat`)" },
	"lib/file-logger.ts": { linjer: 1, grunn: "motornavnet i loggfilnavnet" },
	"lib/prd-template.ts": { linjer: 1, grunn: "engelske banneord" },
	"lib/injection-patterns.ts": { linjer: 8, grunn: "engelske injeksjonsfraser og nøkkelformater" },
	"lib/sanitizer.ts": { linjer: 1, grunn: "base64" },
	"lib/response-format.ts": { linjer: 1, grunn: "`\\w` inne i en klasse med `\\p{L}`" },
	"handlers/implicit-sentiment.ts": { linjer: 1, grunn: "engelske ord etter en karakter" },
	"handlers/tab-state.ts": { linjer: 1, grunn: "`\\w` inne i en klasse med `\\p{L}`, som `extractSpokenLine`" },
	"handlers/security-validator.ts": { linjer: 8, grunn: "nøkkelformater" },
	"handlers/response-capture.ts": { linjer: 1, grunn: "`[AGENT:<navn>]`, agentnavnene er ASCII" },
	"handlers/skill-guard.ts": { linjer: 1, grunn: "plugin-prefikset i skillnavnet" },
};

function tsFiler(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
		const sti = join(dir, d.name);
		if (d.isDirectory()) return d.name === "node_modules" ? [] : tsFiler(sti);
		return d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [sti] : [];
	});
}

/** Antall kodelinjer med en ASCII-klasse, per fil relativt til `pai-core/`. */
function tellinger(): Record<string, number> {
	const ut: Record<string, number> = {};
	for (const fil of tsFiler(KJERNE)) {
		const n = readFileSync(fil, "utf8")
			.split("\n")
			.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && ASCII_KLASSE.test(l)).length;
		if (n > 0) ut[relative(KJERNE, fil)] = n;
	}
	return ut;
}

describe("ASCII-klasser i pai-core er valgt med vilje (K30)", () => {
	test("hver fil med en ASCII-klasse står i tellingen, med riktig antall", () => {
		const forventet = Object.fromEntries(Object.entries(ASCII_MED_VILJE).map(([f, { linjer }]) => [f, linjer]));
		// Rød her: en regex som leser fritekst, skal ha `\p{L}` (med `u`). Er ASCII
		// riktig, før linja opp i ASCII_MED_VILJE med grunnen.
		expect(tellinger()).toEqual(forventet);
	});
});

describe("rettingene fra K30", () => {
	test("M-53: talelinja finnes med et DA-navn med mellomrom eller æøå", () => {
		for (const navn of ["Ada Lovelace", "Bjørn-Åge", "Kari"]) {
			const s = parseStructuredResponse(`📋 SUMMARY: Ferdig.\n🗣️ ${navn}: Synken finner repoet selv.\n`);
			expect(s.completed, navn).toBe("Synken finner repoet selv.");
		}
	});

	test("tab-state: «Done.» og et ord med kolon er ikke en talelinje, æøå teller", () => {
		expect(isValidVoiceCompletion("Done.")).toBe(false);
		expect(isValidVoiceCompletion("Økt: ")).toBe(false);
		expect(isValidVoiceCompletion("Nå går det")).toBe(true);
		expect(isValidVoiceCompletion("Åøæ")).toBe(true);
	});

	test("sanitizer: bokstaver med mellomrom trekkes sammen også med æøå", () => {
		expect(collapseObfuscatedSpacing("h å n d s k e")).toBe("håndske");
		expect(collapseObfuscatedSpacing("i g n o r e")).toBe("ignore");
		expect(collapseObfuscatedSpacing("En vanlig setning")).toBe("En vanlig setning");
	});

	test("learning-capture: en linje som begynner med Æ, Ø eller Å avslutter læringen", () => {
		const l = extractLearningsFromText(
			"Learning: Regexer som leser fritekst, trenger \\p{L} for æøå\nØvrig: dette hører ikke med",
			"test"
		);
		expect(l.length).toBe(1);
		expect(JSON.stringify(l[0])).not.toContain("Øvrig");
	});
});
