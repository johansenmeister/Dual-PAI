/**
 * Kontrakt-test: hendelsene batch 4 flyttet inn i pai-core
 *
 * Dekker `context.build`, `user.message`, `assistant.message` og `shell.env`.
 *
 * HVA SOM BEVISST IKKE TESTES HER: `session.start` og `session.end`. Den
 * første kaller `restoreSkillFiles()`, som kjører `git restore` på
 * modifiserte SKILL.md-filer — en test som kjører den ville kunne reversere
 * ekte redigeringer i arbeidstreet. Den andre kjører hele teardown-kjeden.
 * Begge dekkes av den interaktive røyktesten i stedet. En test som er farlig
 * å kjøre er verre enn ingen test.
 *
 * Alle skrivinger isoleres via PAI_HOME til en temp-katalog. Uten det ville
 * suiten forurenset brukerens MEMORY-tre.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitiesFor, dispatch } from "../.opencode/pai-core";
import type { PaiEvent } from "../.opencode/pai-core";

let tempHome: string;
const opprinnelig: Record<string, string | undefined> = {};

function husk(nøkkel: string): void {
	opprinnelig[nøkkel] = process.env[nøkkel];
}

function base(overstyr: Partial<Record<string, unknown>> = {}) {
	return {
		harness: "opencode2" as const,
		sessionId: "ses_test",
		sessionKey: "o2_ses_test",
		at: 1_700_000_000_000,
		cwd: "/tmp",
		...overstyr,
	};
}

beforeAll(() => {
	tempHome = mkdtempSync(join(tmpdir(), "pai-dispatch-test-"));
	for (const nøkkel of ["PAI_HOME", "PAI_ENABLED", "PAI_OBSERVABILITY_ENABLED", "DA"]) {
		husk(nøkkel);
	}
	process.env.PAI_HOME = tempHome;
	// Emitterne prøver ellers å nå observability-serveren for hver hendelse.
	process.env.PAI_OBSERVABILITY_ENABLED = "false";
});

afterAll(async () => {
	// Rydd arbeidsøkten user.message-testene opprettet.
	//
	// Nødvendig fordi `work-tracker` holder `currentSession` i en
	// MODULVARIABEL. Bun kjører testfilene i samme prosess, så en økt som
	// står igjen her får neste testfil til å tro at den allerede har en
	// aktiv arbeidsøkt — og da hopper den over opprettelsen og skriver
	// ingenting. Det er samme modulvariabel planen kaller den harde
	// blokkeren for batch 5; her er den observert i praksis.
	try {
		const { completeWorkSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		await completeWorkSession("ses_test");
	} catch {
		// Opprydding skal aldri velte suiten.
	}

	for (const [nøkkel, verdi] of Object.entries(opprinnelig)) {
		if (verdi === undefined) delete process.env[nøkkel];
		else process.env[nøkkel] = verdi;
	}
	rmSync(tempHome, { recursive: true, force: true });
});

describe("context.build — PAI_ENABLED-porten", () => {
	// Porten krever eksakt "1", ikke bare truthy. Det er ikke pedanteri:
	// PAI_ENABLED=0 og PAI_ENABLED=false er begge truthy som strenger, og
	// ville slått konteksten PÅ om sjekken var løs.
	test.each([
		["uten variabel", undefined],
		["tom streng", ""],
		["null som streng", "0"],
		["false som streng", "false"],
		["stor bokstav", "TRUE"],
		["en med mellomrom", " 1"],
	])("%s gir ingen kontekst", async (_navn, verdi) => {
		if (verdi === undefined) delete process.env.PAI_ENABLED;
		else process.env.PAI_ENABLED = verdi;

		const result = await dispatch({ ...base(), type: "context.build" } as PaiEvent);
		expect(result.additionalContext).toBeUndefined();
		expect(result.notes).toContain("pai-disabled");
	});

	test('PAI_ENABLED="1" gir kontekst i PAI-innpakningen', async () => {
		process.env.PAI_ENABLED = "1";
		const result = await dispatch({ ...base(), type: "context.build" } as PaiEvent);

		expect(result.additionalContext).toHaveLength(1);
		const kontekst = result.additionalContext?.[0] ?? "";
		// Innpakningen er kontrakten mot begge motorene. Endres den, endres
		// hvordan modellen ser konteksten — da skal denne testen falle.
		expect(kontekst).toContain("<system-reminder>");
		expect(kontekst).toContain("PAI CONTEXT");
		expect(kontekst).toContain("</system-reminder>");
		expect(kontekst.length).toBeGreaterThan(1000);
	});

	test("resultatet er en liste, ikke en streng", async () => {
		// OpenCode tar `output.system.push(...)`, Claude Code én streng.
		// Formen må være listen, ellers spreader adapteren en streng til tegn.
		process.env.PAI_ENABLED = "1";
		const result = await dispatch({ ...base(), type: "context.build" } as PaiEvent);
		expect(Array.isArray(result.additionalContext)).toBe(true);
	});
});

describe("shell.env — miljø til tilstandsløse skall", () => {
	test("kjøretidsnøklene settes", async () => {
		const result = await dispatch({
			...base({ cwd: "/home/user/repos/pai" }),
			type: "shell.env",
		} as PaiEvent);

		expect(result.env?.PAI_CONTEXT).toBe("1");
		expect(result.env?.PAI_SESSION_ID).toBe("ses_test");
		expect(result.env?.PAI_WORK_DIR).toBe("/home/user/repos/pai");
		expect(result.env?.PAI_VERSION).toBe("3.0");
	});

	test("tom sesjons-ID blir unknown, ikke tom streng", async () => {
		// Tom streng ville gitt skript en variabel som ser satt ut og ikke er
		// det. `unknown` er i det minste ærlig.
		const result = await dispatch({
			...base({ sessionId: "" }),
			type: "shell.env",
		} as PaiEvent);
		expect(result.env?.PAI_SESSION_ID).toBe("unknown");
	});

	test("passthrough-nøkkel følger med kun når den finnes i process.env", async () => {
		const før = process.env.PAI_OBSERVABILITY_PORT;
		try {
			delete process.env.PAI_OBSERVABILITY_PORT;
			const uten = await dispatch({ ...base(), type: "shell.env" } as PaiEvent);
			expect(uten.env?.PAI_OBSERVABILITY_PORT).toBeUndefined();

			process.env.PAI_OBSERVABILITY_PORT = "8889";
			const med = await dispatch({ ...base(), type: "shell.env" } as PaiEvent);
			expect(med.env?.PAI_OBSERVABILITY_PORT).toBe("8889");
		} finally {
			if (før === undefined) delete process.env.PAI_OBSERVABILITY_PORT;
			else process.env.PAI_OBSERVABILITY_PORT = før;
		}
	});

	test("nøklene uten leser følger ikke med (#186)", async () => {
		const før = { DA: process.env.DA, TIME_ZONE: process.env.TIME_ZONE, GOOGLE_API_KEY: process.env.GOOGLE_API_KEY };
		try {
			Object.assign(process.env, { DA: "x", TIME_ZONE: "x", GOOGLE_API_KEY: "x" });
			const r = await dispatch({ ...base(), type: "shell.env" } as PaiEvent);
			expect([r.env?.DA, r.env?.TIME_ZONE, r.env?.GOOGLE_API_KEY]).toEqual([undefined, undefined, undefined]);
		} finally {
			for (const [k, v] of Object.entries(før)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});
});

describe("user.message — dedupe er sessionKey-scopet (H-08)", () => {
	test("tom og blanktegns-tekst behandles ikke", async () => {
		for (const tekst of ["", "   ", "\n\t "]) {
			const result = await dispatch({
				...base(),
				type: "user.message",
				text: tekst,
			} as PaiEvent);
			expect(result.notes).toBeUndefined();
		}
	});

	test("samme tekst to ganger i samme økt regnes som duplikat", async () => {
		const tekst = `hei ${Date.now()}`;
		const første = await dispatch({
			...base({ sessionKey: "oc_dedupe_a" }),
			type: "user.message",
			text: tekst,
		} as PaiEvent);
		const andre = await dispatch({
			...base({ sessionKey: "oc_dedupe_a" }),
			type: "user.message",
			text: tekst,
		} as PaiEvent);

		expect(første.notes).not.toContain("duplicate");
		expect(andre.notes).toContain("duplicate");
	});

	test("samme tekst i TO økter dedupes IKKE", async () => {
		// H-08. Uten sessionKey i nøkkelen mistet den andre økten arbeidsøkt,
		// rating og THREAD-innslag i stillhet — den så ut som et duplikat av
		// den første. Dette er hele grunnen til at nøkkelen er scopet.
		const tekst = `identisk melding ${Date.now()}`;
		const økt1 = await dispatch({
			...base({ sessionKey: "oc_økt_1" }),
			type: "user.message",
			text: tekst,
		} as PaiEvent);
		const økt2 = await dispatch({
			...base({ sessionKey: "oc_økt_2" }),
			type: "user.message",
			text: tekst,
		} as PaiEvent);

		expect(økt1.notes).not.toContain("duplicate");
		expect(økt2.notes).not.toContain("duplicate");
	});
});

describe("assistant.message — terskelen", () => {
	test.each([
		["tom", ""],
		["kort", "kort svar"],
		["nøyaktig 100 tegn", "x".repeat(100)],
	])("%s behandles ikke", async (_navn, tekst) => {
		const result = await dispatch({
			...base({ harness: "claude" }),
			type: "assistant.message",
			text: tekst,
		} as PaiEvent);
		expect(result).toEqual({});
	});
});

describe("kapabiliteter er per motor, ikke harness-sjekker i koden", () => {
	// Grep på `harness ===` skal kun treffe runtime.ts og adapterne. Ellers
	// blir paritetskravet uetterrettelig.
	test("observability er OpenCode-only", () => {
		expect(capabilitiesFor("claude").observability).toBe(false);
		expect(capabilitiesFor("opencode2").observability).toBe(true);
	});

	test("v2 har sine egne kapabiliteter, målt i fase 0", () => {
		const v2 = capabilitiesFor("opencode2");
		// v2 leser v1-konfigens agentnavn uendret (M5); ingen `pai:`-prefiks.
		expect(v2.agentAliases).toBe(false);
		expect(v2.observability).toBe(true);
	});

	test("voice finnes ikke lenger som kapabilitet", () => {
		// Voice er FJERNET, ikke gated. Den hadde aldri virket her, var
		// utenfor paritetskravet, og bar H-07. Dukker nøkkelen opp igjen, er
		// TTS på vei tilbake — og da skal denne testen si fra.
		expect("voice" in capabilitiesFor("opencode2")).toBe(false);
	});

	test.each(["dbHealth", "skillRestore", "subagentEvents"])(
		"%s er slettet med v1, ikke bare slått av",
		(nøkkel) => {
			// Alle tre fantes bare fordi v1 trengte dem: v1s `conversations.db`,
			// reparasjonen av at v1 skrev om SKILL.md, og Task-veien som v1s
			// eneste subagent-kilde. En av dem tilbake betyr at en v1-vei er på
			// vei inn igjen.
			for (const h of ["opencode2", "claude"] as const) {
				expect(nøkkel in capabilitiesFor(h)).toBe(false);
			}
		}
	);
});

describe("dispatch kaster ALDRI — også for de nye hendelsene", () => {
	const misformede: Array<[string, unknown]> = [
		["context.build uten sessionId", { ...base({ sessionId: "" }), type: "context.build" }],
		["user.message uten text", { ...base(), type: "user.message" }],
		["user.message med text = null", { ...base(), type: "user.message", text: null }],
		["assistant.message uten text", { ...base(), type: "assistant.message" }],
		["shell.env uten cwd", { ...base({ cwd: undefined }), type: "shell.env" }],
		["shell.env med cwd = null", { ...base({ cwd: null }), type: "shell.env" }],
	];

	for (const [navn, event] of misformede) {
		test(`${navn} → resultat, ikke unntak`, async () => {
			const result = await dispatch(event as PaiEvent);
			expect(result).toBeDefined();
			expect(typeof result).toBe("object");
		});
	}
});
