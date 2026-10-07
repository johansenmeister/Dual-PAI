/**
 * PAI Core — eneste inngang
 *
 * INVARIANT: `dispatch` kaster ALDRI. Alle feil blir til `notes` + fileLog.
 *
 * Det er strukturfiksen for K-07. Så lenge blokkering var et `throw`, kunne
 * ikke adapteren fange interne feil uten samtidig å svelge en tiltenkt
 * blokkering. Nå er blokkering en returverdi, og adapteren kan skille dem.
 *
 * Handlere importeres LAZY. Kjernen skal kunne lastes i en test uten å dra
 * inn hele handler-treet, og en handler som ikke er i bruk for en hendelse
 * skal ikke koste noe.
 *
 * @module pai-core
 */

import type { SecurityResult } from "./adapters/types";
import { somTekst } from "./lib/payload";
import { isSkillTool, isSubagentTool } from "./lib/tool-names";
import { fileLog, fileLogError } from "./runtime";
import type { PaiContextBuildEvent, PaiEvent, PaiResult } from "./types";

export type { Harness, PaiCapabilities, PaiEvent, PaiResult } from "./types";
export { capabilitiesFor, sessionKeyFor } from "./runtime";

/**
 * Kjør PAI-logikken for én hendelse.
 *
 * @returns Hva motoren bør gjøre. Et tomt objekt betyr «ingen innvending».
 */
export async function dispatch(event: PaiEvent): Promise<PaiResult> {
	const resultat = await rute(event);
	// K5: effektnotene legges i arbeidsøkten. `session.end` gjør det selv, før
	// teardown rydder tilstanden oppslaget trenger. Invarianten gjelder også
	// her: en hendelse uten form (null) skal gi resultatet, ikke et unntak.
	try {
		if (event && event.type !== "session.end") {
			const { merkForØkt } = await import("./lib/effekter");
			await merkForØkt(event.sessionId, event.type, resultat.notes);
		}
	} catch (error) {
		fileLogError("[dispatch] Effektmarkøren feilet (non-blocking)", error);
	}
	return resultat;
}

async function rute(event: PaiEvent): Promise<PaiResult> {
	try {
		switch (event.type) {
			case "tool.before": {
				const verdict = await guardToolCall(event.tool, event.args);
				if (verdict.permission === "deny") return verdict;
				// Rådgivende vakter kjører kun når kallet faktisk skal skje.
				// Ved deny kastet pluginen før den kom hit, og den rekkefølgen
				// er bevart: å validere et kall som nektes gir bare støy.
				const advisory = await advisoryGuards(event.tool, event.args);
				const alias = await normaliserAgentNavn(event);
				const notes = [...(verdict.notes ?? []), ...advisory, ...(alias?.note ? [alias.note] : [])];
				return {
					...verdict,
					...(alias?.updatedArgs ? { updatedArgs: alias.updatedArgs } : {}),
					...(notes.length > 0 ? { notes } : {}),
				};
			}

			case "permission.ask":
				// OpenCodes Permission-type har verken tool eller args (K-02), så
				// hendelsen kommer tom derfra. Uten verktøynavn er det ingenting å
				// validere, og å gjette ville gitt vilkårlige avgjørelser.
				if (!event.tool) {
					return { notes: ["permission.ask uten verktøynavn — ingen vurdering"] };
				}
				return await guardToolCall(event.tool, event.args ?? {});

			case "tool.after": {
				const { onToolAfter } = await import("./dispatch/tool");
				return await onToolAfter(event);
			}

			case "tool.output": {
				const { maskToolResult } = await import("./handlers/secret-masking");
				const masked = maskToolResult(event.tool, event.output);
				if (!masked.notice) return {};
				return {
					output: { value: masked.result, notice: masked.notice },
					notes: masked.hits.map((h) => `masked:${h.label}`),
				};
			}

			case "tool.failed": {
				const { onToolFailed } = await import("./dispatch/tool");
				return await onToolFailed(event);
			}

			case "agent.start": {
				const { onAgentStart } = await import("./dispatch/agent");
				return await onAgentStart(event);
			}

			case "agent.stop": {
				const { onAgentStop } = await import("./dispatch/agent");
				return await onAgentStop(event);
			}

			case "context.build":
				return await buildContext(event);

			case "session.start": {
				const { onSessionStart } = await import("./dispatch/session");
				return await onSessionStart(event);
			}

			case "session.end": {
				const { onSessionEnd } = await import("./dispatch/session");
				return await onSessionEnd(event);
			}

			case "session.compacted": {
				const { onSessionCompacted } = await import("./dispatch/session");
				return await onSessionCompacted(event);
			}

			case "user.message": {
				const { onUserMessage } = await import("./dispatch/message");
				return await onUserMessage(event);
			}

			case "assistant.message": {
				const { onAssistantMessage } = await import("./dispatch/message");
				return await onAssistantMessage(event);
			}

			case "shell.env": {
				const { buildShellEnv } = await import("./dispatch/shell-env");
				return await buildShellEnv(event);
			}

			default: {
				// Uttømmende sjekk: legges en variant til i unionen uten en gren
				// her, feiler typesjekken framfor at hendelsen ignoreres i stillhet.
				const ukjent: never = event;
				fileLog(`[dispatch] Ukjent hendelsestype: ${JSON.stringify(ukjent)}`, "warn");
				return { notes: ["ukjent hendelsestype"] };
			}
		}
	} catch (error) {
		// INVARIANTEN. Ingen hendelse skal kunne velte motoren.
		fileLogError("[dispatch] Uventet feil — fail-open", error);
		return { notes: ["dispatch-failed-open"] };
	}
}

/**
 * Rådgivende vakter: agent-utførelse og skill-påkalling.
 *
 * De BLOKKERER ikke, verken før eller nå — de logger en advarsel. Det er
 * bevisst beholdt: ingen av dem har vært håndhevende, og å gjøre dem det her
 * ville vært en atferdsendring skjult i en flytting. Claude Codes PreToolUse
 * kan eskalere til `permissionDecision: "request"`, og DA er det et reelt
 * valg å ta.
 */
/**
 * Oversett `subagent_type` til motorens eget agentnavn.
 *
 * MÅLT 2026-09-22: Claude Code eksponerer plugin-agenter som `pai:Engineer`,
 * og et bart navn gir «Agent type 'Engineer' not found». Promptmaterialet
 * sier `Engineer`. Motoren leser `updatedInput` FØR den slår opp typen, så
 * omskrivingen her er det som gjør de genererte agentene adresserbare.
 *
 * @returns `null` når ingenting skal endres — ukjent navn, allerede riktig
 *   navn, eller en motor som ikke trenger oversettelse. Vi gjetter ALDRI:
 *   å sende arbeid til feil agent er verre enn en feilmelding.
 */
async function normaliserAgentNavn(
	event: Extract<PaiEvent, { type: "tool.before" }>
): Promise<{ updatedArgs: Record<string, unknown>; note: string } | null> {
	const { capabilitiesFor } = await import("./runtime");
	if (!capabilitiesFor(event.harness).agentAliases) return null;
	if (!isSubagentTool(event.tool)) return null;

	const ønsket = (event.args as { subagent_type?: unknown })?.subagent_type;
	if (typeof ønsket !== "string" || ønsket === "") return null;

	try {
		const { slåOppAgentAlias } = await import("./lib/agent-alias");
		const motornavn = slåOppAgentAlias(ønsket);
		if (!motornavn) return null;
		fileLog(`[AgentAlias] ${ønsket} → ${motornavn}`, "info");
		return {
			updatedArgs: { ...event.args, subagent_type: motornavn },
			note: `agent-alias:${ønsket}→${motornavn}`,
		};
	} catch (error) {
		// En feilet oversettelse skal la kallet gå, ikke stoppe det. Da får
		// brukeren motorens egen feilmelding framfor taushet.
		fileLogError("[AgentAlias] Oppslag feilet (ikke-blokkerende)", error);
		return null;
	}
}

async function advisoryGuards(tool: string, args: Record<string, unknown>): Promise<string[]> {
	const notes: string[] = [];
	const safeArgs = args ?? {};

	// === AGENT EXECUTION GUARD (v3.0) ===
	//
	// Samme navnetabell som `tool.after` og algoritmesporingen. Den gamle
	// testen her lette etter `task`, og Claude Codes verktøy heter `Agent` —
	// vakten kjørte altså aldri under Claude, uten at noe sa fra.
	if (isSubagentTool(tool)) {
		try {
			const { validateAgentExecution } = await import("./handlers/agent-execution-guard");
			const guardResult = await validateAgentExecution(safeArgs);
			if (!guardResult.allowed) {
				fileLog(`[AgentGuard] Warning: ${guardResult.reason}`, "warn");
				notes.push("agent-guard-warning");
			}
		} catch (error) {
			fileLogError("[AgentGuard] Validation failed (non-blocking)", error);
		}
	}

	// === SKILL GUARD (v3.0) ===
	if (isSkillTool(tool)) {
		try {
			const { skillnavnFraArgs, validateSkillInvocation } = await import("./handlers/skill-guard");
			const skillName = skillnavnFraArgs(safeArgs) || "unknown";
			const context = somTekst(safeArgs.context);
			const skillResult = await validateSkillInvocation(skillName, context);
			if (!skillResult.valid) {
				fileLog(`[SkillGuard] Warning: ${skillResult.reason}`, "warn");
				notes.push("skill-guard-warning");
			}
		} catch (error) {
			fileLogError("[SkillGuard] Validation failed (non-blocking)", error);
		}
	}

	return notes;
}

/**
 * Bygg systemkonteksten motoren skal injisere.
 *
 * PAI_ENABLED-porten ligger her, ikke i adapteren: den er PAI-policy og
 * gjelder begge motorene. En vanlig `opencode`- eller `claude`-økt skal
 * kunne kjøre uten å dra med seg hele PAI-treet.
 *
 * Vi krever eksakt "1", ikke bare truthy, så tilfeldig miljøforurensning
 * (`PAI_ENABLED=0`, `PAI_ENABLED=false`) ikke slår konteksten på.
 */
async function buildContext(event: PaiContextBuildEvent): Promise<PaiResult> {
	if (process.env.PAI_ENABLED !== "1") {
		fileLog(
			"PAI context disabled (PAI_ENABLED !== '1'; use 'pai' command for full context)",
			"info"
		);
		return { notes: ["pai-disabled"] };
	}

	fileLog("Injecting user system context (steering rules + identity)...");

	const { emitContextLoaded, emitSessionStart } = await import(
		"./handlers/observability-emitter"
	);
	emitSessionStart({ sessionId: event.sessionId || undefined }).catch(() => {});

	const { loadUserSystemContext } = await import("./dispatch/context");
	const userContextResult = await loadUserSystemContext();

	if (userContextResult && userContextResult.context.length > 0) {
		const { context: userContext, filesLoaded } = userContextResult;
		fileLog(`Context injected successfully (${userContext.length} chars)`);
		emitContextLoaded({
			files_loaded: filesLoaded,
			total_size: userContext.length,
			success: true,
		}).catch(() => {});
		const { arbeidsøktKontekst } = await import("./dispatch/arbeidsokt");
		const arbeidsøkt = await arbeidsøktKontekst(event.sessionId);
		return { additionalContext: arbeidsøkt ? [userContext, arbeidsøkt] : [userContext] };
	}

	fileLog("Context injection skipped: empty user context", "warn");
	emitContextLoaded({ files_loaded: 0, total_size: 0, success: false }).catch(() => {});
	return { notes: ["empty-context"] };
}

/**
 * Sikkerhetsvakten for et verktøykall.
 *
 * FAIL-OPEN ved intern feil, bevisst valgt: en bug i vakten skal ikke kunne
 * låse brukeren ute av sitt eget verktøy. Feilen logges som ERROR slik at den
 * er synlig, men kallet slipper gjennom.
 *
 * Merk at dette er en reell innstramming av dagens oppførsel *som valg*, ikke
 * som atferd: `permission.ask` var allerede fail-open, mens
 * `tool.execute.before` manglet try/catch og dermed blokkerte ved intern feil
 * uten at noen hadde bestemt det (K-07).
 */
async function guardToolCall(tool: string, args: Record<string, unknown>): Promise<PaiResult> {
	let result: SecurityResult;
	try {
		const { validateSecurity } = await import("./handlers/security-validator");
		result = await validateSecurity({ tool, args } as never);
	} catch (error) {
		fileLogError(`[Guard] Validering feilet for ${tool} — fail-open`, error);
		return { notes: ["guard-failed-open"] };
	}

	switch (result.action) {
		case "block":
			return {
				permission: "deny",
				reason: result.reason,
				message: result.message ?? result.reason,
			};
		case "confirm":
			return { permission: "ask", reason: result.reason };
		default:
			return {};
	}
}
