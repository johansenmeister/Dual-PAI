/**
 * Kontrakt-test: fasesporingen bygger på PRD.md (v2 fase 5)
 *
 * OpenCode v2 har ikke noe todo-verktøy (MÅLT, M2), og under Claude 5 er
 * TaskCreate/TodoWrite slått av (MÅLT 2026-09-22). Fram til nå hang fase og
 * ISC i `algorithm-tracker` på TodoWrite alene, så i begge motorene sto
 * algoritmetilstanden på `currentPhase: null` og null kriterier. `PRD.md` er
 * system of record for ISC (`SKILL.md`), og den skriver modellen selv.
 *
 * Og M-34: læringsfangsten leste bare kriterier med status `DONE`/`VERIFIED`,
 * men ISC-broen skriver `completed`. Grenen fant aldri noe.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, sessionKeyFor } from "../.opencode/pai-core";
import { iscFraPrd, readState, trackPrdState } from "../.opencode/pai-core/handlers/algorithm-tracker";
import { extractLearningsFromWork } from "../.opencode/pai-core/handlers/learning-capture";
import { setCurrentWorkPath } from "../.opencode/pai-core/lib/paths";

let temp: string;
const lagret: Record<string, string | undefined> = {};

beforeAll(() => {
	temp = mkdtempSync(join(tmpdir(), "pai-prd-fase-"));
	for (const k of ["PAI_HOME", "PAI_LOG_PATH"]) lagret[k] = process.env[k];
	process.env.PAI_HOME = temp;
	process.env.PAI_LOG_PATH = join(temp, "test.log");
});

afterAll(() => {
	for (const [k, v] of Object.entries(lagret)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(temp, { recursive: true, force: true });
});

/** En arbeidsøkt med tilstandsfil, og stien til PRD-en i den. */
async function arbeidsøkt(sessionId: string): Promise<string> {
	const rel = `2026-09/2026-09-26T00-00-00_${sessionId}`;
	const katalog = join(temp, "MEMORY", "WORK", rel);
	mkdirSync(katalog, { recursive: true });
	await setCurrentWorkPath(rel, sessionId);
	return join(katalog, "PRD.md");
}

const prd = (fase: string, kriterier: string[]) =>
	[
		"---",
		"id: PRD-20260926-test",
		"status: ACTIVE",
		"effort_level: Extended",
		`last_phase: ${fase}`,
		"---",
		"",
		"# Test",
		"",
		"## IDEAL STATE CRITERIA (Verification Criteria)",
		"",
		"### Criteria",
		...kriterier,
		"",
	].join("\n");

describe("iscFraPrd", () => {
	test("teller avkryssede og åpne ISC-linjer, med stor X", () => {
		const k = iscFraPrd(
			["- [x] ISC-C1: Ferdig kriterium", "- [ ] ISC-C2: Åpent kriterium", "- [X] ISC-A1: Stor X", "- [ ] ikke ISC"].join("\n")
		);
		expect(k.map((x) => x.status)).toEqual(["completed", "pending", "completed"]);
		expect(k[0].description).toBe("ISC-C1: Ferdig kriterium");
	});
});

describe("trackPrdState", () => {
	test("fase, effort og ISC fra PRD-en på disk", async () => {
		const sti = await arbeidsøkt("ses_prd1");
		writeFileSync(sti, prd("build", ["- [x] ISC-C1: En", "- [ ] ISC-C2: To", "- [ ] ISC-C3: Tre"]));
		const s = await trackPrdState(sti, "ses_prd1");
		expect(s).toMatchObject({
			active: true,
			currentPhase: "BUILD",
			criteriaCount: 3,
			criteriaCompleted: 1,
			effortLevel: "Extended",
		});
		expect(readState("ses_prd1")?.currentPhase).toBe("BUILD");
	});

	test("samme fase to ganger gir ÉN linje i historikken; ny fase gir en til", async () => {
		const sti = await arbeidsøkt("ses_prd2");
		writeFileSync(sti, prd("THINK", []));
		await trackPrdState(sti, "ses_prd2");
		await trackPrdState(sti, "ses_prd2");
		writeFileSync(sti, prd("PLAN", []));
		const s = await trackPrdState(sti, "ses_prd2");
		expect(s?.phaseHistory.map((h) => h.phase)).toEqual(["THINK", "PLAN"]);
	});

	test("en PRD uten kriterier nuller ikke ut det som er talt", async () => {
		const sti = await arbeidsøkt("ses_prd3");
		writeFileSync(sti, prd("BUILD", ["- [x] ISC-C1: En", "- [x] ISC-C2: To"]));
		await trackPrdState(sti, "ses_prd3");
		writeFileSync(sti, prd("VERIFY", []));
		expect(await trackPrdState(sti, "ses_prd3")).toMatchObject({ currentPhase: "VERIFY", criteriaCount: 2 });
	});

	test("en verdi som ikke er en fase, endrer ikke fasen", async () => {
		const sti = await arbeidsøkt("ses_prd4");
		writeFileSync(sti, prd("EXECUTE", []));
		await trackPrdState(sti, "ses_prd4");
		writeFileSync(sti, prd("null", []));
		expect((await trackPrdState(sti, "ses_prd4"))?.currentPhase).toBe("EXECUTE");
	});

	test("en fil som ikke er en PRD under MEMORY/WORK, spores ikke", async () => {
		const annen = join(temp, "PRD.md");
		writeFileSync(annen, prd("BUILD", ["- [x] ISC-C1: En"]));
		expect(await trackPrdState(annen, "ses_prd5")).toBeNull();
		expect(readState("ses_prd5")).toBeNull();
	});

	test("ISC-broen skriver ISC.json i arbeidsøkten", async () => {
		const sti = await arbeidsøkt("ses_prd6");
		writeFileSync(sti, prd("BUILD", ["- [x] ISC-C1: En", "- [ ] ISC-A1: Ikke dette"]));
		await trackPrdState(sti, "ses_prd6");
		const isc = JSON.parse(readFileSync(join(sti, "..", "ISC.json"), "utf-8"));
		expect(isc).toMatchObject({ total: 2, completed: 1 });
		expect(isc.anti_criteria).toHaveLength(1);
	});
});

describe("koblet i tool.after", () => {
	test("en write til PRD-en fra v2 (etter kanoniskeArgs) setter fasen", async () => {
		const sti = await arbeidsøkt("ses_prd7");
		writeFileSync(sti, prd("OBSERVE", ["- [ ] ISC-C1: En"]));
		const r = await dispatch({
			harness: "opencode2",
			sessionId: "ses_prd7",
			sessionKey: sessionKeyFor("opencode2", "ses_prd7"),
			at: Date.now(),
			cwd: temp,
			type: "tool.after",
			tool: "write",
			args: { path: sti, filePath: sti },
			result: "Created file successfully",
		});
		expect(r.notes).toContain("prd-tracked");
		expect(readState("ses_prd7")?.currentPhase).toBe("OBSERVE");
	});

	test("en read av PRD-en sporer ingenting", async () => {
		const sti = await arbeidsøkt("ses_prd8");
		writeFileSync(sti, prd("OBSERVE", []));
		const r = await dispatch({
			harness: "opencode2",
			sessionId: "ses_prd8",
			sessionKey: sessionKeyFor("opencode2", "ses_prd8"),
			at: Date.now(),
			cwd: temp,
			type: "tool.after",
			tool: "read",
			args: { filePath: sti },
			result: "",
		});
		expect(r.notes ?? []).not.toContain("prd-tracked");
	});
});

describe("M-34: læringsfangsten ser kriteriene broen skrev", () => {
	test("completed i ISC.json gir en ISC-læring", async () => {
		const sti = await arbeidsøkt("ses_m34");
		writeFileSync(sti, prd("LEARN", ["- [x] ISC-C1: Kriteriet som ble oppfylt"]));
		await trackPrdState(sti, "ses_m34");
		const r = await extractLearningsFromWork("ses_m34");
		const isc = r.learnings.find((l) => l.source === "ISC.json");
		expect(isc?.content).toContain("ISC-C1: Kriteriet som ble oppfylt");
		const lagretDir = join(temp, "MEMORY", "LEARNING");
		expect(existsSync(lagretDir) && readdirSync(lagretDir).length > 0).toBe(true);
	});
});

describe("M-35: session.compacted skriver ingen læring", () => {
	test("en arbeidsøkt med læring i THREAD gir ingenting ved kompaktering — teardown tar den", async () => {
		// Kompaktering sletter ikke arbeidsfilene, og teardown trekker ut
		// læringen fra de samme filene. Skrev denne hendelsen også, ville hver
		// læring blitt lagret to ganger (`persistLearning` har ingen dedupe).
		const sti = await arbeidsøkt("ses_m35");
		// Tom linje etter: mønsteret godtar ikke slutten av fila som avslutning (M-02).
		writeFileSync(join(sti, "..", "THREAD.md"), "**Assistant:** Learning: kompaktering skal ikke duplisere dette.\n\nNeste avsnitt.\n");
		// Kontrollen: inndataen GIR læring når den trekkes ut. Ellers beviser
		// testen ingenting (mutasjonen slapp gjennom i første versjon).
		expect((await extractLearningsFromWork("ses_m35")).learnings.length).toBeGreaterThan(0);
		// Endringstid, ikke antall: `persistLearning` har sekundoppløsning i
		// filnavnet, så en ny skriving i samme sekund OVERSKRIVER kontrollens
		// fil, og antallet står stille (mutasjonen slapp gjennom på det).
		await new Promise((r) => setTimeout(r, 10));
		const t0 = Date.now();
		const r = await dispatch({
			harness: "opencode2",
			sessionId: "ses_m35",
			sessionKey: sessionKeyFor("opencode2", "ses_m35"),
			at: Date.now(),
			cwd: temp,
			type: "session.compacted",
			trigger: "manual",
			summary: "sammendrag",
		});
		expect(r.notes).toEqual(["trigger:manual"]);
		const læring = join(temp, "MEMORY", "LEARNING");
		const nye = (readdirSync(læring, { recursive: true }) as string[])
			.map((f) => join(læring, f))
			.filter((f) => statSync(f).isFile() && statSync(f).mtimeMs >= t0);
		expect(nye).toEqual([]);
	});
});
