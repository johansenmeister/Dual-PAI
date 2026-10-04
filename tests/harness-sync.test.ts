/**
 * HarnessSync (C5): de rene delene. Nettverket er ikke med; linjene under er
 * ekte, fra Claude Codes `CHANGELOG.md` og v2s compare-svar 2026-09-27.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLAUDE_REGLER,
	klassifiser,
	lesPinning,
	type MotorRapport,
	sammenlignVersjon,
	seksjonerMellom,
	utfall,
	V2_REGLER,
	v2Treff,
} from "../.opencode/PAI/Tools/HarnessSync";

const tmp = mkdtempSync(join(tmpdir(), "pai-harness-sync-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const LOGG = `# Changelog

## 2.1.283

- Changed \`--system-prompt\` and \`--append-system-prompt\` to accept their text and \`-file\` forms together; the file's text comes first
- Fixed the weekly Fable limit not appearing in \`/usage\`

## 2.1.282

- Fixed the prompt's example text flashing and disappearing at startup in projects with a \`SessionStart\` hook

## 2.1.281

- Improved plugin hook-failure errors to name the offending plugin, and added a \`claude plugin validate\` warning when a shell-form hook leaves \`\${CLAUDE_PLUGIN_ROOT}\` unquoted

## 2.1.280

- Added hook output sizes and the number of oversized outputs saved to a file
`;

describe("versjonene", () => {
	test("numerisk, ikke leksikalsk", () => {
		expect(sammenlignVersjon("2.1.283", "2.1.29")).toBe(1);
		expect(sammenlignVersjon("2.0.9", "2.0.18")).toBe(-1);
		expect(sammenlignVersjon("v2.0.18", "2.0.18")).toBe(0);
	});

	test("seksjonene med fra < versjon <= til", () => {
		const s = seksjonerMellom(LOGG, "2.1.281", "2.1.283");
		expect(s.map((x) => x.versjon)).toEqual(["2.1.283", "2.1.282"]);
		expect(s[0].linjer).toHaveLength(2);
	});

	test("den pinnede versjonen er ikke med, den siste er det", () => {
		expect(seksjonerMellom(LOGG, "2.1.283", "2.1.283")).toEqual([]);
		expect(seksjonerMellom(LOGG, "2.1.279", "2.1.280").map((x) => x.versjon)).toEqual(["2.1.280"]);
	});
});

describe("registeret", () => {
	const [prompt, fable] = seksjonerMellom(LOGG, "2.1.282", "2.1.283")[0].linjer;

	test("2.1.283s endring av --append-system-prompt flagges som K-10", () => {
		expect(klassifiser(prompt, CLAUDE_REGLER)).toContain("--append-system-prompt-file (K-10)");
	});

	test("en endring som ikke rører noe, flagges ikke", () => {
		expect(klassifiser(fable, CLAUDE_REGLER)).toEqual([]);
	});

	test("skallform og CLAUDE_PLUGIN_ROOT er M-42", () => {
		const linje = seksjonerMellom(LOGG, "2.1.280", "2.1.281")[0].linjer[0];
		expect(klassifiser(linje, CLAUDE_REGLER)).toContain("hooks i exec-form, CLAUDE_PLUGIN_ROOT (M-42)");
	});

	test("hook-hendelsene og hook-taket", () => {
		const [start] = seksjonerMellom(LOGG, "2.1.281", "2.1.282")[0].linjer;
		expect(klassifiser(start, CLAUDE_REGLER)).toContain("hook-hendelsene");
		expect(klassifiser("Fixed hook additionalContext over 10,000 characters", CLAUDE_REGLER)).toContain(
			"hook-taket (K-10)"
		);
	});

	test("hver rad står bare én gang per linje", () => {
		const rader = klassifiser("PreToolUse hook permissionDecision", CLAUDE_REGLER);
		expect(new Set(rader).size).toBe(rader.length);
	});
});

describe("v2: compare-svaret", () => {
	const svar = {
		total_commits: 4,
		commits: [
			{ commit: { message: "sync release versions for v2.0.17" } },
			{ commit: { message: "fix(core): report shell commands killed by a signal (#51145)\n\nbrødtekst" } },
			{ commit: { message: "refactor(util): share a browser opener across cli, tui, and core (#51412)" } },
			{ commit: { message: "release: v2.0.18" } },
		],
		files: [
			{ filename: "packages/core/src/plugin/internal.ts" },
			{ filename: "packages/core/test/plugin/verbosity.test.ts" },
			{ filename: "packages/tui/src/app.tsx" },
		],
	};

	test("release-commitene hoppes over, skallet flagges, resten telles", () => {
		const r = v2Treff(svar, "v2.0.17...v2.0.18");
		const tekster = r.treff.map((t) => t.tekst);
		expect(tekster).toContain("fix(core): report shell commands killed by a signal (#51145)");
		expect(r.uflagget).toBe(1);
		expect(r.avkortet).toBe(false);
	});

	test("en plugin-sti flagges, testfilene ikke", () => {
		const tekster = v2Treff(svar, "s").treff.map((t) => t.tekst);
		expect(tekster).toContain("file: packages/core/src/plugin/internal.ts");
		expect(tekster.some((t) => t.includes("/test/"))).toBe(false);
	});

	test("300 filer eller færre commits enn totalen er avkortet", () => {
		expect(v2Treff({ ...svar, total_commits: 300 }, "s").avkortet).toBe(true);
		const filer = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` }));
		expect(v2Treff({ ...svar, files: filer }, "s").avkortet).toBe(true);
	});

	test("v2-reglene kjenner skallverktøyet", () => {
		expect(klassifiser("fix(core): restore the shell no-output placeholder", V2_REGLER)).toContain(
			"skallverktøyet heter shell (vakten)"
		);
	});
});

describe("utfallet", () => {
	const r = (x: Partial<MotorRapport>): MotorRapport => ({
		motor: "claude-code",
		pinnet: "1.0.0",
		siste: "1.0.0",
		nyere: [],
		treff: [],
		uflagget: 0,
		...x,
	});

	test("0, 2, 1 og 3", () => {
		expect(utfall([r({}), r({ motor: "opencode-v2" })])).toBe(0);
		expect(utfall([r({ nyere: ["1.0.1"] }), r({})])).toBe(2);
		expect(utfall([r({ nyere: ["1.0.1"], treff: [{ versjon: "1.0.1", tekst: "x", rader: ["y"] }] })])).toBe(1);
	});

	test("en kilde som ikke svarte, vinner over alt: ingen konklusjon", () => {
		const treff = r({ nyere: ["1.0.1"], treff: [{ versjon: "1.0.1", tekst: "x", rader: ["y"] }] });
		expect(utfall([treff, r({ motor: "opencode-v2", feil: "HTTP 403" })])).toBe(3);
	});
});

describe("pinningen", () => {
	test("leser begge motorene fra package.json", () => {
		writeFileSync(
			join(tmp, "package.json"),
			JSON.stringify({ dependencies: { "@opencode/cli": "2.0.18" }, pai: { claudeCode: "2.1.283" } })
		);
		expect(lesPinning(tmp)).toEqual({ claude: "2.1.283", v2: "2.0.18" });
	});

	test("repoets pinning er den selvtesten bruker", () => {
		const p = lesPinning(join(import.meta.dir, "..", ".opencode"));
		expect(p.claude).toMatch(/^\d+\.\d+\.\d+$/);
		expect(p.v2).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
