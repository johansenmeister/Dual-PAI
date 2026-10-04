/**
 * Kontrakt-test: PatchClaudeSettings
 *
 * `~/.claude/settings.json` er brukerens fil, ikke PAIs. Tre regler gjør den
 * trygg å røre automatisk, og alle tre kan brytes uten at noe FEILER — de
 * ville bare stille overskrevet et valg brukeren tok:
 *
 *   1. Ingenting utenfor `env` røres. `model`, `theme`, `tui` og
 *      `permissions` er brukerens domene.
 *   2. En verdi brukeren allerede har satt overskrives ALDRI.
 *      `CLAUDE_CODE_ENABLE_TODO_TOOLS=false` er et gyldig valg.
 *   3. Andre kjøring gir null endringer.
 *
 * Testene speiler mønsteret fra `security-validator.test.ts`: assert både at
 * riktig oppførsel skjer OG at den gale ikke gjør det. Det var den
 * asymmetrien som avslørte `filePath`/`file_path`-feilen.
 *
 * MÅLT 2026-09-22 og derfor IKKE testet her: `enabledMcpjsonServers` gjelder
 * prosjektets egen `.mcp.json`, ikke en plugins. Plugin-MCP-verktøyene lastet
 * ende-til-ende med en `settings.json` uten nøkkelen.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAI_ENV, flett, lesInnstillinger, patch, skrivInnstillinger } from "../Tools/PatchClaudeSettings";

function temp(): string {
	return join(mkdtempSync(join(tmpdir(), "pai-settings-")), "settings.json");
}

describe("flett — regel 1: ingenting utenfor env", () => {
	test("bevarer model, theme, tui og permissions uendret", () => {
		const før = {
			tui: "fullscreen",
			theme: "dark",
			model: "opus[1m]",
			permissions: { allow: ["Bash(ls:*)"] },
		};
		const { resultat } = flett(før);

		expect(resultat.tui).toBe("fullscreen");
		expect(resultat.theme).toBe("dark");
		expect(resultat.model).toBe("opus[1m]");
		expect(resultat.permissions).toEqual({ allow: ["Bash(ls:*)"] });
	});

	test("legger ikke til nøkler på toppnivå utover env", () => {
		const { resultat } = flett({ model: "opus[1m]" });
		expect(Object.keys(resultat).sort()).toEqual(["env", "model"]);
	});

	test("rører ikke enabledMcpjsonServers — plugin-MCP går ikke via den", () => {
		const { resultat } = flett({});
		expect(resultat.enabledMcpjsonServers).toBeUndefined();
	});

	test("muterer ikke objektet den fikk inn", () => {
		const før: Record<string, unknown> = { model: "opus[1m]" };
		flett(før);
		expect(før.env).toBeUndefined();
	});
});

describe("flett — regel 2: brukerens verdi vinner", () => {
	test("overskriver ikke en avvikende verdi", () => {
		const før = { env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "false" } };
		const { resultat, endringer } = flett(før);

		expect((resultat.env as Record<string, string>).CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe("false");
		const e = endringer.find((x) => x.nøkkel === "CLAUDE_CODE_ENABLE_TODO_TOOLS");
		expect(e?.utfall).toBe("avvik");
		expect(e?.nåværende).toBe("false");
	});

	test("bevarer env-nøkler PAI ikke kjenner", () => {
		const { resultat } = flett({ env: { MIN_EGEN: "verdi" } });
		expect((resultat.env as Record<string, string>).MIN_EGEN).toBe("verdi");
	});
});

describe("flett — regel 3: idempotens", () => {
	test("andre fletting gir ingen nye nøkler", () => {
		const første = flett({ model: "opus[1m]" });
		expect(første.endringer.some((e) => e.utfall === "lagt-til")).toBe(true);

		const andre = flett(første.resultat);
		expect(andre.endringer.some((e) => e.utfall === "lagt-til")).toBe(false);
		expect(andre.resultat).toEqual(første.resultat);
	});
});

describe("flett — formen på env", () => {
	test("tom fil gir alle nøklene", () => {
		const { resultat } = flett({});
		expect(resultat.env).toEqual({ ...PAI_ENV });
	});

	for (const [navn, verdi] of [
		["null", null],
		["streng", "nei"],
		["array", []],
	] as const) {
		test(`env som ${navn} erstattes framfor å krasje`, () => {
			const { resultat } = flett({ env: verdi } as Record<string, unknown>);
			expect(resultat.env).toEqual({ ...PAI_ENV });
		});
	}
});

describe("PAI_ENV — hva vi lover å sette", () => {
	test("tasksystemets nøkkel er med (brukeren ba om synlig tasksystem)", () => {
		expect(PAI_ENV.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe("true");
	});

	test("selvoppdateringen slås av, men ikke manuelle installasjoner (C1)", () => {
		expect(PAI_ENV.DISABLE_AUTOUPDATER).toBe("1");
		// DISABLE_UPDATES stenger også `claude install <versjon>`, som er bumpen.
		expect(PAI_ENV.DISABLE_UPDATES).toBeUndefined();
	});

	test("PAI_ENABLED er IKKE med — den hører til launcherens spawn-env", () => {
		expect(PAI_ENV.PAI_ENABLED).toBeUndefined();
	});

	test("ingen hemmeligheter", () => {
		for (const nøkkel of Object.keys(PAI_ENV)) {
			expect(nøkkel).not.toMatch(/TOKEN|SECRET|PASSWORD|_KEY$/);
		}
	});
});

describe("disk", () => {
	test("patch skriver, og andre kjøring rører ikke fila", () => {
		const sti = temp();
		writeFileSync(sti, JSON.stringify({ model: "opus[1m]" }), "utf-8");

		const første = patch(sti);
		expect(første.some((e) => e.utfall === "lagt-til")).toBe(true);
		const etterFørste = readFileSync(sti, "utf-8");

		const andre = patch(sti);
		expect(andre.some((e) => e.utfall === "lagt-til")).toBe(false);
		expect(readFileSync(sti, "utf-8")).toBe(etterFørste);
	});

	test("tørrkjøring skriver ingenting", () => {
		const sti = temp();
		const endringer = patch(sti, true);
		expect(endringer.some((e) => e.utfall === "lagt-til")).toBe(true);
		expect(existsSync(sti)).toBe(false);
	});

	test("manglende fil gir tomt objekt, ikke kast", () => {
		expect(lesInnstillinger(join(tmpdir(), "finnes-ikke-", String(Date.now())))).toEqual({});
	});

	test("ødelagt JSON kaster framfor å overskrives i stillhet", () => {
		const sti = temp();
		writeFileSync(sti, "{ dette er ikke json", "utf-8");
		expect(() => lesInnstillinger(sti)).toThrow();
	});

	test("skriving er atomisk og etterlater ingen temp-fil", () => {
		const sti = temp();
		skrivInnstillinger(sti, { env: { A: "1" } });
		expect(JSON.parse(readFileSync(sti, "utf-8"))).toEqual({ env: { A: "1" } });
		expect(existsSync(`${sti}.tmp.${process.pid}`)).toBe(false);
	});
});
