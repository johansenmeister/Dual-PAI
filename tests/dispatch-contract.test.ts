/**
 * Kontrakt-test: pai-core/dispatch og sesjonsnøkler
 *
 * Invarianten «dispatch kaster ALDRI» er strukturfiksen for K-07. Den er
 * verdiløs som kommentar — her bevises den tabelldrevet med misformede
 * hendelser.
 *
 * Fail-open ved intern feil er et bevisst valg, ikke en tilfeldighet:
 * en bug i vakten skal ikke kunne låse brukeren ute av eget verktøy.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, sessionKeyFor } from "../.opencode/pai-core";
import type { PaiEvent } from "../.opencode/pai-core";

// PAI_HOME-isolasjon. Fila trengte det ikke i batch 2, da `tool.after` var
// et rent no-op. Batch 4 gjorde den til en full fanout, og da begynte
// `trackAlgorithmState` å skrive `algorithm-state-ses_test.json` inn i
// brukerens EKTE MEMORY-tre. Oppdaget først da fila dukket opp i en
// STATE-listing under røyktesting.
let tempHome: string;
let opprinneligHome: string | undefined;

beforeAll(() => {
	tempHome = mkdtempSync(join(tmpdir(), "pai-dispatch-contract-"));
	opprinneligHome = process.env.PAI_HOME;
	process.env.PAI_HOME = tempHome;
});

afterAll(() => {
	if (opprinneligHome === undefined) delete process.env.PAI_HOME;
	else process.env.PAI_HOME = opprinneligHome;
	rmSync(tempHome, { recursive: true, force: true });
});

const base = {
	harness: "opencode2" as const,
	sessionId: "ses_test",
	sessionKey: "o2_ses_test",
	at: 1_700_000_000_000,
	cwd: "/tmp",
};

describe("sessionKeyFor — nøkkelen alle STATE-filnavn bygger på", () => {
	test("nøkkelen er aldri lik den rå ID-en", () => {
		// Ellers kan en fil skrevet før innføringen forveksles med én etter.
		expect(sessionKeyFor("opencode2", "ses_abc")).not.toBe("ses_abc");
	});

	test("samme rå ID under opencode2 og claude gir aldri samme nøkkel", () => {
		// De deler MEMORY-tre. En kollisjon her ville latt den ene overskrive
		// den andres tilstand uten noe spor.
		expect(sessionKeyFor("opencode2", "ses_abc")).not.toBe(sessionKeyFor("claude", "ses_abc"));
	});

	test("motorprefikset er stabilt", () => {
		// v1s `oc_` er pensjonert sammen med v1. Nøkler med det prefikset
		// ligger fortsatt i eldre STATE-filer, og `pruneStaleState` tar dem.
		expect(sessionKeyFor("opencode2", "ses_abc")).toBe("o2_ses_abc");
		expect(sessionKeyFor("claude", "ses_abc")).toBe("cc_ses_abc");
	});

	test.each([
		["tom streng", ""],
		["kun blanktegn", "   "],
		["undefined", undefined],
		["null", null],
	])("%s gir unknown-nøkkel framfor å kaste", (_navn, verdi) => {
		expect(sessionKeyFor("opencode2", verdi as never)).toBe("o2_unknown");
	});

	test.each([
		["skråstrek", "a/b"],
		["punktum-traversering", "../x"],
		["mellomrom", "a b"],
		["nullbyte-lignende", "a\u0000b"],
	])("%s saneres til et trygt filnavn", (_navn, rå) => {
		const nøkkel = sessionKeyFor("opencode2", rå);
		expect(nøkkel).toMatch(/^o2_[A-Za-z0-9_-]+$/);
		expect(nøkkel).not.toContain("/");
		expect(nøkkel).not.toContain("..");
	});

	test("to ulike ID-er gir aldri samme nøkkel", () => {
		expect(sessionKeyFor("opencode2", "ses_a")).not.toBe(sessionKeyFor("opencode2", "ses_b"));
	});
});

describe("dispatch kaster ALDRI (K-07-invarianten)", () => {
	const misformede: Array<[string, unknown]> = [
		["tool.before uten args", { ...base, type: "tool.before", tool: "bash" }],
		["tool.before med args = null", { ...base, type: "tool.before", tool: "bash", args: null }],
		["tool.before med tomt verktøynavn", { ...base, type: "tool.before", tool: "", args: {} }],
		["tom sessionId", { ...base, sessionId: "", type: "tool.before", tool: "read", args: {} }],
		["permission.ask uten felter", { ...base, type: "permission.ask" }],
		["tool.after uten result", { ...base, type: "tool.after", tool: "bash", args: {} }],
		["ukjent hendelsestype", { ...base, type: "finnes.ikke" }],
		["tomt objekt", {}],
		["null", null],
	];

	for (const [navn, event] of misformede) {
		test(`${navn} → resultat, ikke unntak`, async () => {
			const result = await dispatch(event as PaiEvent);
			expect(result).toBeDefined();
			expect(typeof result).toBe("object");
		});
	}
});

describe("blokkering er en returverdi, ikke et unntak", () => {
	test("farlig kommando gir deny med begrunnelse", async () => {
		const result = await dispatch({
			...base,
			type: "tool.before",
			tool: "bash",
			args: { command: "rm -rf /" },
		});
		expect(result.permission).toBe("deny");
		expect(result.reason).toBeTruthy();
		// Beskjeden til modellen må finnes — ellers får den bare en tom nekt.
		expect(result.message).toBeTruthy();
	});

	test("ufarlig kommando gir ingen innvending", async () => {
		const result = await dispatch({
			...base,
			type: "tool.before",
			tool: "bash",
			args: { command: "echo hei" },
		});
		expect(result.permission).toBeUndefined();
	});

	test("tool.after kan ikke blokkere — kallet er allerede kjørt", async () => {
		const result = await dispatch({
			...base,
			type: "tool.after",
			tool: "bash",
			args: { command: "rm -rf /" },
			result: "noe",
		});
		expect(result.permission).toBeUndefined();
	});
});

describe("permission.ask uten verktøynavn (K-02)", () => {
	// OpenCodes Permission-type har verken tool eller args. Kjernen skal da
	// avstå fra å vurdere framfor å gjette — en gjetning ville gitt vilkårlige
	// avgjørelser på ekte tillatelsesforespørsler.
	test("avstår i stedet for å gjette", async () => {
		const result = await dispatch({ ...base, type: "permission.ask" });
		expect(result.permission).toBeUndefined();
		expect(result.notes?.[0]).toContain("uten verktøynavn");
	});

	test("vurderer når verktøynavnet finnes (Claude-siden)", async () => {
		const result = await dispatch({
			...base,
			harness: "claude",
			type: "permission.ask",
			tool: "bash",
			args: { command: "rm -rf /" },
		});
		expect(result.permission).toBe("deny");
	});
});

describe("fail-open når vakten selv feiler", () => {
	// Uten denne testen er fail-open udokumentert oppførsel: den ytre
	// try/catch-en i dispatch fanger alt uansett, så et throw inne i
	// guardToolCall ville gitt samme sluttresultat og ingen test ville merket
	// forskjellen. Her tvinges validateSecurity til å kaste.
	//
	// MERK: `mock.restore()` reverterer IKKE modulmocks i bun. Uten den
	// eksplisitte gjenopprettingen under lekker mocken til
	// security-validator.test.ts, som da kjører mot en vakt som alltid
	// kaster — og består likevel ikke, men av feil grunn.
	const MODUL = "../.opencode/pai-core/handlers/security-validator";

	test("en kastende validateSecurity blokkerer ikke kallet", async () => {
		const { mock } = await import("bun:test");
		const ekte = { ...(await import(MODUL)) };

		mock.module(MODUL, () => ({
			...ekte,
			validateSecurity: async () => {
				throw new Error("simulert vaktkrasj");
			},
		}));

		try {
			const result = await dispatch({
				...base,
				type: "tool.before",
				tool: "bash",
				args: { command: "rm -rf /" },
			});

			// Selv for en åpenbart farlig kommando: vakten er ute av drift, og
			// valget er at brukeren ikke skal låses ute av eget verktøy.
			expect(result.permission).toBeUndefined();
			expect(result.notes).toContain("guard-failed-open");
		} finally {
			mock.module(MODUL, () => ekte);
		}
	});

	test("den ekte vakten er gjenopprettet etter mocken", async () => {
		// Vaktposten. Slår denne feil, har mocken lekket, og alle
		// sikkerhetstester i andre filer er verdiløse.
		const result = await dispatch({
			...base,
			type: "tool.before",
			tool: "bash",
			args: { command: "rm -rf /" },
		});
		expect(result.permission).toBe("deny");
	});
});
