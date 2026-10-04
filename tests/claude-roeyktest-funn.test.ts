/**
 * De to defektene `Tools/ClaudeSmoke.ts` fant på første kjøring (2026-09-27)
 *
 * M-43: revisjonsloggen ble aldri skrevet under Claude Code. Skrivingen var
 * fire-and-forget, og hook-prosessen avslutter med `process.exit(0)` så snart
 * svaret er skrevet. Testen kjører derfor den EKTE hook-prosessen, ikke
 * handleren: i en langlivet prosess (v2, og `bun test`) rakk skrivingen fram,
 * og det var derfor ingen test så det.
 *
 * M-44: agent-aliaset slo opp `join(getPaiHome(), "..")`, som er leksikalsk.
 * Fra `.opencode/` er `getPaiHome()` symlenken `~/.opencode`, og stien ble
 * `~/claude-plugin`. Testen bygger den samme formen: en symlenke til en
 * `.opencode/` som har `claude-plugin/` ved siden av seg.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliasSti, lesAliasTabell, nullstillAliasCache, slåOppAgentAlias } from "../.opencode/pai-core/lib/agent-alias";
import { HOOK_TAK, lesHookKontekst, lesStrøm, miljø, tilleggskontekst } from "../Tools/ClaudeSmoke";
import { CLAUDE_HOOK_TAK } from "../claude-plugin/src/adapter/out";

const ROT = join(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "pai-roeyktest-funn-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("M-43: revisjonen skrives av en hook-prosess som avslutter med en gang", () => {
	test("et blokkert skallkall gir én linje med harness claude", () => {
		const paiHome = join(tmp, "revisjon");
		mkdirSync(join(paiHome, "MEMORY", "STATE"), { recursive: true });
		const payload = {
			hook_event_name: "PreToolUse",
			session_id: "m43-test",
			tool_name: "Bash",
			tool_input: { command: "rm -rf /tmp/m43-finnes-ikke" },
			cwd: tmp,
		};
		const r = Bun.spawnSync([process.execPath, join(ROT, "claude-plugin", "bin", "pai-hook.ts")], {
			stdin: new TextEncoder().encode(JSON.stringify(payload)),
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: process.env.HOME ?? tmp,
				PAI_ENABLED: "1",
				PAI_HARNESS: "claude",
				PAI_HOME: paiHome,
				PAI_LOG_PATH: join(tmp, "m43.log"),
				CLAUDE_PLUGIN_ROOT: join(ROT, "claude-plugin"),
			},
		});
		expect(JSON.parse(r.stdout.toString()).hookSpecificOutput.permissionDecision).toBe("deny");
		const fil = join(paiHome, "MEMORY", "STATE", "security-audit.jsonl");
		expect(existsSync(fil)).toBe(true);
		const linjer = readFileSync(fil, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		expect(linjer).toHaveLength(1);
		expect(linjer[0]).toMatchObject({ tool: "Bash", action: "blocked", harness: "claude" });
	});
});

describe("M-44: agent-alias.json finnes uansett hvor økten starter", () => {
	test("CLAUDE_PLUGIN_ROOT vinner: det er pluginen motoren faktisk lastet", () => {
		expect(aliasSti({ CLAUDE_PLUGIN_ROOT: "/et/sted med mellomrom" })).toBe("/et/sted med mellomrom/agent-alias.json");
	});

	test("uten den: repo-roten via realpath, også gjennom en symlenke til .opencode", () => {
		const repo = join(tmp, "repo");
		mkdirSync(join(repo, ".opencode"), { recursive: true });
		mkdirSync(join(repo, "claude-plugin"));
		writeFileSync(join(repo, "claude-plugin", "agent-alias.json"), JSON.stringify({ plugin: "pai", aliaser: { Intern: "pai:Intern" } }));
		const lenke = join(tmp, "hjem-opencode");
		symlinkSync(join(repo, ".opencode"), lenke);
		const før = process.env.PAI_HOME;
		process.env.PAI_HOME = lenke;
		try {
			expect(aliasSti({})).toBe(join(repo, "claude-plugin", "agent-alias.json"));
			nullstillAliasCache();
			expect(slåOppAgentAlias("Intern", aliasSti({}))).toBe("pai:Intern");
		} finally {
			if (før === undefined) delete process.env.PAI_HOME;
			else process.env.PAI_HOME = før;
			nullstillAliasCache();
		}
	});

	test("cachen er per sti: en sti som mangler, får ikke en annen stis tabell", () => {
		nullstillAliasCache();
		expect(lesAliasTabell(join(ROT, "claude-plugin", "agent-alias.json"))?.plugin).toBe("pai");
		expect(lesAliasTabell(join(tmp, "finnes-ikke", "agent-alias.json"))).toBeNull();
		nullstillAliasCache();
	});
});

describe("M-45: ClaudeSmoke tester treet den ligger i", () => {
	test("OPENCODE_DIR er treets .opencode, også når miljøet har en annen", () => {
		const før = process.env.OPENCODE_DIR;
		process.env.OPENCODE_DIR = join(tmp, "et-annet-tre", ".opencode");
		try {
			expect(miljø({}).OPENCODE_DIR).toBe(join(ROT, ".opencode"));
		} finally {
			if (før === undefined) delete process.env.OPENCODE_DIR;
			else process.env.OPENCODE_DIR = før;
		}
	});
});

describe("ClaudeSmoke: de rene delene", () => {
	test("hook-taket er det samme tallet som adapterens", () => {
		expect(HOOK_TAK).toBe(CLAUDE_HOOK_TAK);
	});

	test("strømmen: banneret hoppes over, hooks, kall, resultater og svaret leses", () => {
		const linjer = [
			"  P A I  banner",
			JSON.stringify({ type: "system", subtype: "init", session_id: "s1", tools: ["Bash"], agents: ["pai:Intern"], mcp_servers: [], plugins: [] }),
			JSON.stringify({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", hook_event: "SessionStart", outcome: "success", output: "{}" }),
			JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo x" } }] } }),
			JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "[PAI Security] nei", is_error: true }] } }),
			JSON.stringify({ type: "assistant", parent_tool_use_id: "t9", message: { content: [{ type: "text", text: "subagentens tekst" }] } }),
			JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ferdig" }] } }),
		].join("\n");
		const s = lesStrøm(linjer);
		expect(s.sesjon).toBe("s1");
		expect(s.init?.agents).toEqual(["pai:Intern"]);
		expect(s.hooks).toEqual([{ navn: "SessionStart:startup", hendelse: "SessionStart", utfall: "success", utdata: "{}" }]);
		expect(s.kall[0]).toMatchObject({ navn: "Bash", feil: true, resultat: "[PAI Security] nei" });
		// En subagents tekst er ikke hovedøktens svar.
		expect(s.svar).toBe("ferdig");
		expect(s.tekst).toEqual(["ferdig"]);
	});

	test("transkriptets hook-kontekst og et hook-svars additionalContext", () => {
		const transkript = [
			JSON.stringify({ attachment: { type: "hook_additional_context", content: ["<persisted-output>\nOutput too large"] } }),
			JSON.stringify({ attachment: { type: "hook_success", content: "" } }),
			"ikke json",
		].join("\n");
		expect(lesHookKontekst(transkript)).toEqual(["<persisted-output>\nOutput too large"]);
		expect(tilleggskontekst(JSON.stringify({ hookSpecificOutput: { additionalContext: "PAI: kort" } }))).toBe("PAI: kort");
		expect(tilleggskontekst("{}")).toBe("");
	});
});
