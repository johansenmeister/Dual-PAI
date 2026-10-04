/**
 * Hvert verktøy motorene gir modellen, og hvorfor det ikke er et skriveverktøy (K58).
 *
 * Vakten kjenner de skrivende i `SKRIVEVERKTØY` (`pai-core/lib/tool-names.ts`).
 * Alt annet en motor tilbyr, står her med grunnen til at det ikke trenger
 * sti-vakten. Et navn som står ingen av stedene, er et verktøy ingen har
 * vurdert: det kan skrive filer forbi vakten, slik v2s `patch` gjorde.
 *
 * `mcp__*` er utenfor: MCP-verktøyene har sine egne skjemaer, og vakten ser
 * dem bare gjennom injeksjonsskanningen.
 *
 * @module Tools/lib/verktoyklasser
 */

import { erSkriveverktøy } from "../../.opencode/pai-core/lib/tool-names";

/** Navn → hvorfor det ikke skriver filer. Eksakt navn, slik motoren sender det. */
export const IKKE_SKRIVENDE: Readonly<Record<string, string>> = {
	// Claude Code 2.1.283, init-lista i `-p` (MÅLT 2026-10-01, ukjent modell og Haiku)
	Bash: "skall: skallvakten ser kommandoen",
	Task: "subagent: agentvakten",
	Agent: "subagent: agentvakten (navnet i hookene, M-17)",
	Read: "leser",
	WebFetch: "nett, leser",
	WebSearch: "nett, leser",
	Skill: "laster en skill",
	ToolSearch: "laster verktøyskjemaer",
	TaskCreate: "oppgavelista, ingen fil",
	TaskGet: "oppgavelista, ingen fil",
	TaskList: "oppgavelista, ingen fil",
	TaskStop: "oppgavelista, ingen fil",
	TaskUpdate: "oppgavelista, ingen fil",
	CronCreate: "planlegger en prompt, ingen fil",
	CronDelete: "planlegger en prompt, ingen fil",
	CronList: "planlegger en prompt, ingen fil",
	ScheduleWakeup: "planlegger en prompt, ingen fil",
	RemoteTrigger: "planlegger en prompt, ingen fil",
	Monitor: "venter på en kommando, leser",
	EnterWorktree: "git worktree, ingen innhold",
	ExitWorktree: "git worktree, ingen innhold",
	ListAgents: "meldinger mellom økter",
	SendMessage: "meldinger mellom økter",
	PushNotification: "varsel til brukeren",
	ReportFindings: "rapport til brukerflaten",
	Workflow: "orkestrerer subagenter, som vaktes hver for seg",
	DesignSync: "kontotjeneste, ingen lokal fil",
	ShareOnboardingGuide: "laster opp ONBOARDING.md, skriver ikke",
	AskUserQuestion: "spør brukeren",
	EnterPlanMode: "modusbytte",
	ExitPlanMode: "modusbytte",

	// OpenCode v2 2.0.18 og 2.0.21, `packages/core/src/tool/plugin/` (UTLEDET av kilden)
	shell: "skall: skallvakten ser kommandoen",
	subagent: "subagent: agentvakten",
	read: "leser",
	glob: "leser",
	grep: "leser",
	webfetch: "nett, leser",
	websearch: "nett, leser",
	skill: "laster en skill",
	question: "spør brukeren",
	execute: "Code Mode: de indre kallene går gjennom vakten (MÅLT i fase 0)",
	list_mcp_resources: "MCP-ressurser, leser",
	read_mcp_resource: "MCP-ressurser, leser",
	opencode: "motorens egne øktverktøy, ingen fil",
	session_rename: "motorens egne øktverktøy, ingen fil",
	session_move: "motorens egne øktverktøy, ingen fil",
	models: "modellkatalogen, leser",
};

/** Navnene ingen har klassifisert, i rekkefølgen motoren ga dem. */
export function uklassifiserte(verktøy: readonly string[]): string[] {
	return verktøy.filter((navn) => !navn.startsWith("mcp__") && !erSkriveverktøy(navn) && !(navn in IKKE_SKRIVENDE));
}
