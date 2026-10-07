/**
 * Observability Emitter Handler
 *
 * Captures events from PAI-OpenCode plugin hooks and sends them
 * to the Observability Server for persistence and real-time display.
 *
 * Design Principles:
 * - Fire and forget: Never blocks plugin execution
 * - Fail silently: Server unavailability is not an error
 * - Fast timeout: 1 second max to avoid latency impact
 *
 * FIXED: All emit functions accept object parameters to match
 * pai-unified.ts call patterns. Defensive null-checks on all args.
 *
 * @module observability-emitter
 */

import { maskDeep } from "../lib/secrets";
import { randomUUID } from "node:crypto";
import { fileLog } from "../lib/file-logger";
import { capabilitiesFor, currentHarness } from "../runtime";

// Configuration
const OBSERVABILITY_URL = `http://localhost:${process.env.PAI_OBSERVABILITY_PORT || "8889"}/events`;
const TIMEOUT_MS = 1000; // 1 second timeout

/**
 * Skal vi emittere i det hele tatt?
 *
 * To grunner til at dette er en FUNKSJON og ikke en modulkonstant:
 *
 * 1. KAPABILITET. Observability er OpenCode-only etter brukerens beslutning,
 *    og `capabilitiesFor` er stedet det står. Uten denne sjekken forsøker
 *    hver eneste Claude-hook en TCP-tilkobling til en server som ikke finnes
 *    — én mislykket connect per hendelse, i en prosess som skal leve i
 *    millisekunder.
 * 2. TIDSPUNKT. En modulkonstant evalueres ved import, og adapterne setter
 *    miljøet sitt i oppstartsvakten. Det er nøyaktig samme feilklasse som
 *    M-04, der `db-utils` og `identity` leste stier før `PAI_HOME` var satt.
 *
 * Miljøvariabelen beholdes som av-bryter for OpenCode-siden, uendret.
 */
function erPå(): boolean {
	if (process.env.PAI_OBSERVABILITY_ENABLED === "false") return false;
	return capabilitiesFor(currentHarness()).observability;
}

// Current session ID (set at session start)
let currentSessionId: string | null = null;

/**
 * Event types that can be emitted
 */
export type EventType =
	| "session.start"
	| "session.end"
	| "tool.execute"
	| "tool.blocked"
	| "security.block"
	| "security.warn"
	| "message.user"
	| "message.assistant"
	| "rating.explicit"
	| "rating.implicit"
	| "agent.spawn"
	| "agent.complete"
	| "learning.captured"
	| "isc.validated"
	| "context.loaded";

/**
 * Observability event structure
 */
export interface ObservabilityEvent {
	id: string;
	timestamp: string;
	session_id: string;
	event_type: EventType;
	data: Record<string, unknown>;
}

/**
 * Emit an event to the observability server
 *
 * This function is designed to be fire-and-forget:
 * - Uses a short timeout (1s)
 * - Never throws errors
 * - Logs failures but doesn't propagate them
 */
export async function emitEvent(
	eventType: EventType,
	data: Record<string, unknown> = {}
): Promise<void> {
	// Skip if disabled — se `erPå()` for hvorfor dette ikke er en konstant.
	if (!erPå()) return;

	// Generate session ID if not set
	if (!currentSessionId) {
		currentSessionId = generateSessionId();
	}

	const event: ObservabilityEvent = {
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		session_id: currentSessionId,
		event_type: eventType,
		// Masked: events carry tool arguments, and the server may store them (#367).
		data: maskDeep(data).value,
	};

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

		await fetch(OBSERVABILITY_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(event),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);
		fileLog(`[Observability] Emitted: ${eventType}`, "debug");
	} catch (error) {
		// Fail silently - observability is non-critical
		// Only log in debug mode to avoid noise
		fileLog(`[Observability] Failed to emit ${eventType}: ${error}`, "debug");
	}
}

/**
 * Generate a session ID
 */
function generateSessionId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `ses_${timestamp}_${random}`;
}

/**
 * Set the current session ID (called at session start)
 */
export function setSessionId(sessionId: string): void {
	currentSessionId = sessionId;
}

/**
 * Get the current session ID
 */
export function getSessionId(): string {
	if (!currentSessionId) {
		currentSessionId = generateSessionId();
	}
	return currentSessionId;
}

/**
 * Reset session (called at session end)
 *
 * @param sessionId - The session ID that is ending. When provided and it
 *   does not match the currently tracked session, the reset is skipped so
 *   that a stray/late "session end" for one session cannot clobber the ID
 *   of a different, still-active session. Omitting it preserves the old
 *   unconditional-reset behavior for backward compatibility.
 */
export function resetSession(sessionId?: string): void {
	if (sessionId && currentSessionId && sessionId !== currentSessionId) {
		fileLog(
			`[Observability] Skipping reset: ending session ${sessionId} does not match active session ${currentSessionId}`,
			"debug"
		);
		return;
	}
	currentSessionId = null;
}

// ============================================================================
// Event Helper Functions
// These wrap emitEvent with type-specific data formatting
//
// FIXED: All functions accept object parameters to match pai-unified.ts
// call patterns. Defensive null-checks prevent Object.keys(undefined) crashes.
// ============================================================================

/**
 * Emit session start event
 *
 * Accepts metadata object with any additional properties. Pass the real
 * OpenCode `sessionID` as `metadata.sessionId` so events correlate with the
 * actual session instead of a synthetic locally-generated one. Omitting it
 * preserves the old behavior (generate one if none is tracked yet).
 */
export async function emitSessionStart(
	metadata: { sessionId?: string } & Record<string, unknown> = {}
): Promise<void> {
	const { sessionId, ...rest } = metadata;

	if (sessionId) {
		// Correlate with the real OpenCode session ID.
		setSessionId(sessionId);
	} else if (!currentSessionId) {
		// Only generate a synthetic ID if none is tracked yet (avoid double-emit).
		setSessionId(generateSessionId());
	}

	await emitEvent("session.start", {
		...rest,
		working_directory: process.cwd(),
		platform: process.platform,
	});
}

/**
 * Emit session end event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern.
 * Pass the real OpenCode `sessionID` as `input.sessionId` so the reset only
 * clears the session that actually ended (see resetSession). Omitting it
 * preserves the old unconditional-reset behavior.
 */
export async function emitSessionEnd(
	input: {
		duration_ms?: number;
		eventType?: string;
		timestamp?: string;
		sessionId?: string;
	} & Record<string, unknown> = {}
): Promise<void> {
	const { duration_ms, sessionId, ...rest } = input;
	await emitEvent("session.end", {
		duration_ms,
		...rest,
	});
	resetSession(sessionId);
}

/**
 * Emit tool execution event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern
 */
export async function emitToolExecute(input: {
	tool: string;
	args?: string | Record<string, unknown>;
	duration_ms?: number;
	success?: boolean;
	result_length?: number;
}): Promise<void> {
	const { tool, args, duration_ms, success, result_length } = input;

	// Defensive: handle undefined, string, or object args
	let argsKeys: string[] = [];
	let argsPreview = "";

	if (args) {
		if (typeof args === "string") {
			argsKeys = ["serialized"];
			argsPreview = args.substring(0, 200);
		} else {
			argsKeys = Object.keys(args);
			argsPreview = JSON.stringify(args).substring(0, 200);
		}
	}

	await emitEvent("tool.execute", {
		tool,
		args_keys: argsKeys,
		args_preview: argsPreview,
		duration_ms,
		success,
		result_length,
	});
}

/**
 * Emit security block event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern
 */
export async function emitSecurityBlock(input: {
	tool: string;
	reason: string;
	pattern?: string;
	args?: string;
}): Promise<void> {
	const { tool, reason, pattern, args } = input;
	await emitEvent("security.block", {
		tool,
		reason,
		pattern,
		args,
	});
}

/**
 * Emit security warning event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern
 */
export async function emitSecurityWarn(input: {
	tool: string;
	reason: string;
	args?: string;
}): Promise<void> {
	const { tool, reason, args } = input;
	await emitEvent("security.warn", {
		tool,
		reason,
		args,
	});
}

/**
 * Emit user message event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern
 */
export async function emitUserMessage(input: {
	content?: string;
	content_length?: number;
	has_rating?: boolean;
	messageId?: string;
	source?: string;
}): Promise<void> {
	const { content, content_length, has_rating, messageId, source } = input;
	await emitEvent("message.user", {
		content_length: content_length ?? content?.length ?? 0,
		has_rating: has_rating ?? false,
		messageId,
		source,
	});
}

/**
 * Emit assistant message event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern
 */
export async function emitAssistantMessage(input: {
	content?: string;
	content_length?: number;
	has_voice_line?: boolean;
	has_isc?: boolean;
	messageId?: string;
}): Promise<void> {
	const { content, content_length, has_voice_line, has_isc, messageId } = input;
	await emitEvent("message.assistant", {
		content_length: content_length ?? content?.length ?? 0,
		has_voice_line: has_voice_line ?? false,
		has_isc: has_isc ?? false,
		messageId,
	});
}

/**
 * Emit explicit rating event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern
 */
export async function emitExplicitRating(input: {
	score: number;
	comment?: string;
	context?: string;
	messageId?: string;
	source?: string;
}): Promise<void> {
	const { score, comment, context, messageId, source } = input;
	await emitEvent("rating.explicit", {
		score,
		has_comment: !!comment,
		comment_preview: comment?.substring(0, 100),
		context,
		messageId,
		source,
	});
}

/**
 * Emit implicit sentiment event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern
 */
export async function emitImplicitSentiment(input: {
	score?: number;
	sentiment?: string;
	confidence: number;
	indicators?: string[];
	triggers?: string[];
	messageId?: string;
}): Promise<void> {
	const { score, sentiment, confidence, indicators, triggers, messageId } = input;
	await emitEvent("rating.implicit", {
		score,
		sentiment,
		confidence,
		indicators: indicators ?? triggers ?? [],
		messageId,
	});
}

/**
 * Emit agent spawn event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern
 */
export async function emitAgentSpawn(input: {
	taskId?: string;
	agentType?: string;
	agent_type?: string;
	prompt_length?: number;
}): Promise<void> {
	const { taskId, agentType, agent_type, prompt_length } = input;
	await emitEvent("agent.spawn", {
		task_id: taskId,
		agent_type: agentType ?? agent_type,
		prompt_length,
	});
}

/**
 * Emit agent complete event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern
 */
export async function emitAgentComplete(input: {
	taskId?: string;
	agentType?: string;
	agent_type?: string;
	result_length?: number;
	duration_ms?: number;
	success?: boolean;
	outputPath?: string;
	error?: string;
}): Promise<void> {
	const { taskId, agentType, agent_type, result_length, duration_ms, success, outputPath, error } =
		input;
	await emitEvent("agent.complete", {
		task_id: taskId,
		agent_type: agentType ?? agent_type,
		result_length,
		duration_ms,
		success,
		output_path: outputPath,
		error,
	});
}


/**
 * Emit learning captured event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern
 */
export async function emitLearningCaptured(input: {
	category?: string;
	filepath?: string;
	count?: number;
	learnings?: string[];
}): Promise<void> {
	const { category, filepath, count, learnings } = input;
	await emitEvent("learning.captured", {
		category,
		filepath,
		count,
		learnings,
	});
}

/**
 * Emit ISC validation event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern
 */
export async function emitISCValidated(input: {
	valid?: boolean;
	all_passed?: boolean;
	criteriaCount?: number;
	criteria_count?: number;
	issues?: string[];
	warnings?: string[];
	messageId?: string;
}): Promise<void> {
	const { valid, all_passed, criteriaCount, criteria_count, issues, warnings, messageId } = input;
	const warnList = issues ?? warnings ?? [];
	await emitEvent("isc.validated", {
		criteria_count: criteriaCount ?? criteria_count ?? 0,
		all_passed: all_passed ?? valid ?? true,
		warning_count: warnList.length,
		warnings: warnList.slice(0, 5),
		messageId,
	});
}

/**
 * Emit context loaded event
 *
 * FIXED: Accept object parameter to match pai-unified.ts call pattern
 */
export async function emitContextLoaded(input: {
	files_loaded?: number;
	total_size?: number;
	contextLength?: number;
	success?: boolean;
	error?: string;
}): Promise<void> {
	const { files_loaded, total_size, contextLength, success, error } = input;
	await emitEvent("context.loaded", {
		files_loaded,
		total_size: total_size ?? contextLength,
		success,
		error,
	});
}
