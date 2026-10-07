/**
 * Claude-adapter — rå hook-payload inn, PaiEvent ut
 *
 * Feltnavnene under er hentet fra Claude Code 2.1.278s EGNE zod-skjemaer,
 * lest ut av binæren 2026-09-22, og for batch 6-hendelsene i tillegg målt
 * mot en probe-plugin 2026-09-21. Det er en sterkere kilde enn dokumentasjon:
 * det er parseren som faktisk avviser payloaden hvis navnet er feil.
 *
 * ```
 * SessionStart        session_id transcript_path cwd hook_event_name
 *                     source(startup|resume|clear|compact|fork)
 * SessionEnd          … reason(clear|resume|logout|prompt_input_exit|other)
 * UserPromptSubmit    … prompt_id permission_mode prompt source?
 * PreToolUse          … tool_name tool_input tool_use_id
 * PostToolUse         … tool_name tool_input tool_response tool_use_id duration_ms?
 * PostToolUseFailure  … tool_name tool_input tool_use_id error is_interrupt? duration_ms?
 * Stop                … stop_hook_active last_assistant_message? background_tasks?
 * SubagentStart       … agent_id agent_type
 * SubagentStop        … stop_hook_active agent_id agent_transcript_path agent_type
 *                       last_assistant_message?
 * PreCompact          … trigger(manual|auto) custom_instructions
 * PostCompact         … trigger(manual|auto) compact_summary
 * PermissionRequest   … tool_name tool_input permission_suggestions?
 * PermissionDenied    … tool_name tool_input tool_use_id reason
 * ```
 *
 * Merk at Claude Code bruker snake_case der OpenCode bruker camelCase
 * (`session_id` mot `sessionID`). Det er hele grunnen til at normaliseringen
 * bor i adapteren: kjernen ser ett navn uansett motor.
 *
 * @module claude-plugin/adapter/in
 */

import { fileLog } from "../bootstrap";
import { sessionKeyFor } from "../../../.opencode/pai-core";
import type { PaiEvent } from "../../../.opencode/pai-core";

/**
 * Den delen av payloaden alle hendelser deler.
 *
 * Typet løst med vilje: dette er data fra en annen prosess, og et felt som
 * forsvinner i en oppgradering skal gi en tom verdi vi kan logge, ikke en
 * TypeError som dreper hooken.
 */
export interface ClaudeHookPayload {
	hook_event_name?: string;
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	[k: string]: unknown;
}

/** Les et strengfelt uten å stole på at det finnes eller har riktig type. */
function tekst(payload: ClaudeHookPayload, felt: string): string {
	const verdi = payload[felt];
	return typeof verdi === "string" ? verdi : "";
}

/** Felles hendelsesfelter. Samlet ett sted så ingen kaller kan glemme sessionKey. */
function basis(payload: ClaudeHookPayload) {
	const id = typeof payload.session_id === "string" ? payload.session_id : "";
	return {
		harness: "claude" as const,
		sessionId: id,
		// ALDRI bygget for hånd. `sessionKeyFor` garanterer at samme rå ID
		// under to motorer aldri gir samme filnavn under STATE/ — de to
		// harnessene deler MEMORY-tre.
		sessionKey: sessionKeyFor("claude", id),
		at: Date.now(),
		// Claude Codes cwd er brukerens prosjekt, ikke PAI-repoet. Hvor PAI
		// skriver styres av PAI_HOME (satt i bootstrap.ts), ikke av dette.
		cwd: typeof payload.cwd === "string" ? payload.cwd : process.cwd(),
	};
}

/**
 * Hendelser PAI kun OBSERVERER — de blir en logglinje og ingen kjernehendelse.
 *
 * Samme arbeidsdeling som på OpenCode-siden, der `permission.asked`,
 * `command.executed` og `session.error` står igjen som logggrener i
 * `pai-unified.ts`: ren observasjon av ÉN motors flate, uten PAI-tilstand,
 * hører hjemme i adapteren.
 *
 * Hvorfor nettopp disse tre:
 *
 * `PermissionRequest`  Sikkerhetsvakten har ALLEREDE sagt sitt om dette
 *                      kallet, i `PreToolUse`, med de samme mønstrene og
 *                      de samme argumentene. En ny runde ville gitt samme
 *                      svar til prisen av nok en hook-prosess. Det som
 *                      derimot ikke finnes noe annet sted, er hvilke kall
 *                      PAI slapp gjennom mens Claude Codes eget system
 *                      stoppet opp og spurte — og det er akkurat den
 *                      forskjellen denne linja registrerer.
 * `PermissionDenied`   Brukeren sa nei. PAI har ingen beslutning å ta etterpå
 *                      (`retry` er det eneste svaret hooken tar, og PAI skal
 *                      ikke overprøve et nei), men avslaget er det tydeligste
 *                      signalet systemet får om hva brukeren ikke vil ha.
 * `PreCompact`         Den KAN ikke injisere: `PreCompact` har intet
 *                      `hookSpecificOutput`-skjema i binæren, kun
 *                      fellesformen. OpenCodes motstykke
 *                      (`experimental.session.compacting`) injiserer
 *                      kompakteringskontekst; her finnes ingen kanal for det.
 *                      Det som dekker kompaktering på Claude-siden er
 *                      `SessionStart` med `source: "compact"`, som allerede
 *                      behandles som enhver annen start.
 */
/**
 * Strip pluginprefikset av et agentnavn fra motoren.
 *
 * Claude Code eksponerer PAIs agenter som `pai:Engineer`, og
 * `SubagentStart`/`SubagentStop` rapporterer det navnet tilbake. Prefikset
 * er en ADRESSE, ikke agentens identitet — og slipper vi det videre inn i
 * kjernen, havner det i filnavn (`AGENT-pai:Intern_….md`, observert), i
 * registertabellen og i refleksjonene. Da heter samme agent to ting
 * avhengig av hvilken motor som fanget den, og delt tilstand er hele
 * poenget med prosjektet.
 *
 * Oversettelsen hører hjemme her av samme grunn som den motsatte veien
 * (`agent-alias` i tool.before): adapteren snakker motorens språk, kjernen
 * sitt eget.
 */
function utenPluginPrefiks(agentType: string): string {
	const kolon = agentType.indexOf(":");
	return kolon > 0 ? agentType.slice(kolon + 1) : agentType;
}

const KUN_OBSERVASJON = new Set(["PermissionRequest", "PermissionDenied", "PreCompact"]);

function revisjonslogg(payload: ClaudeHookPayload): void {
	switch (payload.hook_event_name) {
		case "PermissionRequest":
			fileLog(
				`[PermissionAudit] spør om ${tekst(payload, "tool_name") || "ukjent"} ` +
					`(PAI-vakten slapp det gjennom)`,
				"info"
			);
			return;
		case "PermissionDenied":
			fileLog(
				`[PermissionAudit] NEKTET ${tekst(payload, "tool_name") || "ukjent"}: ` +
					`${tekst(payload, "reason") || "ingen begrunnelse"}`,
				"info"
			);
			return;
		case "PreCompact":
			fileLog(
				`[Compaction:Pre] Kompaktering starter (${tekst(payload, "trigger") || "ukjent"}). ` +
					"Ingen injeksjonskanal her — SessionStart(source=compact) tar konteksten.",
				"info"
			);
			return;
	}
}

/**
 * Oversett én hook-payload til de PaiEvent-ene den utløser.
 *
 * LISTE, ikke enkeltverdi: `SessionStart` er to hendelser i kjernen. Det er
 * ikke en snarvei — `session.start` og `context.build` er ulike ting med
 * ulike konsumenter, og OpenCode får dem fra to ulike hooks. Slås de sammen
 * her, må kjernen vite hvilken motor den kjører under for å skille dem.
 *
 * Rekkefølgen i lista er bindende: `session.start` kjører reaperen og rydder
 * foreldet tilstand, og den ryddingen skal være gjort før konteksten bygges.
 *
 * En TOM liste er et gyldig svar, ikke en feil: observasjonshendelsene over
 * blir en logglinje og ingenting mer.
 */
export function tilKjernehendelser(payload: ClaudeHookPayload): PaiEvent[] {
	const b = basis(payload);

	if (KUN_OBSERVASJON.has(payload.hook_event_name ?? "")) {
		revisjonslogg(payload);
		return [];
	}

	switch (payload.hook_event_name) {
		case "SessionStart":
			// Begge, uansett `source`. Enumen er `startup | resume | clear |
			// compact | fork` (binærens skjema), og `fork` er grunnen til at
			// gating ville vært feil: batch 6 gatet ikke fordi verdiene var
			// umålte, og verdien ingen hadde gjettet på fantes altså.
			// Reinjeksjon etter kompaktering er dessuten nøyaktig det vi vil ha.
			//
			// Unntaket: `pai --claude` har gitt konteksten som systemprompt og
			// sier fra med `PAI_CONTEXT_FILE` (K-10). Da ville hooken bare sendt
			// den samme teksten en gang til, over Claude Codes tak.
			if (process.env.PAI_CONTEXT_FILE) return [{ ...b, type: "session.start" }];
			return [
				{ ...b, type: "session.start" },
				{ ...b, type: "context.build" },
			];

		case "SessionEnd":
			// Alle fem `reason`-verdiene betyr at DENNE økten er over, så alle
			// blir `exit`. Kjernens `reason` sier hvem som oppdaget slutten
			// (motoren selv, eller reaperen), ikke hvorfor den kom — og den
			// forskjellen er det som gjør at `reaped` kan kjøre en mildere
			// teardown. Motorens egen begrunnelse følger med som `detail`, for
			// loggen.
			return [
				{
					...b,
					type: "session.end",
					reason: "exit",
					detail: tekst(payload, "reason") || undefined,
				},
			];

		case "UserPromptSubmit":
			return [
				{
					...b,
					type: "user.message",
					text: tekst(payload, "prompt"),
				},
			];

		case "Stop":
			// `last_assistant_message` er MÅLT til å bære hele svarteksten.
			// Dette er paritetsgevinsten mot OpenCode, der teksten ikke finnes
			// på noen hendelse (K-08) og må bygges opp fra delstrømmen.
			return [
				{
					...b,
					type: "assistant.message",
					text: tekst(payload, "last_assistant_message"),
					// LØKKEVAKTEN for ISC-håndhevelsen. Er den sann, kjører
					// turen allerede fordi en tidligere blokkering ba modellen
					// fortsette — og kjernen skal da ikke blokkere igjen.
					// Feltet er påkrevd i motorens skjema, men vi krever ikke
					// at det ER der: mangler det, er `undefined` riktigere enn
					// `false`, og kjernen leser begge som «ikke en fortsettelse».
					continuedAfterBlock:
						typeof payload.stop_hook_active === "boolean"
							? payload.stop_hook_active
							: undefined,
				},
			];

		case "PreToolUse":
			return [
				{
					...b,
					type: "tool.before",
					tool: tekst(payload, "tool_name"),
					// Ett felt, alltid. OpenCode legger args i `output` for
					// `before` og i `input` for `after` — motsatt av hverandre.
					// Claude Code har ingen slik asymmetri, og kjernen skal
					// aldri måtte vite om den.
					args: (payload.tool_input as Record<string, unknown>) ?? {},
				},
			];

		case "PostToolUse":
			return [
				// First: the core masks secrets in the output, and the answer
				// becomes `updatedToolOutput` (#367).
				{
					...b,
					type: "tool.output",
					tool: tekst(payload, "tool_name"),
					output: payload.tool_response,
					callId: tekst(payload, "tool_use_id") || undefined,
				},
				{
					...b,
					type: "tool.after",
					tool: tekst(payload, "tool_name"),
					args: (payload.tool_input as Record<string, unknown>) ?? {},
					// `tool_response`, ikke `tool_result`. Feil navn her ville
					// gitt `undefined` til hele fanouten — algoritmesporing,
					// PRD-synk og spørsmålssporing ville kjørt på tomt uten at
					// noe feilet. Det er H-16 om igjen, i ny motor.
					result: payload.tool_response,
					// Ingen `metadata` på Claude-siden. Feltet finnes ikke i
					// skjemaet, og `extractSessionId` faller da tilbake på
					// tekstparsing — som uansett ikke brukes her, siden
					// subagent-fangsten går via SubagentStart/Stop.
					callId: tekst(payload, "tool_use_id") || undefined,
				},
			];

		case "PostToolUseFailure":
			return [
				{
					...b,
					type: "tool.failed",
					tool: tekst(payload, "tool_name"),
					args: (payload.tool_input as Record<string, unknown>) ?? {},
					error: tekst(payload, "error"),
					isInterrupt:
						typeof payload.is_interrupt === "boolean" ? payload.is_interrupt : undefined,
					callId: tekst(payload, "tool_use_id") || undefined,
				},
			];

		case "SubagentStart":
			return [
				{
					...b,
					type: "agent.start",
					agentId: tekst(payload, "agent_id"),
					// Fra MOTOREN, ikke fra `args.subagent_type`. Det er hele
					// grunnen til at denne hendelsen er verdt en hook-prosess:
					// OpenCode-veien rapporterer `agentType: "unknown"` av
					// årsaker ingen har funnet, og her kan den ikke gjøre det.
					agentType: utenPluginPrefiks(tekst(payload, "agent_type")),
				},
			];

		case "SubagentStop":
			return [
				{
					...b,
					type: "agent.stop",
					agentId: tekst(payload, "agent_id"),
					agentType: utenPluginPrefiks(tekst(payload, "agent_type")),
					output: tekst(payload, "last_assistant_message"),
					transcriptPath: tekst(payload, "agent_transcript_path") || undefined,
				},
			];

		case "PostCompact": {
			const trigger = tekst(payload, "trigger");
			return [
				{
					...b,
					type: "session.compacted",
					trigger: trigger === "manual" || trigger === "auto" ? trigger : undefined,
					summary: tekst(payload, "compact_summary") || undefined,
				},
			];
		}

		default:
			// Hurtigutgangen skal ha stoppet alt annet før vi kom hit.
			return [];
	}
}
