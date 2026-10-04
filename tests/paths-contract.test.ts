/**
 * Kontrakt-test: katalogoppløsning og tilstandsfilnavn (lib/paths.ts)
 *
 * Pinner dagens oppførsel før pai-core-refaktoren. Batch 1 innfører
 * getPaiHome() med bakoverkompatibel fallback; disse testene er kvitteringen
 * på at den endringen ikke flytter en eneste sti i det stille.
 *
 * Mønsteret er fra security-validator.test.ts sin «feltnavn-kontrakt»: test at
 * riktig navn brukes OG at det gamle/feilaktige ikke gjør det. Drift mellom
 * lese- og skrivesiden er den dokumenterte fellesnevneren for K-04 og K-05.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as path from "node:path";
import {
	getAlgorithmStateFile,
	getHomePaiDir,
	getPaiHome,
	getCurrentWorkStateFile,
	getLearningDir,
	getMemoryDir,
	getOpenCodeDir,
	getResearchDir,
	getStateDir,
	getWorkDir,
	getYearMonth,
	resolveSessionDir,
	slugify,
} from "../.opencode/pai-core/lib/paths";

describe("getOpenCodeDir — oppløsningsrekkefølge", () => {
	let tmp: string;
	const opprinneligCwd = process.cwd();
	// Preloaden setter PAI_HOME for hele suiten, og overstyringen vinner over
	// fallbackene som testes her.
	const opprinneligHome = process.env.PAI_HOME;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pai-paths-"));
		delete process.env.PAI_HOME;
	});

	afterEach(() => {
		process.chdir(opprinneligCwd);
		fs.rmSync(tmp, { recursive: true, force: true });
		if (opprinneligHome === undefined) delete process.env.PAI_HOME;
		else process.env.PAI_HOME = opprinneligHome;
	});

	test("cwd/.opencode vinner når den finnes", () => {
		const cwdOpencode = path.join(tmp, ".opencode");
		fs.mkdirSync(cwdOpencode);
		process.chdir(tmp);

		expect(getOpenCodeDir()).toBe(cwdOpencode);
		// Asymmetrien: hjemmekatalogen skal IKKE vinne når cwd har en.
		expect(getOpenCodeDir()).not.toBe(path.join(os.homedir(), ".opencode"));
	});

	test("faller tilbake til hjemmekatalogen når cwd ikke har .opencode", () => {
		process.chdir(tmp);
		const home = path.join(os.homedir(), ".opencode");

		// Testen er bare meningsfull på en maskin der ~/.opencode finnes.
		if (fs.existsSync(home)) {
			expect(getOpenCodeDir()).toBe(home);
		} else {
			expect(getOpenCodeDir()).toBe(path.join(tmp, ".opencode"));
		}
	});

	test("returnerer alltid en absolutt sti", () => {
		expect(path.isAbsolute(getOpenCodeDir())).toBe(true);
	});
});

describe("PAI_HOME — overstyringen", () => {
	const opprinnelig = process.env.PAI_HOME;

	afterEach(() => {
		if (opprinnelig === undefined) delete process.env.PAI_HOME;
		else process.env.PAI_HOME = opprinnelig;
	});

	test("satt PAI_HOME vinner over både cwd og hjemmekatalog", () => {
		process.env.PAI_HOME = "/et/eksplisitt/sted";
		expect(getPaiHome()).toBe("/et/eksplisitt/sted");
		expect(getHomePaiDir()).toBe("/et/eksplisitt/sted");
	});

	test("PAI_HOME kollapser de to oppløsningsstrategiene til én sti", () => {
		// Uten overstyring kan de peke ulikt (cwd-først vs $HOME-forankret).
		// Med overstyring SKAL de være identiske — det er hele poenget.
		process.env.PAI_HOME = "/delt/rot";
		expect(getPaiHome()).toBe(getHomePaiDir());
	});

	test("MEMORY-treet følger med overstyringen", () => {
		process.env.PAI_HOME = "/delt/rot";
		expect(getMemoryDir()).toBe(path.join("/delt/rot", "MEMORY"));
		expect(getStateDir()).toBe(path.join("/delt/rot", "MEMORY", "STATE"));
	});

	test.each([
		["tom streng", ""],
		["kun blanktegn", "   "],
	])("%s behandles som usatt — ingen stille omdirigering", (_navn, verdi) => {
		process.env.PAI_HOME = verdi;
		expect(getPaiHome()).not.toBe(verdi);
		expect(getHomePaiDir()).toBe(path.join(os.homedir(), ".opencode"));
	});

	test("usatt PAI_HOME gir uendret oppførsel", () => {
		delete process.env.PAI_HOME;
		// Bakoverkompatibiliteten: getOpenCodeDir er fortsatt cwd-først,
		// getHomePaiDir er fortsatt $HOME-forankret. De to er ikke slått sammen.
		expect(getPaiHome()).toBe(getOpenCodeDir());
		expect(getHomePaiDir()).toBe(path.join(os.homedir(), ".opencode"));
	});
});

describe("avledede kataloger henger på getOpenCodeDir", () => {
	// Hele treet skal flytte seg i takt. Slår disse feil etter batch 1, har
	// getPaiHome() brutt sammenhengen mellom rot og undermapper.
	test("MEMORY ligger rett under roten", () => {
		expect(getMemoryDir()).toBe(path.join(getOpenCodeDir(), "MEMORY"));
	});

	test.each([
		["WORK", getWorkDir],
		["LEARNING", getLearningDir],
		["RESEARCH", getResearchDir],
		["STATE", getStateDir],
	])("%s ligger under MEMORY", (navn, fn) => {
		expect(fn()).toBe(path.join(getMemoryDir(), navn));
	});
});

describe("sesjonsscopede tilstandsfilnavn", () => {
	// K-04/K-05: lesere ventet current-work-${id}.json og
	// algorithm-state-${id}.json mens ingenting skrev dem. Navnene er nå
	// sentralisert her, og disse testene er låsen på at de ikke driver igjen.
	const sesjon = "ses_testABC123";

	test("current-work er sesjonsscopet med sesjons-ID i filnavnet", () => {
		expect(getCurrentWorkStateFile(sesjon)).toBe(
			path.join(getStateDir(), `current-work-${sesjon}.json`)
		);
	});

	test("algorithm-state er sesjonsscopet med sesjons-ID i filnavnet", () => {
		expect(getAlgorithmStateFile(sesjon)).toBe(
			path.join(getStateDir(), `algorithm-state-${sesjon}.json`)
		);
	});

	test("de uskopede legacy-navnene finnes ikke lenger", () => {
		// Motsatt kontrakt av batch 0, og med vilje. `current-work.json` og
		// `algorithm-state.json` var felles skuffer alle økter skrev i, og en
		// leser uten sesjons-ID kunne få en ANNEN økts arbeidskatalog i
		// retur. Med to harness på samme MEMORY-tre var det garantert
		// kollisjon, ikke uflaks.
		//
		// Testen leser modulen som data: eksporteres navnene igjen, er
		// speilene på vei tilbake.
		const kilde = readFileSync(
			path.join(import.meta.dir, "..", ".opencode", "pai-core", "lib", "paths.ts"),
			"utf-8"
		);
		expect(kilde).not.toContain("export function getLegacyCurrentWorkStateFile");
		expect(kilde).not.toContain("export function getLegacyAlgorithmStateFile");
	});

	test("hvert filnavn bærer en sesjons-ID", () => {
		// Vakten mot at en uskopet variant sniker seg inn igjen: det finnes
		// ingen måte å be om en tilstandsfil på uten å oppgi hvilken økt.
		expect(getCurrentWorkStateFile(sesjon)).toContain(sesjon);
		expect(getAlgorithmStateFile(sesjon)).toContain(sesjon);
	});

	test("tilstandsskrivingen er atomisk — temp + rename", async () => {
		// Tilstandsfila leses av EN ANNEN prosess enn den som skriver den:
		// reaperen ved oppstart, og hver Claude-hook. Et halvskrevet dokument
		// ville fått reaperen til å se en økt uten arbeidskatalog og
		// «fullføre» den — altså avslutte brukerens pågående arbeid.
		//
		// Mekanismen kan ikke observeres utenfra i en test, så den holdes
		// fast i kilden. Uten dette kunne temp+rename byttes mot en direkte
		// writeFile uten at noe falt.
		const kilde = readFileSync(
			path.join(import.meta.dir, "..", ".opencode", "pai-core", "lib", "paths.ts"),
			"utf-8"
		);
		expect(kilde).toContain("fs.promises.rename(temp,");
	});

	test("to ulike sesjoner gir aldri samme filnavn", () => {
		expect(getCurrentWorkStateFile("ses_a")).not.toBe(getCurrentWorkStateFile("ses_b"));
		expect(getAlgorithmStateFile("ses_a")).not.toBe(getAlgorithmStateFile("ses_b"));
	});
});

describe("resolveSessionDir tar både absolutt og relativ", () => {
	// Historisk skrev setCurrentWorkPath absolutt sti, som hver leser unntatt
	// getCurrentWorkPath joinet med getWorkDir en gang til — en latent
	// dobbeltjoin. Nye skrivinger er WORK-relative; begge må virke.
	test("relativ sti joines mot WORK", () => {
		expect(resolveSessionDir("2026-09/20260920143522_noe")).toBe(
			path.join(getWorkDir(), "2026-09/20260920143522_noe")
		);
	});

	test("absolutt sti returneres uendret — ingen dobbeltjoin", () => {
		const absolutt = path.join(getWorkDir(), "2026-09/20260920143522_noe");
		expect(resolveSessionDir(absolutt)).toBe(absolutt);
		expect(resolveSessionDir(absolutt)).not.toBe(path.join(getWorkDir(), absolutt));
	});
});

describe("getYearMonth — katalognavnet arbeidsøkter havner i", () => {
	test("formatet er YYYY-MM med nullpolstret måned", () => {
		expect(getYearMonth()).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
	});

	test("matcher inneværende måned i lokal tid", () => {
		const nå = new Date();
		const ventet = `${nå.getFullYear()}-${String(nå.getMonth() + 1).padStart(2, "0")}`;
		expect(getYearMonth()).toBe(ventet);
	});
});

describe("slugify — filnavn fra fri tekst", () => {
	test.each([
		["Hei, kjør ls i hjemmekatalogen", "hei-kj-r-ls-i-hjemmekatalogen"],
		["MANGE   MELLOMROM", "mange-mellomrom"],
		["--ledende og etterfølgende--", "ledende-og-etterf-lgende"],
	])("%s → %s", (inn, ut) => {
		expect(slugify(inn)).toBe(ut);
	});

	test("norske tegn blir bindestrek, ikke translitterert", () => {
		// Dokumenterer dagens tapsgivende oppførsel: æøå overlever ikke.
		// Se arbeidskatalogene i MEMORY/WORK, der «kjør» står som «kj-r».
		expect(slugify("æøå")).toBe("");
		expect(slugify("kjør")).toBe("kj-r");
	});

	test("kappes til 50 tegn", () => {
		expect(slugify("a".repeat(120))).toHaveLength(50);
	});
});

describe("skrivinger mot STATE (isolert PAI_HOME)", () => {
	// Disse testene SKRIVER. Uten PAI_HOME-isolasjon havner filene i
	// brukerens ekte MEMORY-tre — oppdaget ved at en `current-work-*.json`
	// dukket opp i `git status` etter første kjøring.
	let tempHome: string;
	let opprinnelig: string | undefined;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "pai-paths-test-"));
		opprinnelig = process.env.PAI_HOME;
		process.env.PAI_HOME = tempHome;
	});

	afterEach(() => {
		if (opprinnelig === undefined) delete process.env.PAI_HOME;
		else process.env.PAI_HOME = opprinnelig;
		rmSync(tempHome, { recursive: true, force: true });
	});

	test("setCurrentWorkPath krever sessionId", async () => {
		// Før falt et kall uten ID ned i legacy-speilet. Nå finnes ikke det
		// speilet, så et kall uten ID har ingen fil å skrive — og skal si fra
		// framfor å skrive ingensteds i stillhet.
		const { setCurrentWorkPath } = await import("../.opencode/pai-core/lib/paths");
		await expect(setCurrentWorkPath("2026-09/noe")).rejects.toThrow(/sessionId/);
	});

	test("ingen temp-filer blir liggende igjen", async () => {
		// Speilvendingen av kildetesten over: at rename faktisk KJØRER.
		// Feiler den, samler STATE/ opp .tmp-filer som reaperen senere ville
		// prøvd å tolke som arbeidstilstand.
		const { getStateDir, setCurrentWorkPath } = await import("../.opencode/pai-core/lib/paths");
		await setCurrentWorkPath("2026-09/atomisk-test", "ses_atomisk");
		const igjen = readdirSync(getStateDir()).filter((f) => f.includes(".tmp."));
		expect(igjen).toEqual([]);
	});
});
