/**
 * PAI Core — verktøynavn på tvers av motorer
 *
 * De to motorene kaller det samme verktøyet ulike ting, og navnene har vært
 * duplisert i tre handlere med tre litt ulike tester. Det gikk bra så lenge
 * det bare fantes én motor.
 *
 * MÅLT 2026-09-22, ende-til-ende mot Claude Code 2.1.278: subagent-verktøyet
 * heter **`Agent`**, ikke `Task`. Både planen og koden antok `Task` — det
 * navnet finnes ikke i en Claude-økt. Konsekvensen var stille, som den alltid
 * er: `algorithm-tracker` talte null subagent-spawns, og
 * `agent-execution-guard` kjørte aldri, uten at noe feilet.
 *
 * Testene i `tests/claude-adapter.test.ts` låser at rutetabellen i adapteren
 * kjenner de samme navnene. Går de to fra hverandre, filtreres kallet bort i
 * hurtigutgangen før kjernen ser det, og handleren slutter stille å kjøre.
 *
 * @module pai-core/lib/tool-names
 */

import { somObjekt, somTekst } from "./payload";

/**
 * Eksakte navn på subagent-verktøyet, i småbokstaver.
 *
 * EKSAKT, ikke substring, og det er grunnen til at `Agent` må stå her framfor
 * i testen under: `lower.includes("agent")` ville truffet `AgentOutput`,
 * `subagent_type` og hva som ellers måtte komme av verktøyer med «agent» i
 * navnet. Et falskt treff her fører til at PAI fanger en subagent som ikke
 * finnes.
 *
 * OpenCode v2 kaller verktøyet **`subagent`**, med `input = {agent,
 * description, prompt}` (MÅLT 2026-09-25, M2/M8). Uten navnet her kjører
 * agentvakten aldri under v2 — M-17 på nytt.
 */
const SUBAGENT_TOOL_NAMES = new Set(["agent", "task", "mcp_task", "subagent"]);

/**
 * Er dette verktøyet det som spawner en subagent?
 *
 * Substring-testen på `task` er beholdt fra den opprinnelige
 * implementasjonen: OpenCode rapporterer verktøynavn i småbokstaver med
 * prefiks (`mcp_task`), og varianter har dukket opp før. Å stramme den inn
 * til eksakte navn ville vært en atferdsendring skjult i en utvidelse.
 */
export function isSubagentTool(toolName: string): boolean {
	const lower = toolName.toLowerCase();
	return SUBAGENT_TOOL_NAMES.has(lower) || lower.includes("task");
}

/**
 * Subagentens type og prompt fra verktøyargumentene, uansett motor (M-50).
 *
 * Claude sender `subagent_type`, v2 sender **`agent`**, med `input = {agent,
 * description, prompt}` (MÅLT 2026-09-25, M2/M8). Agentvakten leste bare
 * `subagent_type`, så under v2 var typen alltid «unknown», og Explore-sjekken
 * fyrte aldri. Tom streng for et felt som mangler.
 */
export function subagentFraArgs(args: unknown): { type: string; prompt: string } {
	const a = somObjekt(args);
	return { type: somTekst(a.subagent_type) || somTekst(a.agent), prompt: somTekst(a.prompt) };
}

/**
 * Er dette skill-verktøyet? `Skill` i Claude, `skill` i v2 (MÅLT, M-40).
 *
 * Substring, som testen i `advisoryGuards` alltid har vært: `mcp_skill` og
 * andre prefiks skal med.
 */
export function isSkillTool(toolName: string): boolean {
	return toolName.toLowerCase().includes("skill");
}

/**
 * Eksakte navn på skallverktøyet, i småbokstaver.
 *
 * v1 og Claude Code kaller det `bash`/`Bash`. OpenCode v2 kaller det
 * **`shell`** — MÅLT 2026-09-24 mot en ekte v2.0.15-binær med ekte modell.
 * Sikkerhetsvakten testet `=== "bash"`, så under v2 ville hver
 * skallkommando passert umønstret, `rm -rf /` inkludert. Samme feilklasse
 * som `Task` mot `Agent` (M-17), men i sikkerhetsstien.
 *
 * EKSAKT, ikke substring: `includes("shell")` ville truffet et MCP-verktøy
 * som tilfeldigvis har ordet i navnet, og kjørt skallmønstrene mot
 * argumenter som ikke er en kommando.
 */
const SHELL_TOOL_NAMES = new Set(["bash", "shell"]);

/** Er dette verktøyet som kjører en skallkommando? */
export function isShellTool(toolName: string): boolean {
	return SHELL_TOOL_NAMES.has(toolName.toLowerCase());
}

/**
 * Argumentnavn som betyr det samme på tvers av motorene: motorens navn →
 * kjernens navn.
 *
 * Kjernen bruker OpenCodes camelCase (`filePath`, `oldString`), fordi det
 * var den første motoren. Claude Code bruker snake_case for de SAMME
 * feltene. MÅLT: Claudes Write/Edit sender `file_path`, `old_string`,
 * `new_string`; OpenCode 1.18.32 har `filePath` i skjemaet for write, edit
 * og read (lest ut av binæren).
 *
 * Tabellen er grunnen til at K-03 og K-09 er samme defekt fra hver sin
 * side: vakten leste først `file_path` og var død på OpenCode, ble rettet
 * til `filePath` og var dermed død på Claude.
 *
 * OpenCode v2 bruker **`path`** for write, edit og read (MÅLT 2026-09-25,
 * M2). Uten aliaset er sensitiv-sti-vakten død under v2 — K-09 en tredje
 * gang. Aliaset gjelder alle verktøy, også `glob`/`grep`, der `path` er en
 * katalog. Det er ufarlig: vakten leser `filePath` bare for skrivende
 * verktøy (`skrivemål`).
 * Men `filePath` er et felt injeksjonsskanningen leser, så en `path` fra
 * glob/grep skannes nå også. Det er en utvidelse av vakten, ikke en
 * svekkelse.
 */
const ARG_ALIASER: Readonly<Record<string, string>> = {
	file_path: "filePath",
	path: "filePath",
	old_string: "oldString",
	new_string: "newString",
	// Claudes `NotebookEdit` (lest ut av skjemaet i 2.1.283-binæren, K58).
	// Uten aliasene så verken sti-vakten eller injeksjonsskanningen kallet.
	notebook_path: "filePath",
	new_source: "newString",
};

/**
 * Verktøyargumentene med kjernens feltnavn, uansett hvilken motor de kom fra.
 *
 * ADDITIV: originalfeltene står, og aliaset legges til ved siden av. Da ser
 * en handler som leser motorens eget navn fortsatt det, og et felt kjernen
 * ikke kjenner går uendret videre. Finnes begge navnene, vinner kjernens —
 * motoren har da selv sagt hva den mener med det.
 *
 * Tar `unknown`, så en adapter som sender `undefined` eller en streng får
 * `{}` tilbake framfor et kast i sikkerhetsstien.
 */
export function kanoniskeArgs(args: unknown): Record<string, unknown> {
	const kilde = somObjekt(args);
	const ut: Record<string, unknown> = { ...kilde };
	for (const [motorNavn, kjerneNavn] of Object.entries(ARG_ALIASER)) {
		if (ut[kjerneNavn] === undefined && kilde[motorNavn] !== undefined) {
			ut[kjerneNavn] = kilde[motorNavn];
		}
	}
	return ut;
}

/**
 * Filstien et skrive- eller redigeringsverktøy peker på, eller tom streng.
 *
 * `path` er v2s navn for write/edit, og går via aliaset i `kanoniskeArgs`.
 */
export function målsti(args: unknown): string {
	return somTekst(kanoniskeArgs(args).filePath);
}

/**
 * Verktøyene som skriver filer, i småbokstaver (K58).
 *
 * MÅLT 2026-10-01: init-lista i Claude Code 2.1.283 har `Write`, `Edit` og
 * `NotebookEdit`, samme med en ukjent modell og med Haiku. `MultiEdit` står
 * ikke i lista, men er nevnt oppstrøms (#91574); stien står i `file_path`, så
 * den dekkes uten kostnad hvis den kommer tilbake.
 *
 * UTLEDET av kilden til v2 2.0.18 og 2.0.21 (`tool/plugin/patch.ts`): v2 har
 * `write`, `edit` og **`patch`**, og for en modell med `gpt-` i id-en (ikke
 * `oss`, ikke `gpt-4`) fjerner motoren `write` og `edit` og gir bare `patch`.
 * Vakten sjekket navnene `write`/`edit` eksakt, så med en slik modell så den
 * ingen filskriving i det hele tatt — samme feilklasse som `bash` mot `shell`.
 *
 * EKSAKT, ikke substring: `includes("edit")` ville truffet verktøy som ikke
 * skriver filer, og kjørt sti-vakten mot argumenter som ikke er en sti.
 */
export const SKRIVEVERKTØY: ReadonlySet<string> = new Set(["write", "edit", "notebookedit", "multiedit", "patch"]);

/** Skriver dette verktøyet filer? Se `SKRIVEVERKTØY`. */
export function erSkriveverktøy(toolName: string): boolean {
	return SKRIVEVERKTØY.has(toolName.toLowerCase());
}

/**
 * Filene et skrivende verktøy skriver til, eller `null` når verktøyet ikke
 * skriver filer. Tom liste når verktøyet skriver, men argumentene ikke har
 * noen sti.
 */
export function skrivemål(toolName: string, args: unknown): string[] | null {
	const lower = toolName.toLowerCase();
	if (!SKRIVEVERKTØY.has(lower)) return null;
	const a = kanoniskeArgs(args);
	if (lower === "patch") return patchstier(somTekst(a.patchText));
	const sti = somTekst(a.filePath);
	return sti ? [sti] : [];
}

/** Linjene i v2s patch-format som navngir en fil (`@opencode/util/patch`). */
const PATCH_HODER = ["*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"];

/**
 * Stiene en v2-patch rører: hver fil som legges til, endres, slettes eller
 * flyttes til.
 *
 * Rausere enn v2s egen parser, med vilje: en hodelinje teller også inne i en
 * hunk, og innrykk og manglende mellomrom etter kolon tåles. En sti for mye
 * gir i verste fall en blokkering for mye; en sti for lite slipper en
 * skriving forbi vakten.
 */
export function patchstier(patchText: string): string[] {
	const stier = new Set<string>();
	for (const linje of patchText.split(/\r?\n/)) {
		const t = linje.trim();
		for (const hode of PATCH_HODER) {
			if (!t.startsWith(hode)) continue;
			const sti = t.slice(hode.length).trim();
			if (sti) stier.add(sti);
		}
	}
	return [...stier];
}
