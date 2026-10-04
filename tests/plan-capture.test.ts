/**
 * Kontrakt-test: planer fra plan-modus fanges til `.opencode/Plans/`
 *
 * Stiene er MÅLT: Claude Code 2.1.283 skriver `~/.claude/plans/<slug>.md` med
 * `Write` (PostToolUse fyrer med `file_path`), og OpenCode v2 skriver
 * en fil i `$HOME/.opencode/plan/` med `write` og `path` (navnet velger
 * modellen: `plan.md` i fase 0, `hello-plan.md` i V2Smoke). Testen kjører
 * begge gjennom `dispatch` med motorens egen form etter `kanoniskeArgs`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, sessionKeyFor } from "../.opencode/pai-core";
import { planFilnavn, somPlanfil } from "../.opencode/pai-core/handlers/plan-capture";
import { kanoniskeArgs } from "../.opencode/pai-core/lib/tool-names";
import type { Harness } from "../.opencode/pai-core/types";

let temp: string;
let plans: string;
const lagret: Record<string, string | undefined> = {};

beforeAll(() => {
	temp = mkdtempSync(join(tmpdir(), "pai-plan-"));
	plans = join(temp, "pai-home", "Plans");
	for (const k of ["PAI_HOME", "PAI_LOG_PATH"]) lagret[k] = process.env[k];
	process.env.PAI_HOME = join(temp, "pai-home");
	process.env.PAI_LOG_PATH = join(temp, "test.log");
});

afterAll(() => {
	for (const [k, v] of Object.entries(lagret)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(temp, { recursive: true, force: true });
});

function skrevet(sti: string, innhold: string): string {
	mkdirSync(join(sti, ".."), { recursive: true });
	writeFileSync(sti, innhold);
	return sti;
}

function etter(harness: Harness, sessionId: string, tool: string, input: Record<string, unknown>) {
	return dispatch({
		harness,
		sessionId,
		sessionKey: sessionKeyFor(harness, sessionId),
		at: Date.now(),
		cwd: temp,
		type: "tool.after",
		tool,
		args: kanoniskeArgs(input),
		result: "ok",
	});
}

describe("somPlanfil", () => {
	test("kjenner begge motorenes planfil, og ingenting annet", () => {
		expect(somPlanfil("/home/x/.claude/plans/lag-en-plan-vectorized-lake.md")).toEqual({
			kilde: "claude",
			slug: "lag-en-plan-vectorized-lake",
		});
		expect(somPlanfil("/tmp/h/.opencode/plan/plan.md")).toEqual({ kilde: "opencode", slug: "plan" });
		expect(somPlanfil("/tmp/h/.opencode/plan/hello-plan.md")).toEqual({ kilde: "opencode", slug: "hello-plan" });
		// Claude skriver planene flatt i `plans/` (MÅLT); en underkatalog er noe annet.
		for (const s of ["/home/x/.claude/plans/sub/dyp.md", "/p/plan.md", "/home/x/.claude/plans/a.txt", "/p/.opencode/plan/sub/dyp.md", "/p/.opencode/plan/notat.txt", "/p/Plans/x.md"]) {
			expect(somPlanfil(s)).toBeUndefined();
		}
	});

	test("v2s planer skilles per økt, fordi plan.md går igjen; Claudes slug er nok", () => {
		expect(planFilnavn({ kilde: "opencode", slug: "plan" }, "ses_abc")).toBe("opencode-plan-ses_abc.md");
		expect(planFilnavn({ kilde: "claude", slug: "s" }, "uuid")).toBe("claude-s.md");
		expect(planFilnavn({ kilde: "opencode", slug: "plan" }, "../../x")).toBe("opencode-plan-x.md");
	});
});

describe("fangst gjennom tool.after", () => {
	test("Claude: Write med file_path til ~/.claude/plans/ gir et øyeblikksbilde", async () => {
		const sti = skrevet(join(temp, "home", ".claude", "plans", "plan-for-hei.md"), "# Plan\n\n1. Skriv hei\n");
		const r = await etter("claude", "uuid-1", "Write", { file_path: sti, content: "…" });
		expect(r.notes).toContain("plan-captured");
		const bilde = readFileSync(join(plans, "claude-plan-for-hei.md"), "utf-8");
		expect(bilde).toContain("harness: claude");
		expect(bilde).toContain(`kilde: ${sti}`);
		expect(bilde.endsWith("# Plan\n\n1. Skriv hei\n")).toBe(true);
	});

	test("v2: write med path til .opencode/plan/ gir et øyeblikksbilde per økt", async () => {
		const sti = skrevet(join(temp, "home", ".opencode", "plan", "hello-plan.md"), "# v2-plan\n");
		const r = await etter("opencode2", "ses_p1", "write", { path: sti, content: "…" });
		expect(r.notes).toContain("plan-captured");
		expect(readFileSync(join(plans, "opencode-hello-plan-ses_p1.md"), "utf-8")).toContain("harness: opencode2");
	});

	test("v2 med en gpt-modell: patch med Add File til .opencode/plan/ fanges (K58)", async () => {
		// Motoren gir `patch` i stedet for write/edit til `gpt-`-modeller
		// (UTLEDET av `tool/plugin/patch.ts`), og stien står bare i patch-teksten.
		const sti = skrevet(join(temp, "home", ".opencode", "plan", "gpt-plan.md"), "# gpt-plan\n");
		const patchText = `*** Begin Patch\n*** Add File: ${sti}\n+# gpt-plan\n*** End Patch`;
		const r = await etter("opencode2", "ses_p2", "patch", { patchText });
		expect(r.notes).toContain("plan-captured");
		expect(readFileSync(join(plans, "opencode-gpt-plan-ses_p2.md"), "utf-8")).toContain("# gpt-plan");
	});

	test("en edit leser hele fila fra disk og erstatter bildet", async () => {
		const sti = skrevet(join(temp, "home", ".claude", "plans", "redigert.md"), "# Første\n");
		await etter("claude", "uuid-2", "Write", { file_path: sti });
		writeFileSync(sti, "# Andre, hele planen\n");
		await etter("claude", "uuid-2", "Edit", { file_path: sti, old_string: "Første", new_string: "Andre" });
		const bilde = readFileSync(join(plans, "claude-redigert.md"), "utf-8");
		expect(bilde).toContain("# Andre, hele planen");
		expect(bilde).not.toContain("# Første");
	});

	test("en identisk skriving rører ikke bildet", async () => {
		const sti = skrevet(join(temp, "home", ".claude", "plans", "uendret.md"), "# Samme\n");
		await etter("claude", "uuid-3", "Write", { file_path: sti });
		const mål = join(plans, "claude-uendret.md");
		const før = readFileSync(mål, "utf-8");
		const mtime = statSync(mål).mtimeMs;
		await new Promise((r) => setTimeout(r, 15));
		const r = await etter("claude", "uuid-3", "Write", { file_path: sti });
		expect(r.notes ?? []).not.toContain("plan-captured");
		expect(readFileSync(mål, "utf-8")).toBe(før);
		expect(statSync(mål).mtimeMs).toBe(mtime);
	});

	test("en vanlig fil gir ingenting i Plans/", async () => {
		const antall = existsSync(plans) ? readdirSync(plans).length : 0;
		const sti = skrevet(join(temp, "proj", "plan.md"), "# ikke en planfil\n");
		const r = await etter("opencode2", "ses_p2", "write", { path: sti });
		expect(r.notes ?? []).not.toContain("plan-captured");
		expect(existsSync(plans) ? readdirSync(plans).length : 0).toBe(antall);
	});

	test("en read av planfila fanger ikke", async () => {
		const sti = skrevet(join(temp, "home", ".opencode", "plan", "plan.md"), "# lest\n");
		const r = await etter("opencode2", "ses_p3", "read", { path: sti });
		expect(r.notes ?? []).not.toContain("plan-captured");
		expect(existsSync(join(plans, "opencode-plan-ses_p3.md"))).toBe(false);
	});
});

test(".opencode/plan/ er gitignorert, så v2s arbeidsfil ikke committes", () => {
	const p = Bun.spawnSync(["git", "check-ignore", "-q", "--no-index", ".opencode/plan/plan.md"], {
		cwd: join(import.meta.dir, ".."),
	});
	// Utenfor et git-tre (harnesset distribueres som tarball) er det ingenting å sjekke.
	if (p.exitCode === 128) return;
	expect(p.exitCode).toBe(0);
});
