/**
 * Secret masking of tool output, shared by both engines' adapters.
 *
 * The adapter calls this after a tool has run and before the model sees the
 * result (Claude Code: PostToolUse `updatedToolOutput`; OpenCode v2:
 * `execute.after` replacing `result`). Every masking is recorded in the
 * security audit log with the kinds and names that were masked, never the
 * values, so `pai doctor` can show how often it happens.
 *
 * @module pai-core/handlers/secret-masking
 */

import { maskDeep, maskNotice, type SecretHit } from "../lib/secrets";
import { logSecurityEvent } from "./security-validator";

export interface MaskedToolResult<T> {
	/** The result to hand the model: the same reference when nothing was masked. */
	result: T;
	hits: SecretHit[];
	/** A one-line note for the model, or null when nothing was masked. */
	notice: string | null;
}

export function maskToolResult<T>(tool: string, result: T): MaskedToolResult<T> {
	const { value, hits } = maskDeep(result);
	if (hits.length === 0) return { result, hits, notice: null };
	logSecurityEvent({
		timestamp: new Date().toISOString(),
		tool,
		action: "masked",
		reason: "secrets in tool output were masked before the model saw them",
		masked: hits.map((h) => (h.kind === "known" ? h.label : h.kind)),
	});
	return { result: value, hits, notice: maskNotice(hits) };
}
