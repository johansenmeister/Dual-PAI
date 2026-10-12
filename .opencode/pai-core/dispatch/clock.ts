/**
 * The clock line: local time, and how long the user has been at it (#429)
 *
 * The model knows the date at most (Claude Code puts it in the system prompt)
 * and never the time of day, and PAI used the clock only for MEMORY
 * timestamps. A DA identity that reminds the user to take a break needs both,
 * so this line gives them as facts. When to say something is the identity's
 * call, not this module's.
 *
 * "At it" is the current sitting: the time since the first prompt after a gap
 * of `BREAK_MS` or more (`dispatch/state.ts`).
 *
 * The line travels like the work-session line (`dispatch/arbeidsokt.ts`): with
 * `user.message` under Claude (`UserPromptSubmit`), which also records the
 * prompt, and with `context.build` under v2, rebuilt every turn, which only
 * reads. Under Claude it stays in the history, about 150 characters per
 * prompt, and dates each prompt as a side effect. Under v2 it goes last, after
 * the static context, so a provider's prefix cache keeps everything before it.
 * Only with `PAI_ENABLED=1`, like the rest of the context.
 *
 * @module dispatch/clock
 */

import { fileLogError } from "../lib/file-logger";
import { getPrincipal } from "../lib/identity";
import { displayTimeZone } from "../lib/time";
import { BREAK_MS, readSitting, recordPrompt, type Sitting } from "./state";

/** "2 h 10 min", "2 h", "45 min", "less than a minute". */
export function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "less than a minute";
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours === 0) return `${rest} min`;
	return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** "23:40" in `zone`. */
function hourMinute(at: number, zone: string): string {
	return new Date(at).toLocaleTimeString("sv-SE", { timeZone: zone, hour: "2-digit", minute: "2-digit" });
}

/** "Sunday 2026-10-12 23:40" in `zone`. */
export function formatLocal(at: number, zone: string): string {
	const date = new Date(at);
	const weekday = date.toLocaleDateString("en-GB", { timeZone: zone, weekday: "long" });
	const day = date.toLocaleDateString("sv-SE", { timeZone: zone });
	return `${weekday} ${day} ${hourMinute(at, zone)}`;
}

/**
 * The line itself. Without a sitting, or when the last prompt is a break ago
 * (v2 can build the context before the new prompt is recorded), it gives the
 * time only: a duration from the previous sitting would be wrong.
 */
export function clockLine(at: number, sitting: Sitting | null, zone: string, who: string): string {
	const now = `Clock: ${formatLocal(at, zone)} (${zone}).`;
	if (!sitting || at - sitting.last >= BREAK_MS) return now;
	return `${now} ${who} has been at it for ${formatDuration(at - sitting.start)} in this session, since ${hourMinute(sitting.start, zone)} (a pause of ${BREAK_MS / 60_000} min or more starts a new count).`;
}

/**
 * The clock line for an event. `record` is true for a prompt (`user.message`)
 * and false for `context.build`, which must not move the sitting: v2 builds
 * the context on every turn, also when the model works on without a prompt.
 */
export async function clockContext(
	event: { sessionKey: string; at: number },
	record: boolean,
): Promise<string | null> {
	if (process.env.PAI_ENABLED !== "1") return null;
	try {
		const sitting = record ? await recordPrompt(event.sessionKey, event.at) : await readSitting(event.sessionKey);
		return clockLine(event.at, sitting, displayTimeZone(), getPrincipal().name);
	} catch (error) {
		fileLogError("[Clock] Could not build the clock line", error);
		return null;
	}
}
