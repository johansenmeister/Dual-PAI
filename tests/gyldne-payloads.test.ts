/**
 * Gyldne payloads — ekte verktøykall fra motorene gjennom kjernens lesere (K25)
 *
 * K-09, M-32, M-40 og M-50 er samme defekt: en kjernehandler leste et felt
 * motoren aldri sender, falt til en standardverdi, og ingenting feilet.
 * Kontrakttestene så det ikke, fordi argsene var skrevet for hånd, med
 * feltet handleren ventet.
 *
 * Payloadene her er tatt fra motoren selv, av steg G i `Tools/ClaudeSmoke.ts`
 * og `Tools/V2Smoke.ts` med `--fixtures` (se `Tools/lib/gyldne-payloads.ts`).
 * Rediger aldri fixturene for hånd: da måler testen det du trodde, ikke det
 * motoren sender. Hver payload går gjennom adapterens oversettelse og så
 * gjennom nøyaktig den leseren kjernen bruker for klassen, og testen krever
 * verdien modellen ble bedt om, ikke «unknown» eller tom streng.
 *
 * @module tests/gyldne-payloads
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../.opencode/pai-core";
import { extractCommand } from "../.opencode/pai-core/handlers/security-validator";
import { extractTaskInfo } from "../.opencode/pai-core/handlers/session-registry";
import { skillnavnFraArgs, validateSkillInvocation } from "../.opencode/pai-core/handlers/skill-guard";
import { somObjekt } from "../.opencode/pai-core/lib/payload";
import { INJECTION_SCAN_FIELDS } from "../.opencode/pai-core/lib/sanitizer";
import {
	isShellTool,
	isSkillTool,
	isSubagentTool,
	kanoniskeArgs,
	målsti,
	subagentFraArgs,
} from "../.opencode/pai-core/lib/tool-names";
import type { PaiEvent } from "../.opencode/pai-core/types";
import { hendelsesbase, verktøyhendelse } from "../.opencode/pai-adapters/opencode-v2";
import { type ClaudeHookPayload, tilKjernehendelser } from "../claude-plugin/src/adapter/in";
import {
	anonymiser,
	bestilling,
	type Forventet,
	formAvvik,
	type GyldentKall,
	gyldenSjekker,
	KLASSER,
	lesFixture,
	lesteNøkler,
	type Motor,
	plukk,
	skrivFixture,
} from "../Tools/lib/gyldne-payloads";

const REPO = join(import.meta.dir, "..");
let rot: string;
const forrigeHome = process.env.PAI_HOME;

beforeAll(() => {
	// Kjernen slår opp skills og agent-aliaset fra `PAI_HOME` og katalogen
	// ved siden av. Symlenker til repoets EKTE filer gir oppslagene ekte data,
	// mens alt kjernen skriver, havner under temp-katalogen.
	rot = mkdtempSync(join(tmpdir(), "pai-gyldne-"));
	mkdirSync(join(rot, ".opencode"));
	mkdirSync(join(rot, "claude-plugin"));
	symlinkSync(join(REPO, ".opencode", "skills"), join(rot, ".opencode", "skills"));
	for (const fil of ["skill-map.json", "agent-alias.json"]) {
		symlinkSync(join(REPO, "claude-plugin", fil), join(rot, "claude-plugin", fil));
	}
	process.env.PAI_HOME = join(rot, ".opencode");
});

afterAll(() => {
	if (forrigeHome === undefined) delete process.env.PAI_HOME;
	else process.env.PAI_HOME = forrigeHome;
	rmSync(rot, { recursive: true, force: true });
});

const MOTORER: readonly Motor[] = ["claude", "opencode2"];

/** Den rå payloaden gjennom adapterens oversettelse: det kjernen får. */
function gjennomAdapteren(motor: Motor, payload: Record<string, unknown>): Extract<PaiEvent, { type: "tool.before" }> {
	if (motor === "claude") {
		const [hendelse] = tilKjernehendelser(payload as unknown as ClaudeHookPayload);
		if (hendelse?.type !== "tool.before") throw new Error(`ventet tool.before, fikk ${hendelse?.type}`);
		return hendelse;
	}
	const e = payload as { tool: string; input?: unknown; sessionID?: unknown };
	return { ...hendelsesbase(e.sessionID, "/tmp"), type: "tool.before", ...verktøyhendelse(e) };
}

/** Skallkommandoen og målet vakten ser, slik `validateSecurity` gir dem videre. */
function vaktensKommando(h: { tool: string; args: unknown }): string | null {
	return extractCommand({ tool: h.tool, args: kanoniskeArgs(h.args) });
}

async function sjekkKlasse(kall: GyldentKall, h: { tool: string; args: Record<string, unknown> }): Promise<void> {
	const f: Forventet = kall.forventet;
	const kanon = kanoniskeArgs(h.args);
	switch (kall.klasse) {
		case "shell":
			expect(isShellTool(h.tool)).toBe(true);
			expect(vaktensKommando(h)).toBe(f.kommando ?? "");
			return;
		case "write":
			expect(vaktensKommando(h)).toBe(`write:${f.sti}`);
			expect(målsti(h.args)).toBe(f.sti ?? "");
			// Injeksjonsskanningen leser bare feltene i lista.
			expect(INJECTION_SCAN_FIELDS.some((felt) => String(kanon[felt] ?? "").includes(f.innhold ?? "\0"))).toBe(true);
			return;
		case "edit":
			expect(vaktensKommando(h)).toBe(`edit:${f.sti}`);
			expect(målsti(h.args)).toBe(f.sti ?? "");
			expect(kanon.oldString).toBe(f.gammel);
			expect(kanon.newString).toBe(f.ny);
			return;
		case "skill": {
			expect(isSkillTool(h.tool)).toBe(true);
			const navn = skillnavnFraArgs(somObjekt(h.args));
			expect(navn).toBe(f.navn ?? "");
			// Vakten finner skillen under navnet motoren brukte (M-40).
			expect((await validateSkillInvocation(navn, "")).valid).toBe(true);
			return;
		}
		case "subagent": {
			expect(isSubagentTool(h.tool)).toBe(true);
			const { type, prompt } = subagentFraArgs(h.args);
			expect(type).toBe(f.type ?? "");
			expect(prompt).toContain(f.prompt ?? "\0");
			expect(extractTaskInfo(h.args).agentType).toBe(f.type ?? "");
			return;
		}
	}
}

for (const motor of MOTORER) {
	const fil = lesFixture(motor);

	describe(`gyldne payloads: ${motor}`, () => {
		test("fixturen finnes, og har ett kall per klasse", () => {
			expect(fil).not.toBeNull();
			expect(fil?.motor).toBe(motor);
			expect((fil?.kall ?? []).map((k) => k.klasse)).toEqual([...KLASSER]);
		});

		for (const kall of fil?.kall ?? []) {
			test(`${kall.klasse}: kjernen leser ${JSON.stringify(kall.forventet)}`, async () => {
				const h = gjennomAdapteren(motor, kall.payload);
				await sjekkKlasse(kall, h);
			});
		}
	});
}

describe("gyldne payloads: røyktestens formsjekk", () => {
	const lagret = lesFixture("opencode2")?.kall ?? [];
	const medInput = (k: GyldentKall, input: Record<string, unknown>): GyldentKall => ({
		...k,
		payload: { ...k.payload, input },
	});

	test("lik form gir ingen avvik, et omdøpt felt gir ett", () => {
		expect(formAvvik("opencode2", lagret, lagret)).toEqual({ avvik: [], merknader: [] });
		const omdøpt = lagret.map((k) => {
			if (k.klasse !== "write") return k;
			const { path, ...resten } = somObjekt(k.payload.input);
			return medInput(k, { ...resten, filePath: path });
		});
		expect(formAvvik("opencode2", lagret, omdøpt).avvik).toEqual([
			"write: write(content,path) → write(content,filePath) (handlerne leser path)",
		]);
	});

	// K54: Haiku sendte `run_in_background: false` i `Agent` mot samme 2.1.283,
	// og den gamle sjekken sa «Motoren har endret feltene».
	describe("K54: rødt bare når et felt handlerne leser er borte", () => {
		const claude = lesFixture("claude")?.kall ?? [];
		const endre = (klasse: string, f: (args: Record<string, unknown>) => Record<string, unknown>) =>
			claude.map((k) =>
				k.klasse === klasse ? { ...k, payload: { ...k.payload, tool_input: f(somObjekt(k.payload.tool_input)) } } : k
			);

		test("feltene handlerne leser er funnet på verdien, ikke navnet", () => {
			expect(Object.fromEntries(claude.map((k) => [k.klasse, lesteNøkler("claude", k)]))).toEqual({
				shell: ["command"],
				write: ["content", "file_path"],
				edit: ["file_path", "new_string", "old_string"],
				skill: ["skill"],
				subagent: ["prompt", "subagent_type"],
			});
			expect(Object.fromEntries(lagret.map((k) => [k.klasse, lesteNøkler("opencode2", k)]))).toEqual({
				shell: ["command"],
				write: ["content", "path"],
				edit: ["newString", "oldString", "path"],
				skill: ["id"],
				subagent: ["agent", "prompt"],
			});
		});

		test("en ny nøkkel er en merknad, ikke rødt", () => {
			const målt = endre("subagent", (a) => ({ ...a, run_in_background: false }));
			expect(formAvvik("claude", claude, målt)).toEqual({
				avvik: [],
				merknader: ["subagent: ny nøkkel run_in_background"],
			});
		});

		test("en valgfri nøkkel modellen lot være, er en merknad", () => {
			const målt = endre("shell", ({ description: _, ...a }) => a);
			expect(formAvvik("claude", claude, målt)).toEqual({ avvik: [], merknader: ["shell: uten description"] });
			const utenReplaceAll = endre("edit", ({ replace_all: _, ...a }) => a);
			expect(formAvvik("claude", claude, utenReplaceAll).avvik).toEqual([]);
		});

		test("et felt handlerne leser som er borte, er rødt", () => {
			const målt = endre("edit", ({ file_path, ...a }) => ({ ...a, path: file_path }));
			expect(formAvvik("claude", claude, målt).avvik).toEqual([
				"edit: Edit(file_path,new_string,old_string,replace_all) → Edit(new_string,old_string,path,replace_all) (handlerne leser file_path)",
			]);
		});

		test("et annet verktøynavn er rødt, også med samme nøkler", () => {
			const målt = claude.map((k) => (k.klasse === "subagent" ? { ...k, payload: { ...k.payload, tool_name: "Task" } } : k));
			expect(formAvvik("claude", claude, målt).avvik).toEqual([
				"subagent: Agent(description,prompt,subagent_type) → Task(description,prompt,subagent_type)",
			]);
		});

		test("sjekken er grønn med merknaden, og rød med avviket", () => {
			const katalog = mkdtempSync(join(tmpdir(), "pai-gyldne-k54-"));
			try {
				skrivFixture({ motor: "claude", versjon: "x", målt: "x", kilde: "x", kall: claude }, katalog);
				const ny = gyldenSjekker("claude", { kall: endre("subagent", (a) => ({ ...a, run_in_background: false })), mangler: [] }, false, katalog)[1];
				expect(ny?.ok).toBe(true);
				expect(ny?.merknad).toContain("subagent: ny nøkkel run_in_background");
				const borte = gyldenSjekker("claude", { kall: endre("skill", ({ skill, ...a }) => ({ ...a, name: skill })), mangler: [] }, false, katalog)[1];
				expect(borte?.ok).toBe(false);
				expect(borte?.detalj).toContain("handlerne leser skill");
				expect(gyldenSjekker("claude", { kall: claude, mangler: [] }, false, katalog)[1]).toMatchObject({ ok: true, merknad: undefined });
			} finally {
				rmSync(katalog, { recursive: true, force: true });
			}
		});
	});

	test("plukk finner kallet på markøren, uansett feltnavn", () => {
		const bestilt = bestilling("opencode2", "/p");
		const linje = (tool: string, input: unknown) => ({ tool, input });
		const { kall, mangler } = plukk(
			"opencode2",
			[
				linje("write", { helt_nytt_navn: "/p/PRD.md", content: "noe annet" }),
				linje("write", { helt_nytt_navn: "/p/gylden.txt", content: "gylden-for" }),
				linje("shell", { cmd: "echo pai-gylden-skall" }),
			],
			"/p"
		);
		expect(kall.map((k) => k.klasse)).toEqual(["shell", "write"]);
		expect(kall[1]?.payload.input).toEqual({ helt_nytt_navn: "/p/gylden.txt", content: "gylden-for" });
		expect(kall[1]?.forventet).toEqual(bestilt.write.forventet);
		expect(mangler).toEqual(["edit", "skill", "subagent"]);
	});

	test("en fixture som mangler, eller et kall som mangler, er rødt; --fixtures sammenligner ikke", () => {
		const tom = mkdtempSync(join(tmpdir(), "pai-gyldne-fixt-"));
		try {
			const alle = { kall: lagret, mangler: [] };
			expect(gyldenSjekker("opencode2", alle, false, tom).map((s) => s.ok)).toEqual([true, false]);
			expect(gyldenSjekker("opencode2", alle, true, tom).map((s) => s.ok)).toEqual([true]);
			expect(gyldenSjekker("opencode2", { kall: [], mangler: ["shell"] }, true, tom)[0]?.ok).toBe(false);
		} finally {
			rmSync(tom, { recursive: true, force: true });
		}
	});

	test("anonymiser bytter temp-katalogen, sluggen i transkriptstien og hjemmet", () => {
		const ut = anonymiser(
			{ cwd: "/tmp/pai-x-AbC/proj", t: "/home/ola/.claude/projects/-tmp-pai-x-AbC-proj/a.jsonl" },
			"/tmp/pai-x-AbC",
			"/home/ola"
		);
		expect(ut).toEqual({ cwd: "/tmp/pai-gylden/proj", t: "/home/bruker/.claude/projects/-tmp-pai-gylden-proj/a.jsonl" });
	});
});

describe("gyldne payloads: agent-aliaset under Claude", () => {
	test("Agent med det bare navnet skrives om til pluginnavnet (M-44)", async () => {
		const kall = lesFixture("claude")?.kall.find((k) => k.klasse === "subagent");
		expect(kall).toBeDefined();
		if (!kall) return;
		const svar = await dispatch(gjennomAdapteren("claude", kall.payload));
		expect(svar.updatedArgs?.subagent_type).toBe(`pai:${kall.forventet.type}`);
	});
});
