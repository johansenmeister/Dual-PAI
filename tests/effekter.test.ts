/**
 * K5: effektmarkørene i arbeidsøkten, og doctor-regelen som leser dem
 *
 * Markøren skrives av dispatch-laget fra notene hendelsen ga. `session.end`
 * testes ikke her (teardown er farlig å kjøre i suiten, se
 * `dispatch-events.test.ts`); den grenen dekkes av `ClaudeSmoke`.
 *
 * Isolert via PAI_HOME og PAI_LOG_PATH.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../.opencode/pai-core";
import type { PaiEvent } from "../.opencode/pai-core";
import { EFFEKTFIL, effektnoter, merkEffekter } from "../.opencode/pai-core/lib/effekter";
import { effektHelse, lesEffekter, prdFiler, REGLER, sisteØkter } from "../.opencode/PAI/Tools/effekt-helse";

let hjem: string;
const lagret: Record<string, string | undefined> = {};

beforeEach(() => {
	hjem = mkdtempSync(join(tmpdir(), "pai-effekter-"));
	for (const k of ["PAI_HOME", "PAI_LOG_PATH"]) lagret[k] = process.env[k];
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

describe("markøren i kjernen", () => {
	test("bare notene som betyr en effekt, og learnings:0 er ikke en", () => {
		expect(effektnoter(["reason:exit", "work-completed", "learnings:0", "learnings:2", "agent-capture:egen-hendelse"])).toEqual([
			"work-completed",
			"learnings:2",
		]);
	});

	test("én linje per effekt, og ingenting uten katalog eller effekt", () => {
		const dir = join(hjem, "økt");
		mkdirSync(dir);
		expect(merkEffekter(dir, "session.end", ["work-completed", "learnings:1", "reason:exit"])).toBe(2);
		expect(merkEffekter(dir, "tool.after", ["tool-failed"])).toBe(0);
		expect(merkEffekter(null, "tool.after", ["prd-tracked"])).toBe(0);
		const linjer = readFileSync(join(dir, EFFEKTFIL), "utf-8").trim().split("\n");
		expect(linjer.map((l) => JSON.parse(l).effekt)).toEqual(["work-completed", "learnings:1"]);
		expect(JSON.parse(linjer[0]).hendelse).toBe("session.end");
	});

	test("gjennom dispatch: en ny arbeidsøkt merker work-created, en PRD-skriving prd-tracked", async () => {
		const base = { harness: "claude" as const, sessionId: "k5-test", sessionKey: "cc_k5-test", at: Date.now(), cwd: hjem };
		const svar = await dispatch({ ...base, type: "user.message", text: "Sett opp en plan for effektmarkørene" } as PaiEvent);
		expect(svar.notes).toContain("work-created");

		const work = join(hjem, "MEMORY", "WORK");
		const ym = readdirSync(work)[0];
		const økt = join(work, ym, readdirSync(join(work, ym))[0]);
		const prd = join(økt, "PRD.md");
		// `id` er det prd-sync krever (prd-template.ts skriver det); formen er M-47.
		writeFileSync(prd, "---\nid: PRD-k5-test\nlast_phase: PLAN\n---\n\n- [ ] ISC-1: markøren skrives\n");
		const etter = await dispatch({
			...base,
			type: "tool.after",
			tool: "Write",
			args: { file_path: prd },
			result: "ok",
		} as PaiEvent);
		expect(etter.notes).toContain("prd-tracked");
		expect(etter.notes).toContain("prd-synced");
		expect(lesEffekter(økt)).toEqual(expect.arrayContaining(["work-created", "prd-tracked"]));
	});
});

/** En fullført økt i et falskt WORK-tre. `effekter` null = ingen markørfil. */
function økt(rot: string, navn: string, o: { status?: string; effekter?: string[] | null; isc?: string[]; prd?: string }): void {
	const dir = join(rot, "2026-09", navn);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "META.yaml"), `status: ${o.status ?? "COMPLETED"}\nstarted_at: x\n`);
	if (o.isc) writeFileSync(join(dir, "ISC.json"), JSON.stringify({ criteria: o.isc.map((status) => ({ status })) }));
	if (o.prd) writeFileSync(join(dir, o.prd), "- [x] ISC-1: noe\n");
	if (o.effekter !== null) {
		writeFileSync(
			join(dir, EFFEKTFIL),
			`${(o.effekter ?? ["work-created"]).map((effekt) => JSON.stringify({ effekt })).join("\n")}\n`
		);
	}
}

describe("doctor: K5-regelen", () => {
	test("inndata i tre økter og effekt i ingen er et funn; én effekt holder", () => {
		const rot = join(hjem, "WORK");
		for (const navn of ["2026-09-21T00_a", "2026-09-22T00_b", "2026-09-23T00_c"]) økt(rot, navn, { isc: ["completed"] });
		const h = effektHelse(rot);
		expect(h.økter).toBe(3);
		expect(h.problemer).toHaveLength(1);
		expect(h.problemer[0]).toContain("learning-capture");

		økt(rot, "2026-09-24T00_d", { isc: ["completed"], effekter: ["work-created", "learnings:1"] });
		expect(effektHelse(rot).problemer).toEqual([]);
	});

	test("under terskelen, uten markørfil, eller ikke fullført: taus", () => {
		const rot = join(hjem, "WORK");
		økt(rot, "2026-09-21T00_a", { isc: ["completed"] });
		økt(rot, "2026-09-22T00_b", { isc: ["completed"] });
		økt(rot, "2026-09-23T00_c", { isc: ["completed"], effekter: null });
		økt(rot, "2026-09-24T00_d", { isc: ["completed"], status: "ACTIVE" });
		expect(effektHelse(rot)).toEqual({ problemer: [], varsler: [], økter: 2 });
	});

	test("ISC-inndata er bredere enn handleren: DONE, verified og passed teller, pending ikke", () => {
		const isc = REGLER[0];
		const rot = join(hjem, "WORK");
		økt(rot, "2026-09-21T00_a", { isc: ["pending"] });
		økt(rot, "2026-09-22T00_b", { isc: ["PASSED"] });
		const [b, a] = sisteØkter(rot);
		expect(isc.harInndata(a.katalog)).toBe(false);
		expect(isc.harInndata(b.katalog)).toBe(true);
	});

	test("PRD-ene: PRD.md og PRD-<dato>-<slug>.md, som malen ber om, men ikke PRDFORMAT.md", () => {
		const dir = join(hjem, "prd");
		mkdirSync(dir);
		for (const f of ["PRD.md", "PRD-20260903-authentik-upgrade.md", "PRDFORMAT.md", "notat.md"]) writeFileSync(join(dir, f), "");
		expect(prdFiler(dir).sort()).toEqual(["PRD-20260903-authentik-upgrade.md", "PRD.md"]);
	});

	test("nyeste først, og bare de siste N, også over et månedsskifte", () => {
		const rot = join(hjem, "WORK");
		for (let i = 1; i <= 5; i++) økt(rot, `2026-09-0${i}T00_x`, {});
		const s = sisteØkter(rot, 2);
		expect(s.map((x) => x.katalog.split("/").pop())).toEqual(["2026-09-05T00_x", "2026-09-04T00_x"]);

		mkdirSync(join(rot, "2026-10", "2026-10-01T00_y"), { recursive: true });
		writeFileSync(join(rot, "2026-10", "2026-10-01T00_y", "META.yaml"), "status: COMPLETED\n");
		writeFileSync(join(rot, "2026-10", "2026-10-01T00_y", EFFEKTFIL), `${JSON.stringify({ effekt: "work-created" })}\n`);
		expect(sisteØkter(rot, 1).map((x) => x.katalog.split("/").pop())).toEqual(["2026-10-01T00_y"]);
	});
});
