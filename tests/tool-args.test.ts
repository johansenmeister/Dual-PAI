/**
 * Verktøyargumenter på tvers av motorer — ende til ende
 *
 * K-09 og M-32 er samme defekt fra hver sin side. Kjernen leste ETT
 * feltnavn per sted, og stedene var uenige:
 *
 *   K-09  sikkerhetsvakten leste kun `filePath`. Claudes Write/Edit sender
 *         `file_path`, så Write til `~/.ssh/authorized_keys` ga `{}` fra
 *         den ekte hooken — målt 2026-09-24.
 *   M-32  PRD-synken leste kun `file_path || path`. OpenCodes write/edit
 *         sender `filePath`, så registeret ble aldri skrevet på OpenCode.
 *
 * Testene her går gjennom de EKTE inngangene — Claude-adapteren inn,
 * `dispatch`, utdataformen ut — fordi en enhetstest av vakten alene besto
 * hele tiden K-09 sto åpen: den kalte vakten med OpenCodes form.
 *
 * @module tests/tool-args
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, sessionKeyFor } from "../.opencode/pai-core";
import { captureAgentOutput } from "../.opencode/pai-core/handlers/agent-capture";
import { validateAgentExecution } from "../.opencode/pai-core/handlers/agent-execution-guard";
import { extractTaskInfo } from "../.opencode/pai-core/handlers/session-registry";
import { isShellTool, isSubagentTool, kanoniskeArgs, målsti } from "../.opencode/pai-core/lib/tool-names";
import { tilKjernehendelser } from "../claude-plugin/src/adapter/in";
import { tilHookUtdata } from "../claude-plugin/src/adapter/out";

let paiHome: string;
const forrigeHome = process.env.PAI_HOME;

beforeAll(() => {
	// Vakten skriver revisjonslinjer og PRD-synken skriver et register, begge
	// under STATE/. Ikke i det ekte MEMORY-treet.
	paiHome = mkdtempSync(join(tmpdir(), "pai-tool-args-"));
	process.env.PAI_HOME = paiHome;
});

afterAll(() => {
	if (forrigeHome === undefined) delete process.env.PAI_HOME;
	else process.env.PAI_HOME = forrigeHome;
	rmSync(paiHome, { recursive: true, force: true });
});

/** Claude-payload → kjernen → det Claude Code faktisk får tilbake. */
async function claudePreToolUse(toolName: string, toolInput: Record<string, unknown>) {
	const [hendelse] = tilKjernehendelser({
		hook_event_name: "PreToolUse",
		session_id: "tool-args-test",
		cwd: "/tmp",
		tool_name: toolName,
		tool_input: toolInput,
		tool_use_id: "t1",
	});
	return JSON.parse(tilHookUtdata("PreToolUse", await dispatch(hendelse)));
}

describe("K-09: sikkerhetsvakten ser Claudes feltnavn", () => {
	test("Write til en nøkkelfil nektes", async () => {
		const ut = await claudePreToolUse("Write", {
			file_path: join(process.env.HOME ?? "/home/x", ".ssh/authorized_keys"),
			content: "ssh-ed25519 AAAA",
		});
		expect(ut.hookSpecificOutput?.permissionDecision).toBe("deny");
	});

	test("Edit til en nøkkelfil nektes", async () => {
		const ut = await claudePreToolUse("Edit", {
			file_path: "/home/x/.ssh/id_ed25519",
			old_string: "a",
			new_string: "b",
		});
		expect(ut.hookSpecificOutput?.permissionDecision).toBe("deny");
	});

	test("en vanlig Write slipper gjennom — vakten nekter ikke alt", async () => {
		const ut = await claudePreToolUse("Write", { file_path: "/tmp/notat.md", content: "hei" });
		expect(ut).toEqual({});
	});
});

describe("M-32: PRD-synken ser OpenCodes feltnavn", () => {
	function lagPrd(økt: string): string {
		const katalog = join(paiHome, "MEMORY", "WORK", økt);
		mkdirSync(katalog, { recursive: true });
		const sti = join(katalog, "PRD.md");
		writeFileSync(sti, `---\nid: ${økt}\nstatus: IN_PROGRESS\n---\n\n# PRD\n`);
		return sti;
	}

	function register(): Record<string, unknown> {
		const sti = join(paiHome, "MEMORY", "STATE", "prd-registry.json");
		return existsSync(sti) ? JSON.parse(readFileSync(sti, "utf-8")).sessions : {};
	}

	test.each([
		["opencode", "write", "filePath"],
		["claude", "Write", "file_path"],
		// v2 sender `path` (MÅLT 2026-09-25, M2).
		["opencode2", "write", "path"],
	] as const)("%s: %s med `%s` havner i registeret", async (harness, tool, felt) => {
		const økt = `prd-${harness}`;
		const sti = lagPrd(økt);
		await dispatch({
			type: "tool.after",
			harness,
			sessionId: `s-${harness}`,
			sessionKey: sessionKeyFor(harness, `s-${harness}`),
			at: Date.now(),
			cwd: "/tmp",
			tool,
			args: { [felt]: sti, content: "x" },
			result: "ok",
		});
		expect(register()[økt]).toBeDefined();
	});
});

describe("kanoniseringen", () => {
	test("er additiv: motorens eget navn står igjen", () => {
		expect(kanoniskeArgs({ file_path: "/a" })).toEqual({ file_path: "/a", filePath: "/a" });
	});

	test("kjernens navn vinner når begge finnes", () => {
		expect(kanoniskeArgs({ file_path: "/motor", filePath: "/kjerne" }).filePath).toBe("/kjerne");
	});

	test("tåler at args ikke er et objekt", () => {
		expect(kanoniskeArgs(undefined)).toEqual({});
		expect(kanoniskeArgs("streng")).toEqual({});
		expect(målsti(null)).toBe("");
	});

	test("v2s `path` blir `filePath`", () => {
		expect(kanoniskeArgs({ path: "/a", content: "x" })).toEqual({ path: "/a", filePath: "/a", content: "x" });
		expect(målsti({ path: "/a" })).toBe("/a");
	});

	test("målsti leser ikke en ikke-streng", () => {
		expect(målsti({ filePath: { sti: "/a" } })).toBe("");
	});
});

describe("any → unknown: narrowingen bevarer atferden", () => {
	// Ett felt som ikke er en streng skal telle som fraværende — aldri kaste,
	// og aldri havne stringifisert i en fil.

	test("tom `output` hopper over fangsten framfor å lagre `{\"output\": \"\"}`", async () => {
		const ut = await captureAgentOutput({ subagent_type: "Intern" }, { output: "" });
		expect(ut).toEqual({ success: true });
	});

	test("`output` som ikke er en streng faller videre til `result`", async () => {
		const ut = await captureAgentOutput(
			{ subagent_type: "Intern", description: "test" },
			{ output: 42, result: "et svar som er langt nok til å fanges" }
		);
		expect(ut.success).toBe(true);
		expect(readFileSync(ut.filepath as string, "utf-8")).toContain("et svar som er langt nok");
	});

	test("oppgaveinfo tåler felt av feil type", () => {
		expect(extractTaskInfo({ subagent_type: 7, prompt: { tekst: "x" } })).toEqual({
			agentType: "unknown",
			description: "unknown task",
		});
		expect(extractTaskInfo(undefined).agentType).toBe("unknown");
	});

	test("Explore-sjekken fyrer for Claudes `Explore`, ikke bare OpenCodes `explore`", async () => {
		const prompt = "search for the config loader and report which file it is in, with context";
		for (const subagent_type of ["explore", "Explore"]) {
			const ut = await validateAgentExecution({ subagent_type, prompt });
			expect(ut.reason).toMatch(/Explore agent/);
		}
	});
});

describe("v2s verktøynavn", () => {
	// Samme feilklasse som M-17 (`Task` mot `Agent`): et navn kjernen ikke
	// kjenner, gjør at vakten eller agentgrenen aldri kjører, uten at noe feiler.
	test("`subagent` er subagent-verktøyet", () => {
		expect(isSubagentTool("subagent")).toBe(true);
	});

	test("`shell` er skallverktøyet", () => {
		expect(isShellTool("shell")).toBe(true);
	});
});
