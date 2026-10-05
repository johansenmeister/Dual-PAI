/**
 * Kontrakt-test: `claudeSti` finner installerens `claude` også uten PATH (#247)
 *
 * MineReflections feilet under cron på `pai` 2026-10-01: `Inference.ts`
 * startet `claude` fra PATH, og cron har ikke `~/.local/bin` der. Rekkefølgen
 * er launcherens: `PAI_CLAUDE_BIN`, installerens `~/.local/bin/claude`, PATH.
 *
 * @module tests/claude-sti
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSti } from "../.opencode/PAI/Tools/claude-sti";

const røtter: string[] = [];
afterAll(() => {
	for (const r of røtter) rmSync(r, { recursive: true, force: true });
});

/** Et HOME med `~/.local/bin/claude`, kjørbar eller ikke. */
function hjem(kjørbar: boolean | null): string {
	const h = mkdtempSync(join(tmpdir(), "pai-claude-sti-"));
	røtter.push(h);
	if (kjørbar === null) return h;
	mkdirSync(join(h, ".local", "bin"), { recursive: true });
	const bin = join(h, ".local", "bin", "claude");
	writeFileSync(bin, "#!/bin/sh\n");
	chmodSync(bin, kjørbar ? 0o755 : 0o644);
	return h;
}

describe("claudeSti (#247)", () => {
	test("installerens ~/.local/bin/claude, uansett PATH", () => {
		const h = hjem(true);
		expect(claudeSti({ HOME: h, PATH: "/usr/bin:/bin" })).toBe(join(h, ".local", "bin", "claude"));
	});

	test("PAI_CLAUDE_BIN går foran", () => {
		expect(claudeSti({ HOME: hjem(true), PAI_CLAUDE_BIN: "/opt/claude" })).toBe("/opt/claude");
	});

	test("uten installerens binær: claude fra PATH", () => {
		expect(claudeSti({ HOME: hjem(null) })).toBe("claude");
	});

	test("en fil som ikke er kjørbar, velges ikke", () => {
		expect(claudeSti({ HOME: hjem(false) })).toBe("claude");
	});

	test("uten HOME: claude fra PATH", () => {
		expect(claudeSti({})).toBe("claude");
	});
});
