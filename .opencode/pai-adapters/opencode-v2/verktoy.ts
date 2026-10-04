/**
 * v2-adapteren — PAIs egne verktøy
 *
 * Registreres med `tool.transform(editor => editor.add(…))`, med JSON Schema
 * som `input` (MÅLT, M10: modellen fant verktøyet og kalte det via Code
 * Mode, og det indre kallet fyrte `execute.before`/`.after` med verktøyets
 * eget navn). Svarene er de samme som v1s, fra `../opencode-felles/verktoy`.
 *
 * `execute` får `sessionID` i konteksten (MÅLT, fase 0: `ctxkeys =
 * agent,id,messageID,progress,sessionID,signal`). Det er FORELDERØKTEN når
 * hovedagenten kaller, og den registeret er nøklet på.
 *
 * Holdt fri for motor-API, så den kan testes uten en motor.
 *
 * @module pai-adapters/opencode-v2/verktoy
 */

import { fileLog, fileLogError } from "../../pai-core/lib/file-logger";
import { somObjekt, somTekst } from "../../pai-core/lib/payload";
import {
	CODE_REVIEW_BESKRIVELSE,
	CODE_REVIEW_MODE_BESKRIVELSE,
	CODE_REVIEW_PATH_BESKRIVELSE,
	codeReviewSvar,
	erReviewMode,
	REVIEW_MODES,
	SESSION_ID_ARG_BESKRIVELSE,
	SESSION_REGISTRY_BESKRIVELSE,
	SESSION_RESULTS_BESKRIVELSE,
	sessionRegistrySvar,
	sessionResultsSvar,
} from "../opencode-felles/verktoy";

/** Linja hvert verktøy skriver når det kjører. `V2Smoke` leter etter den. */
export const VERKTØY_MARKØR = "[v2-verktøy]";

/** Formen `editor.add` tar imot, så langt adapteren bruker den. */
export interface V2Verktøy {
	name: string;
	description: string;
	input: Record<string, unknown>;
	execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>;
}

/**
 * Pakk inn svaret: meld kjøringen, og la en feil bli tekst til modellen.
 *
 * En `execute` som kaster, blir en `Tool.Error` modellen ser som en feilet
 * verktøykjøring. En PAI-feil skal heller gi en lesbar forklaring.
 */
function kjør(
	navn: string,
	svar: (input: Record<string, unknown>, sessionId: string) => Promise<string> | string
): V2Verktøy["execute"] {
	return async (input, context) => {
		const sessionId = somTekst(somObjekt(context).sessionID);
		fileLog(`${VERKTØY_MARKØR} ${navn} for ${sessionId || "ukjent økt"}`, "info");
		try {
			return { content: await svar(somObjekt(input), sessionId) };
		} catch (error) {
			fileLogError(`[v2] verktøyet ${navn} feilet`, error);
			return { content: `${navn} failed inside PAI: ${error instanceof Error ? error.message : String(error)}` };
		}
	};
}

export function paiVerktøy(): V2Verktøy[] {
	return [
		{
			name: "session_registry",
			description: SESSION_REGISTRY_BESKRIVELSE,
			input: { type: "object", properties: {} },
			execute: kjør("session_registry", (_input, sessionId) => sessionRegistrySvar(sessionId)),
		},
		{
			name: "session_results",
			description: SESSION_RESULTS_BESKRIVELSE,
			input: {
				type: "object",
				properties: { session_id: { type: "string", description: SESSION_ID_ARG_BESKRIVELSE } },
				required: ["session_id"],
			},
			execute: kjør("session_results", (input, sessionId) =>
				sessionResultsSvar(sessionId, somTekst(input.session_id))
			),
		},
		{
			name: "code_review",
			description: CODE_REVIEW_BESKRIVELSE,
			input: {
				type: "object",
				properties: {
					mode: { type: "string", enum: [...REVIEW_MODES], description: CODE_REVIEW_MODE_BESKRIVELSE },
					path: { type: "string", description: CODE_REVIEW_PATH_BESKRIVELSE },
				},
			},
			execute: kjør("code_review", (input) =>
				codeReviewSvar({
					// Om motoren håndhever `enum` før `execute`, er UMÅLT. En
					// ukjent modus gir derfor standarden framfor en feil.
					mode: erReviewMode(input.mode) ? input.mode : undefined,
					path: somTekst(input.path) || undefined,
				})
			),
		},
	];
}
