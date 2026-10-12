/**
 * Contract test: the clock line (#429)
 *
 * The DA identity reminds the user to take a break, and can only do that
 * when it knows the time and how long the user has been at it. The line gives
 * both as facts: with `user.message` under Claude, which records the prompt,
 * and with `context.build` under v2, which only reads. A pause of `BREAK_MS`
 * starts a new count.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../.opencode/pai-core";
import type { PaiEvent } from "../.opencode/pai-core";
import { clockLine, formatDuration, formatLocal } from "../.opencode/pai-core/dispatch/clock";
import { BREAK_MS, nextSitting, sittingFile } from "../.opencode/pai-core/dispatch/state";

const MIN = 60_000;
// Monday 2026-10-12 23:40 in Oslo (CEST, UTC+2).
const AT = Date.parse("2026-10-12T21:40:00Z");

describe("the sitting", () => {
	test("the first prompt starts one", () => {
		expect(nextSitting(null, AT)).toEqual({ start: AT, last: AT });
	});

	test("a prompt within the break continues it", () => {
		const s = nextSitting({ start: AT, last: AT + 20 * MIN }, AT + 20 * MIN + BREAK_MS - 1);
		expect(s).toEqual({ start: AT, last: AT + 20 * MIN + BREAK_MS - 1 });
	});

	test("a gap of exactly the break starts a new one", () => {
		const now = AT + 20 * MIN + BREAK_MS;
		expect(nextSitting({ start: AT, last: AT + 20 * MIN }, now)).toEqual({ start: now, last: now });
	});
});

describe("the line", () => {
	test.each([
		[0, "less than a minute"],
		[59_999, "less than a minute"],
		[45 * MIN, "45 min"],
		[60 * MIN, "1 h"],
		[130 * MIN, "2 h 10 min"],
	])("%d ms is %s", (ms, text) => {
		expect(formatDuration(ms)).toBe(text);
	});

	test("local time with the weekday, in the zone it names", () => {
		expect(formatLocal(AT, "Europe/Oslo")).toBe("Monday 2026-10-12 23:40");
		expect(formatLocal(AT, "UTC")).toBe("Monday 2026-10-12 21:40");
	});

	test("with a sitting: who, how long and since when", () => {
		const line = clockLine(AT, { start: AT - 130 * MIN, last: AT - 5 * MIN }, "Europe/Oslo", "Ada");
		expect(line).toBe(
			"Clock: Monday 2026-10-12 23:40 (Europe/Oslo). Ada has been at it for 2 h 10 min in this session, since 21:30 (a pause of 30 min or more starts a new count).",
		);
	});

	test("a sitting a break old gives the time only, not its duration", () => {
		const line = clockLine(AT, { start: AT - 3 * 60 * MIN, last: AT - BREAK_MS }, "Europe/Oslo", "Ada");
		expect(line).toBe("Clock: Monday 2026-10-12 23:40 (Europe/Oslo).");
	});
});

describe("through the core", () => {
	let home: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pai-clock-"));
		for (const k of ["PAI_HOME", "PAI_LOG_PATH", "PAI_ENABLED"]) saved[k] = process.env[k];
		process.env.PAI_HOME = home;
		process.env.PAI_LOG_PATH = join(home, "debug.log");
		process.env.PAI_ENABLED = "1";
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(home, { recursive: true, force: true });
	});

	const base = (at: number) => ({
		harness: "claude" as const,
		sessionId: "ses_clock",
		sessionKey: "cl_ses_clock",
		at,
		cwd: "/tmp",
	});
	const prompt = (at: number) =>
		// A text of its own each time: the dedupe window would swallow a repeat.
		dispatch({ ...base(at), type: "user.message", text: `prompt at ${at}` } as PaiEvent);
	const clockOf = (lines: string[] | undefined) => (lines ?? []).find((l) => l.startsWith("Clock: "));

	test("every prompt gets the line, and the count runs until a break", async () => {
		expect(clockOf((await prompt(AT)).additionalContext)).toContain("for less than a minute");
		await prompt(AT + 20 * MIN);
		expect(clockOf((await prompt(AT + 40 * MIN)).additionalContext)).toContain("for 40 min in this session");
		const after = clockOf((await prompt(AT + 40 * MIN + BREAK_MS)).additionalContext);
		expect(after).toContain("for less than a minute");
	});

	test("context.build reads the sitting and does not move it", async () => {
		await prompt(AT);
		const before = readFileSync(sittingFile("cl_ses_clock"), "utf-8");
		const built = await dispatch({ ...base(AT + 20 * MIN), type: "context.build" } as PaiEvent);
		const lines = built.additionalContext ?? [];
		expect(lines.at(-1)).toContain("for 20 min in this session");
		expect(readFileSync(sittingFile("cl_ses_clock"), "utf-8")).toBe(before);
	});

	test("context.build without a prompt yet: the time, no file", async () => {
		const built = await dispatch({ ...base(AT), type: "context.build" } as PaiEvent);
		expect(built.additionalContext?.at(-1)).toMatch(/^Clock: \w+day \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+\)\.$/);
		expect(existsSync(sittingFile("cl_ses_clock"))).toBe(false);
	});

	test("without PAI_ENABLED: no line", async () => {
		delete process.env.PAI_ENABLED;
		expect(clockOf((await prompt(AT)).additionalContext)).toBeUndefined();
	});
});
