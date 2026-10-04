/**
 * Reaperen og sessionKey
 *
 * Reaperen finner en foreldreløs økt via FILNAVNET `current-work-<id>.json`,
 * som bærer rå sessionId. Meldingsbufferne og dedupe-tilstanden ligger under
 * `sessionKey` = motorprefiks + ID, og reaperen vet ikke hvilken motor som
 * skrev fila. Den sendte derfor `null` til teardown, og for hver økt den
 * reapet ble `msgbuf-`/`dedupe-` liggende til `pruneStaleState` tok dem etter
 * 24 t — og RELATIONSHIP-uttrekket fikk ingen meldinger.
 *
 * Nå skriver eieren `session_key` inn i tilstandsfila, og reaperen bruker
 * den — men BARE hvis den kan ha kommet fra `sessionKeyFor` med nettopp
 * denne ID-en. En gjettet eller forfalsket nøkkel ville sletta en annen økts
 * buffer, og det er verre enn å la en fil ligge i et døgn.
 *
 * Hele teardown-kjeden holder seg innenfor `PAI_HOME` (målt: hver handler
 * går via `getPaiHome()`), så reaperen kjøres ekte her, mot en temp-katalog.
 *
 * @module tests/reaper-sessionkey
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionKeyFor } from "../.opencode/pai-core";
import { reapOrphanedWorkSessions } from "../.opencode/pai-core/dispatch/session";
import { appendMessage } from "../.opencode/pai-core/dispatch/state";
import { clearAlgorithmState } from "../.opencode/pai-core/handlers/algorithm-tracker";
import { clearLastResponse } from "../.opencode/pai-core/handlers/last-response-cache";
import { setCurrentWorkPath } from "../.opencode/pai-core/lib/paths";
import { erSessionKeyFor } from "../.opencode/pai-core/runtime";

let paiHome: string;
const forrigeHome = process.env.PAI_HOME;
const forrigeHarness = process.env.PAI_HARNESS;

/** En PID som garantert ikke lever lenger: et barn som har avsluttet. */
let dødPid: number;

beforeAll(() => {
	paiHome = mkdtempSync(join(tmpdir(), "pai-reaper-"));
	process.env.PAI_HOME = paiHome;
	const barn = Bun.spawnSync(["true"]);
	dødPid = barn.pid;
});

afterAll(() => {
	if (forrigeHome === undefined) delete process.env.PAI_HOME;
	else process.env.PAI_HOME = forrigeHome;
	if (forrigeHarness === undefined) delete process.env.PAI_HARNESS;
	else process.env.PAI_HARNESS = forrigeHarness;
	rmSync(paiHome, { recursive: true, force: true });
});

beforeEach(() => {
	rmSync(join(paiHome, "MEMORY"), { recursive: true, force: true });
	mkdirSync(join(paiHome, "MEMORY", "STATE"), { recursive: true });
});

const STATE = () => join(paiHome, "MEMORY", "STATE");
const buffer = (nøkkel: string) => join(STATE(), `msgbuf-${nøkkel}.jsonl`);

/** Skriv en foreldreløs arbeidsøkt med valgfri `session_key`. */
function foreldreløs(sessionId: string, sessionKey?: string): void {
	const state: Record<string, unknown> = {
		session_id: sessionId,
		work_dir: `2026-09/${sessionId}`,
		session_dir: `2026-09/${sessionId}`,
		current_task: "main",
		started_at: new Date().toISOString(),
		pid: dødPid,
		pid_start: "0",
	};
	if (sessionKey !== undefined) state.session_key = sessionKey;
	writeFileSync(join(STATE(), `current-work-${sessionId}.json`), JSON.stringify(state));
}

describe("setCurrentWorkPath skriver nøkkelen", () => {
	test.each(["opencode2", "claude"] as const)("under %s", async (harness) => {
		process.env.PAI_HARNESS = harness;
		await setCurrentWorkPath("2026-09/x", "ses_skriv");
		const state = JSON.parse(readFileSync(join(STATE(), "current-work-ses_skriv.json"), "utf-8"));
		expect(state.session_key).toBe(sessionKeyFor(harness, "ses_skriv"));
	});
});

describe("reaperen rydder bufferne under nøkkelen eieren skrev", () => {
	test("egen motors buffer ryddes — den andre motorens med SAMME rå ID står", async () => {
		const id = "ses_felles";
		const egen = sessionKeyFor("opencode2", id);
		const annen = sessionKeyFor("claude", id);
		await appendMessage(egen, "user", "hei fra opencode");
		await appendMessage(annen, "user", "hei fra claude");
		foreldreløs(id, egen);

		expect(await reapOrphanedWorkSessions()).toContain(id);

		expect(existsSync(buffer(egen))).toBe(false);
		expect(existsSync(buffer(annen))).toBe(true);
	});

	test("en nøkkel som ikke hører til ID-en brukes IKKE", async () => {
		const offer = sessionKeyFor("claude", "ses_en_annen");
		await appendMessage(offer, "user", "skal overleve");
		foreldreløs("ses_forfalsket", offer);

		await reapOrphanedWorkSessions();

		expect(existsSync(buffer(offer))).toBe(true);
	});

	test("eldre tilstand uten nøkkel: bufferne står, som før", async () => {
		const nøkkel = sessionKeyFor("opencode2", "ses_gammel");
		await appendMessage(nøkkel, "user", "fra før feltet fantes");
		foreldreløs("ses_gammel");

		await reapOrphanedWorkSessions();

		expect(existsSync(buffer(nøkkel))).toBe(true);
	});
});

describe("teardown rydder øktens egne state-filer", () => {
	// Målt 2026-09-24: `pai` hadde 10 `algorithm-state-*` fra avsluttede økter.
	// Ingen rydder tok dem, og `pruneStaleState` holder seg unna med vilje.
	test("algorithm-state og last-response for økten fjernes — andres og `unknown` står", async () => {
		const fil = (navn: string) => join(STATE(), navn);
		for (const navn of [
			"algorithm-state-ses_ferdig.json",
			"last-response-ses_ferdig.txt",
			"algorithm-state-ses_annen.json",
			"last-response-ses_annen.txt",
			"algorithm-state-unknown.json",
			"last-response.txt",
		]) {
			writeFileSync(fil(navn), "{}");
		}
		foreldreløs("ses_ferdig", sessionKeyFor("opencode2", "ses_ferdig"));

		await reapOrphanedWorkSessions();

		expect(existsSync(fil("algorithm-state-ses_ferdig.json"))).toBe(false);
		expect(existsSync(fil("last-response-ses_ferdig.txt"))).toBe(false);
		for (const navn of [
			"algorithm-state-ses_annen.json",
			"last-response-ses_annen.txt",
			"algorithm-state-unknown.json",
			"last-response.txt",
		]) {
			expect(existsSync(fil(navn))).toBe(true);
		}
	});
});

describe("rydderne rører aldri felles-skuffene", () => {
	// Reaperen sender aldri `unknown`, så vakten må testes direkte — en
	// mutasjon som fjernet den slapp gjennom testen over.
	test("`unknown` og tom ID sletter ingenting", async () => {
		const felles = ["algorithm-state-unknown.json", "last-response.txt"].map((n) => join(STATE(), n));
		for (const f of felles) writeFileSync(f, "{}");
		for (const id of ["unknown", ""]) {
			await clearAlgorithmState(id);
			await clearLastResponse(id);
		}
		for (const f of felles) expect(existsSync(f)).toBe(true);
	});
});

describe("erSessionKeyFor", () => {
	test("godtar begge motorenes nøkkel for ID-en", () => {
		expect(erSessionKeyFor("o2_ses_a", "ses_a")).toBe(true);
		expect(erSessionKeyFor("cc_ses_a", "ses_a")).toBe(true);
	});

	test("v1s pensjonerte `oc_`-prefiks godtas ikke lenger", () => {
		// Eldre STATE-filer har det fortsatt. Reaperen lar dem ligge, og
		// `pruneStaleState` tar dem på alder — samme retning som ved tvil ellers.
		expect(erSessionKeyFor("oc_ses_a", "ses_a")).toBe(false);
	});

	test("avviser en annen ID, feil type og felles-skuffen", () => {
		expect(erSessionKeyFor("o2_ses_b", "ses_a")).toBe(false);
		expect(erSessionKeyFor(42, "ses_a")).toBe(false);
		expect(erSessionKeyFor("o2_unknown", "")).toBe(false);
		expect(erSessionKeyFor("o2_unknown", "  ")).toBe(false);
	});
});
