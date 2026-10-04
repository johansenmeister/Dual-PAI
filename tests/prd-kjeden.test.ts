/**
 * M-47: PRD-kjeden kjenner PRD-ene modellen skriver
 *
 * Malen ba om `PRD-{YYYYMMDD}-{slug}.md` i en katalog modellen ikke kjente, og
 * uten `id`. Synken, fasesporingen, kompakteringen og teardown ventet `PRD.md`
 * med `id` i øktens katalog. MÅLT 2026-09-27: 0 av 5 PRD-er i MEMORY ble synket.
 * Nå er `PRD.md` kanonisk (malen og `PRDFORMAT.md`), kjernen oppgir
 * arbeidsøktens katalog, og leserne godtar de gamle navnene og en manglende `id`.
 *
 * Isolert via PAI_HOME og PAI_LOG_PATH.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../.opencode/pai-core";
import type { PaiEvent } from "../.opencode/pai-core";
import { buildCompactionContext } from "../.opencode/pai-core/handlers/compaction-intelligence";
import { erPrdSti, finnPrd, prdIdFraSti, syncPRDToRegistry } from "../.opencode/pai-core/handlers/prd-sync";
import { cleanupSession } from "../.opencode/pai-core/handlers/session-cleanup";
import { completeWorkSession, createWorkSession } from "../.opencode/pai-core/handlers/work-tracker";

let hjem: string;
const lagret: Record<string, string | undefined> = {};

beforeEach(() => {
	hjem = mkdtempSync(join(tmpdir(), "pai-prd-kjeden-"));
	for (const k of ["PAI_HOME", "PAI_LOG_PATH", "PAI_ENABLED"]) lagret[k] = process.env[k];
	process.env.PAI_HOME = hjem;
	process.env.PAI_LOG_PATH = join(hjem, "debug.log");
});

afterEach(() => {
	for (const [k, v] of Object.entries(lagret)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(hjem, { recursive: true, force: true });
});

/** De ekte PRD-enes form (MÅLT): `prd:`/`session:`, ingen `id`. */
const GAMMEL = "---\nprd: semaphore-local-mirror\nsession: x\nstatus: ACTIVE\ncompleted_at: null\neffort: Extended\n---\n\n- [ ] ISC-1: noe\n";

async function økt(sesjon: string): Promise<string> {
	expect((await createWorkSession("Sjekk PRD-kjeden fra ende til ende", sesjon)).success).toBe(true);
	const work = join(hjem, "MEMORY", "WORK");
	const ym = readdirSync(work)[0];
	return join(work, ym, readdirSync(join(work, ym))[0]);
}

describe("navnet", () => {
	test("PRD.md og PRD-<dato>-<slug>.md under MEMORY/WORK, ikke PRDFORMAT.md eller utenfor", () => {
		expect(erPrdSti("/h/.opencode/MEMORY/WORK/2026-09/a/PRD.md")).toBe(true);
		expect(erPrdSti("/h/.opencode/MEMORY/WORK/x/PRD-20260903-authentik-upgrade.md")).toBe(true);
		expect(erPrdSti("/h/.opencode/MEMORY/WORK/x/PRDFORMAT.md")).toBe(false);
		expect(erPrdSti("/h/.opencode/MEMORY/WORK/x/PRD-.md")).toBe(false);
		expect(erPrdSti("/h/.opencode/PAI/PRD.md")).toBe(false);
	});

	test("finnPrd: PRD.md først, ellers den nyeste daterte, ellers null", () => {
		const d = join(hjem, "d");
		mkdirSync(d);
		expect(finnPrd(d)).toBeNull();
		writeFileSync(join(d, "PRD-20260901-a.md"), "");
		writeFileSync(join(d, "PRD-20260914-b.md"), "");
		expect(finnPrd(d)).toBe(join(d, "PRD-20260914-b.md"));
		writeFileSync(join(d, "PRD.md"), "");
		expect(finnPrd(d)).toBe(join(d, "PRD.md"));
	});

	test("id uten frontmatter-id: filnavnet, eller katalogen for PRD.md", () => {
		expect(prdIdFraSti("/w/x/PRD-20260903-authentik-upgrade.md")).toBe("PRD-20260903-authentik-upgrade");
		expect(prdIdFraSti("/w/2026-09-28T10-00-00_oppgave/PRD.md")).toBe("PRD-2026-09-28T10-00-00_oppgave");
	});
});

describe("leserne", () => {
	test("synken tar en gammel PRD uten id", async () => {
		const d = join(hjem, "MEMORY", "WORK", "semaphore");
		mkdirSync(d, { recursive: true });
		const prd = join(d, "PRD-20260914-semaphore-local-mirror.md");
		writeFileSync(prd, GAMMEL);
		expect(await syncPRDToRegistry(prd)).toEqual({ synced: true, prdId: "PRD-20260914-semaphore-local-mirror" });
		const reg = JSON.parse(readFileSync(join(hjem, "MEMORY", "STATE", "prd-registry.json"), "utf-8"));
		expect(reg.sessions["PRD-20260914-semaphore-local-mirror"].status).toBe("ACTIVE");
	});

	test("teardown markerer en datert PRD i øktkatalogen som fullført", async () => {
		const d = await økt("m47-cleanup");
		const prd = join(d, "PRD-20260928-oppgave.md");
		writeFileSync(prd, GAMMEL);
		await cleanupSession("m47-cleanup");
		const innhold = readFileSync(prd, "utf-8");
		expect(innhold).toContain("status: COMPLETED");
		expect(innhold).not.toContain("completed_at: null");
	});

	test("M-48: i teardowns rekkefølge (completeWorkSession først) markeres PRD-en med katalogen", async () => {
		const d = await økt("m48-rekkefolge");
		writeFileSync(join(d, "PRD.md"), GAMMEL);
		await completeWorkSession("m48-rekkefolge");
		await cleanupSession("m48-rekkefolge");
		expect(readFileSync(join(d, "PRD.md"), "utf-8")).toContain("status: ACTIVE");
		await cleanupSession("m48-rekkefolge", d);
		expect(readFileSync(join(d, "PRD.md"), "utf-8")).toContain("status: COMPLETED");
	});

	test("M-48: teardown sender katalogen den slo opp før ryddingen (pinnet i kilden; teardown kjøres ikke i suiten)", () => {
		const kilde = readFileSync(join(import.meta.dir, "..", ".opencode", "pai-core", "dispatch", "session.ts"), "utf-8");
		expect(kilde).toContain("await cleanupSession(sessionId, arbeid);");
		expect(kilde.indexOf("getCurrentWorkPath(sessionId)")).toBeLessThan(kilde.indexOf("await teardownSteg("));
	});

	test("kompakteringen tar PRD-en, med phase eller last_phase", async () => {
		const d = await økt("m47-kompakt");
		writeFileSync(join(d, "PRD.md"), "---\nid: PRD-x\nstatus: ACTIVE\nphase: BUILD\n---\n\n- [ ] ISC-1: noe\n");
		const deler = (await buildCompactionContext({ sessionID: "m47-kompakt" })).join("\n");
		expect(deler).toContain("Active PRD Status");
		expect(deler).toContain("BUILD");
	});
});

describe("modellen får vite hvor PRD-en skal", () => {
	const base = { harness: "claude" as const, sessionId: "m47-kontekst", sessionKey: "cc_m47-kontekst", at: Date.now(), cwd: "/tmp" };

	test("user.message med PAI_ENABLED gir arbeidsøktens katalog og PRD.md", async () => {
		process.env.PAI_ENABLED = "1";
		const svar = await dispatch({ ...base, type: "user.message", text: "Lag en plan for PRD-kjeden nå" } as PaiEvent);
		const tekst = (svar.additionalContext ?? []).join("\n");
		const d = readdirSync(join(hjem, "MEMORY", "WORK"))[0];
		expect(tekst).toContain(join(hjem, "MEMORY", "WORK", d));
		expect(tekst).toContain("/PRD.md");
	});

	test("uten PAI_ENABLED: ingenting", async () => {
		delete process.env.PAI_ENABLED;
		const svar = await dispatch({ ...base, type: "user.message", text: "Lag en plan for PRD-kjeden igjen" } as PaiEvent);
		expect(svar.additionalContext).toBeUndefined();
	});

	test("context.build tar linja med når økten har en arbeidsøkt (v2 bygger per tur)", async () => {
		process.env.PAI_ENABLED = "1";
		await dispatch({ ...base, type: "user.message", text: "Lag en plan for PRD-kjeden i v2" } as PaiEvent);
		const svar = await dispatch({ ...base, type: "context.build" } as PaiEvent);
		expect(svar.additionalContext).toHaveLength(2);
		expect(svar.additionalContext?.[1]).toContain("PAI work session directory");
	});
});
