/**
 * PAI Core — subagentenes livssyklus
 *
 * Eneste vei for subagent-fangsten, i begge motorene. v1 utledet den av
 * `tool.after` filtrert på Task; den veien ble slettet med v1, og
 * `onToolAfter` legger bare igjen en note når den ser subagent-verktøyet.
 *
 * Hva hendelsene gir som Task-veien ikke gjorde:
 *
 *   `agentType`   fra motoren, ikke utledet av `args.subagent_type` — som
 *                 rapporterte `unknown` på v1 av årsaker ingen fant
 *   `output`      motorens `last_assistant_message`, ikke `tool_response`
 *                 parset gjennom fire formvarianter i `extractResultText`
 *   `running`     en subagent som krasjer blir SYNLIG i registeret, framfor
 *                 aldri å ha eksistert der
 *
 * Importerer ingen motor.
 *
 * @module pai-core/dispatch/agent
 */

import { forStorage } from "../lib/secrets";
import { fileLog, fileLogError } from "../lib/file-logger";
import type { PaiAgentStartEvent, PaiAgentStopEvent, PaiResult } from "../types";

/**
 * SUBAGENT STARTET
 *
 * Kun registeret. Det er med vilje at ingenting annet henger her: alt PAI
 * gjør med en subagent trenger resultatet, og resultatet finnes ikke ennå.
 */
export async function onAgentStart(event: PaiAgentStartEvent): Promise<PaiResult> {
	fileLog(`[Subagent] Start: ${event.agentType} (${event.agentId})`, "info");

	const notes: string[] = [`agent-start:${event.agentType}`];

	try {
		const { registerSubagentStart } = await import("../handlers/session-registry");
		await registerSubagentStart(
			event.sessionId || "unknown",
			event.agentId,
			event.agentType,
			event.description
		);
	} catch (error) {
		fileLogError("[Subagent] Registrering av start feilet (non-blocking)", error);
	}

	return { notes };
}

/**
 * SUBAGENT FERDIG
 *
 * Fangst til MEMORY/RESEARCH/ og sluttstatus i registeret.
 *
 * `captureAgentOutput` tar `args` og et rått resultat fordi den ble skrevet
 * for Task-veien. Her finnes verken args eller et verktøyresultat, så vi
 * bygger den formen den forventer. Alternativet var å endre signaturen og
 * dermed OpenCode-veien i samme slengen — en atferdsendring skjult i en
 * utvidelse, som er nøyaktig feilklassen handoveren advarer mot.
 */
export async function onAgentStop(rawEvent: PaiAgentStopEvent): Promise<PaiResult> {
	// The subagent's answer is stored in the registry and the agent capture;
	// masked first, like a prompt or a reply (#367).
	const event = { ...rawEvent, output: forStorage(rawEvent.output) };
	fileLog(
		`[Subagent] Stopp: ${event.agentType} (${event.agentId}), ${event.output.length} tegn`,
		"info"
	);

	const notes: string[] = [`agent-stop:${event.agentType}`];

	// === STATUS I REGISTERET ===
	//
	// Først, og alltid — også når det ikke er noe å fange. En subagent som
	// svarte tomt er fortsatt ferdig, og å la den stå som `running` ville
	// gjort statusen til en løgn.
	try {
		const { markSubagentStopped } = await import("../handlers/session-registry");
		await markSubagentStopped(
			event.sessionId || "unknown",
			event.agentId,
			event.agentType,
			"completed"
		);
	} catch (error) {
		fileLogError("[Subagent] Statusoppdatering feilet (non-blocking)", error);
	}

	// === OUTPUT CAPTURE ===
	try {
		const { captureAgentOutput } = await import("../handlers/agent-capture");
		const capture = await captureAgentOutput(
			{ subagent_type: event.agentType, description: event.agentId },
			event.output
		);
		if (capture.success && capture.filepath) {
			fileLog(`[Subagent] Output lagret: ${capture.filepath}`, "info");
			notes.push("agent-captured");
			// Stien FESTES på registeroppføringen, ellers kan `session_results`
			// bare returnere metadata — og instruksjonen den ellers ville gitt
			// («gjenoppta subagenten») finnes ikke i Claude Code.
			const { setSubagentOutputPath } = await import("../handlers/session-registry");
			await setSubagentOutputPath(event.sessionId || "unknown", event.agentId, capture.filepath);
		}
	} catch (error) {
		fileLogError("[Subagent] Fangst feilet (non-blocking)", error);
	}

	// Observability er av under Claude Code, så dette er i praksis en no-op i
	// dag. Kallet står likevel, fordi emitteren selv eier den avgjørelsen —
	// en `if` her ville vært en harness-sjekk utenfor runtime.ts.
	try {
		const { emitAgentComplete } = await import("../handlers/observability-emitter");
		emitAgentComplete({
			agent_type: event.agentType,
			result_length: event.output.length,
		}).catch(() => {});
	} catch (error) {
		fileLogError("[Subagent] Emit feilet (non-blocking)", error);
	}

	return { notes };
}
