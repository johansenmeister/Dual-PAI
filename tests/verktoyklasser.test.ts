/**
 * Hvert verktøy motorene gir modellen, er klassifisert (K58).
 *
 * Vakten sjekket navnene `write` og `edit` eksakt. v2 gir `patch` i stedet for
 * begge til en `gpt-`-modell, og Claude har `NotebookEdit`: begge skrev filer
 * forbi sti-vakten og K57 uten at noe sa fra. Testen krever at hvert kjent
 * navn enten er et skriveverktøy vakten ser, eller står i `IKKE_SKRIVENDE` med
 * en grunn. `ClaudeSmoke` gjør det samme mot init-lista i drift.
 */

import { describe, expect, test } from "bun:test";
import { erSkriveverktøy, SKRIVEVERKTØY, skrivemål } from "../.opencode/pai-core/lib/tool-names";
import { klassifiser, CLAUDE_REGLER, V2_REGLER, V2_STIER } from "../.opencode/PAI/Tools/HarnessSync";
import { IKKE_SKRIVENDE, uklassifiserte } from "../Tools/lib/verktoyklasser";

/** Init-lista i `claude -p` 2.1.283, ordrett (MÅLT 2026-10-01, ukjent modell og Haiku ga samme liste). */
const CLAUDE_2_1_283 = [
	"Task", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit", "EnterWorktree",
	"ExitWorktree", "ListAgents", "Monitor", "NotebookEdit", "PushNotification", "Read", "RemoteTrigger",
	"ReportFindings", "ScheduleWakeup", "SendMessage", "ShareOnboardingGuide", "Skill", "TaskCreate",
	"TaskGet", "TaskList", "TaskStop", "TaskUpdate", "ToolSearch", "WebFetch", "WebSearch", "Workflow", "Write",
];

/** `name` i `packages/core/src/tool/plugin/*.ts` i v2 2.0.18 og 2.0.21, pluss Code Modes `execute` (UTLEDET av kilden). */
const V2_2_0_18 = [
	"edit", "glob", "grep", "list_mcp_resources", "read_mcp_resource", "opencode", "session_rename",
	"session_move", "models", "patch", "question", "read", "shell", "skill", "subagent", "webfetch",
	"websearch", "write", "execute",
];

describe("klassifiseringen", () => {
	test.each([
		["Claude Code 2.1.283", CLAUDE_2_1_283],
		["OpenCode v2 2.0.18", V2_2_0_18],
	])("hvert verktøy i %s er klassifisert", (_motor, navn) => {
		expect(uklassifiserte(navn)).toEqual([]);
	});

	test("de skrivende er nøyaktig de vakten kjenner", () => {
		expect(CLAUDE_2_1_283.filter(erSkriveverktøy)).toEqual(["Edit", "NotebookEdit", "Write"]);
		expect(V2_2_0_18.filter(erSkriveverktøy)).toEqual(["edit", "patch", "write"]);
	});

	test("ingen står begge steder: et skriveverktøy kan ikke forklares bort", () => {
		const dobbelt = Object.keys(IKKE_SKRIVENDE).filter((navn) => SKRIVEVERKTØY.has(navn.toLowerCase()));
		expect(dobbelt).toEqual([]);
	});

	test("hvert skriveverktøy gir en sti vakten kan sjekke", () => {
		const args: Record<string, unknown> = {
			write: { path: "/a" },
			edit: { file_path: "/a" },
			notebookedit: { notebook_path: "/a" },
			multiedit: { file_path: "/a" },
			patch: { patchText: "*** Begin Patch\n*** Add File: /a\n+x\n*** End Patch" },
		};
		for (const navn of SKRIVEVERKTØY) expect(skrivemål(navn, args[navn]), navn).toEqual(["/a"]);
	});

	test("et ukjent navn meldes, MCP-verktøy hoppes over", () => {
		expect(uklassifiserte(["Write", "ApplyPatch", "mcp__plugin_pai_pai__session_registry", "Bash"])).toEqual([
			"ApplyPatch",
		]);
	});
});

describe("HarnessSync flagger det som rører skriveverktøyene", () => {
	const rad = "skriveverktøyene og vakten (K58)";
	test("en ny fil blant v2s verktøy, uansett commit-emne", () => {
		expect(klassifiser("packages/core/src/tool/plugin/multiedit.ts", V2_STIER)).toContain(rad);
	});
	test("commit-emner og changelog-linjer", () => {
		expect(klassifiser("feat(core): add multi-file edit tool (#53000)", V2_REGLER)).toContain(rad);
		expect(klassifiser("Improved notebook edit permission prompts", CLAUDE_REGLER)).toContain(rad);
		expect(klassifiser("Added MultiEdit back for large refactors", CLAUDE_REGLER)).toContain(rad);
	});
});
