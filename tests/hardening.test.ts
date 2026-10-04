/**
 * Kontrakt-test: herdingen i batch 5c
 *
 * Tre defekter og ett paritetsgrep. Fellesnevneren er at alle bare slår til
 * når to skrivere møtes — og at ingen av dem feiler høylytt når de gjør det.
 * De taper data i stillhet, som er mønsteret i hele dette defektregisteret.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempHome: string;
const lagret: Record<string, string | undefined> = {};

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "pai-hardening-"));
	for (const k of ["PAI_HOME", "PAI_HARNESS", "PAI_LOG_PATH"]) lagret[k] = process.env[k];
	process.env.PAI_HOME = tempHome;
});

afterEach(() => {
	for (const [k, v] of Object.entries(lagret)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(tempHome, { recursive: true, force: true });
});

describe("H-06 — dagens relasjonsnotat trunkeres ikke av en samtidig økt", () => {
	test("to samtidige skrivere beholder begge sine notater", async () => {
		// Defekten var `existsSync` + `writeFile`: to økter som avsluttet
		// samtidig kunne begge se «fila mangler», og den andre skrivingen
		// overskrev dagens notater med bare en header.
		//
		// Promise.all er ikke ekte parallellitet, men det er nok: begge
		// kallene når opprettelsessteget før noen av dem har skrevet ferdig,
		// som er nøyaktig vinduet TOCTOU-luka lå i.
		const { captureRelationshipMemory } = await import(
			"../.opencode/pai-core/handlers/relationship-memory"
		);
		await Promise.all([
			captureRelationshipMemory([], ["📋 SUMMARY: ryddet opp i nettverkskonfigurasjonen"]),
			captureRelationshipMemory([], ["📋 SUMMARY: satte opp overvaking av diskbruk"]),
		]);

		const relDir = join(tempHome, "MEMORY", "RELATIONSHIP");
		const måned = readdirSync(relDir)[0];
		const fil = readdirSync(join(relDir, måned))[0];
		const innhold = readFileSync(join(relDir, måned, fil), "utf-8");

		// Headeren skal stå ÉN gang — to headere betyr at den andre skriveren
		// opprettet fila på nytt oppå den første.
		expect(innhold.match(/# Relationship Notes:/g)).toHaveLength(1);
		// Og ingen av notatene skal være borte.
		expect(innhold).toContain("nettverkskonfigurasjonen");
		expect(innhold).toContain("diskbruk");
	});

	test("opprettelsen er atomisk — flag wx, ikke existsSync", async () => {
		// Testen over kjører de to skriverne samtidig, men treffer ikke
		// TOCTOU-vinduet pålitelig: `Promise.all` gir ikke ekte parallellitet,
		// og interleavingen som utløser feilen er tidsavhengig. Verifisert —
		// en mutasjon tilbake til `existsSync` + `writeFile` består den.
		//
		// Mekanismen må derfor holdes fast i kilden. `flag: "wx"` gjør
		// opprettelsen atomisk: nøyaktig én skriver lykkes, resten får
		// EEXIST. Med `existsSync` først kan to skrivere begge se «mangler»,
		// og den andre trunkerer dagens notater til bare en header.
		const kilde = readFileSync(
			join(import.meta.dir, "..", ".opencode", "pai-core", "handlers", "relationship-memory.ts"),
			"utf-8"
		);
		expect(kilde).toContain('flag: "wx"');
		expect(kilde).not.toContain("existsSync(filepath)");
	});
});

describe("M-06 — parallelle agenter overskriver ikke hverandres fangst", () => {
	test("to agenter i samme sekund får ulike filnavn", async () => {
		// `getTimestamp()` har sekundoppløsning. To agenter som fullførte
		// innenfor samme sekund — helt vanlig ved parallell spawning — fikk
		// identisk filnavn, og den andre overskrev den første i stillhet.
		const { captureAgentOutput } = await import(
			"../.opencode/pai-core/handlers/agent-capture"
		);
		await Promise.all([
			captureAgentOutput(
				{ subagent_type: "Engineer", description: "samme sekund" },
				"Dette er svaret fra den første agenten"
			),
			captureAgentOutput(
				{ subagent_type: "Engineer", description: "samme sekund" },
				"Dette er svaret fra den andre agenten"
			),
		]);

		const researchDir = join(tempHome, "MEMORY", "RESEARCH");
		const måned = readdirSync(researchDir)[0];
		const filer = readdirSync(join(researchDir, måned));

		expect(filer).toHaveLength(2);
		expect(new Set(filer).size).toBe(2);
	});
});

describe("loggen skilles per motor", () => {
	test("uten PAI_HARNESS er stien uendret", async () => {
		// Alle runbooks peker på denne. Den skal ikke flytte seg.
		delete process.env.PAI_HARNESS;
		delete process.env.PAI_LOG_PATH;
		const { getLogFilePath } = await import("../.opencode/pai-core/lib/file-logger");
		expect(getLogFilePath()).toBe("/tmp/pai-opencode-debug.log");
	});

	test("PAI_HARNESS gir motoren sin egen logg", async () => {
		// Uten dette skriver begge motorene i samme fil, og `clearLog()` ved
		// oppstart sletter den andres logg midt i en økt.
		process.env.PAI_HARNESS = "claude";
		delete process.env.PAI_LOG_PATH;
		const { getLogFilePath } = await import("../.opencode/pai-core/lib/file-logger");
		expect(getLogFilePath()).toBe("/tmp/pai-claude-debug.log");
	});

	test("v2 får sin egen logg, ikke v1s", async () => {
		// v1 og v2 kjører side om side under overgangen. Deler de fil, sletter
		// `clearLog()` i den ene den andres logg.
		process.env.PAI_HARNESS = "opencode2";
		delete process.env.PAI_LOG_PATH;
		const { getLogFilePath } = await import("../.opencode/pai-core/lib/file-logger");
		expect(getLogFilePath()).toBe("/tmp/pai-opencode2-debug.log");
	});

	test("PAI_LOG_PATH vinner over utledningen", async () => {
		process.env.PAI_HARNESS = "claude";
		process.env.PAI_LOG_PATH = "/tmp/eksplisitt.log";
		const { getLogFilePath } = await import("../.opencode/pai-core/lib/file-logger");
		expect(getLogFilePath()).toBe("/tmp/eksplisitt.log");
	});

	test("et rart harness-navn blir ikke til en filsti", async () => {
		// Variabelen kommer fra miljøet. Uten mønstersjekken kunne
		// `PAI_HARNESS=../../etc/passwd` bestemt hvor loggen havner.
		process.env.PAI_HARNESS = "../../tmp/ondsinnet";
		delete process.env.PAI_LOG_PATH;
		const { getLogFilePath } = await import("../.opencode/pai-core/lib/file-logger");
		expect(getLogFilePath()).toBe("/tmp/pai-opencode-debug.log");
	});
});

describe("harness-feltet gjør delt MEMORY sporbart", () => {
	test("META.yaml merkes med motoren", async () => {
		const { createWorkSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		process.env.PAI_HARNESS = "claude";
		const res = await createWorkSession("En melding lang nok til å lage en arbeidsøkt", "ses_h");

		expect(res.success).toBe(true);
		const meta = readFileSync(join(res.session?.path as string, "META.yaml"), "utf-8");
		expect(meta).toContain("harness: claude");
	});

	test("META.yaml skiller v2 fra v1", async () => {
		// `currentHarness()` kjente bare `claude`; alt annet ble `opencode`.
		// Uten dette ville v2-økter stått som v1 i arbeidshistorikken.
		const { createWorkSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		process.env.PAI_HARNESS = "opencode2";
		const res = await createWorkSession("En melding lang nok til å lage en v2-arbeidsøkt", "ses_v2");

		expect(res.success).toBe(true);
		const meta = readFileSync(join(res.session?.path as string, "META.yaml"), "utf-8");
		expect(meta).toContain("harness: opencode2");
	});

	test("feltet legges til SLUTT i det createWorkSession skriver", async () => {
		// Additivt er poenget. Legges det først, flytter alle de andre
		// feltene seg, og lesere som regner med rekkefølgen brekker.
		//
		// I drift kommer `effort_level`/`effort_budget` etterpå, appendet av
		// et eget steg. Det denne testen holder fast er at grunnfilen ikke
		// omstokkes.
		const { createWorkSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		delete process.env.PAI_HARNESS;
		const res = await createWorkSession("Nok en melding som er lang nok her", "ses_i");
		const linjer = readFileSync(join(res.session?.path as string, "META.yaml"), "utf-8")
			.trim()
			.split("\n");

		expect(linjer[0]).toStartWith("status:");
		// Uten PAI_HARNESS er motoren v2: standarden var v1 (`opencode`) til
		// v1 ble slettet.
		expect(linjer.at(-1)).toBe("harness: opencode2");
	});

	test("ratings.jsonl merkes med motoren", async () => {
		const { captureRating } = await import("../.opencode/pai-core/handlers/rating-capture");
		process.env.PAI_HARNESS = "claude";
		await captureRating("9", "test");

		const fil = join(tempHome, "MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl");
		expect(existsSync(fil)).toBe(true);
		const siste = readFileSync(fil, "utf-8").trim().split("\n").at(-1) as string;
		expect(JSON.parse(siste).harness).toBe("claude");
	});
});
