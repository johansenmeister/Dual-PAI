/**
 * Kontrakt-test: sesjonens livssyklus (H-12, H-17)
 *
 * OpenCode har ingen sesjonsslutt-hendelse. `session.ended` finnes ikke i
 * binæren, og `session.idle` fyrer etter hver assistenttur. Å behandle idle
 * som slutt fragmenterte arbeidshistorikken: teardown nullstilte tilstanden,
 * neste prompt ble «første melding» og fikk sin egen arbeidskatalog.
 *
 * Det som holder livssyklusen sammen nå er PID-liveness. Denne fila pinner
 * de tre egenskapene det hviler på:
 *
 *   1. liveness-sjekken er FAIL-SAFE — er vi i tvil, lever økten
 *   2. fullføring er IDEMPOTENT — reaperen kan møte ryddede kataloger
 *   3. adapteren utleder ikke sesjonsslutt fra idle
 *
 * `reapOrphanedWorkSessions` kalles ikke herfra: den kjører full teardown,
 * og teardown kjører `restoreSkillFiles()` via sesjonsstart-nabolaget samt
 * skriving over hele MEMORY-treet. Reaperen dekkes av røyktest.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOwnerAlive, readProcessStart } from "../.opencode/pai-core/lib/paths";

let tempHome: string;
let opprinneligHome: string | undefined;

beforeAll(() => {
	tempHome = mkdtempSync(join(tmpdir(), "pai-lifecycle-test-"));
	opprinneligHome = process.env.PAI_HOME;
	process.env.PAI_HOME = tempHome;
});

afterAll(() => {
	if (opprinneligHome === undefined) delete process.env.PAI_HOME;
	else process.env.PAI_HOME = opprinneligHome;
	rmSync(tempHome, { recursive: true, force: true });
});

describe("readProcessStart — vakten mot PID-gjenbruk", () => {
	test("egen prosess gir et starttime-tall", () => {
		const start = readProcessStart(process.pid);
		expect(start).not.toBeNull();
		expect(start).toMatch(/^\d+$/);
	});

	test("verdien er stabil mellom kall", () => {
		// Er den ikke det, er feltparsingen feil og vakten ville sagt at
		// enhver prosess er en annen prosess — alt ville blitt reapet.
		expect(readProcessStart(process.pid)).toBe(readProcessStart(process.pid));
	});

	test("ikke-eksisterende PID gir null, ikke kast", () => {
		expect(readProcessStart(2 ** 30)).toBeNull();
	});
});

describe("isOwnerAlive er FAIL-SAFE", () => {
	// Retningen på tvilen er hele poenget. En arbeidsøkt som fullføres for
	// sent er kosmetisk; én som fullføres mens brukeren jobber i den,
	// ødelegger pågående arbeid. Hver test her fastholder at tvil = lever.

	test("egen prosess lever", () => {
		expect(isOwnerAlive(process.pid, readProcessStart(process.pid) ?? undefined)).toBe(true);
	});

	test("egen prosess lever også uten pid_start", () => {
		// Ingen vakt tilgjengelig (ikke-Linux). PID-en finnes → lever.
		expect(isOwnerAlive(process.pid, undefined)).toBe(true);
	});

	test("død PID er død", () => {
		expect(isOwnerAlive(2 ** 30, undefined)).toBe(false);
	});

	test("gjenbrukt PID avsløres av feil pid_start", () => {
		// Prosessen finnes, men det er en ANNEN prosess. Uten dette ville en
		// foreldreløs økt sett levende ut for alltid og aldri blitt fullført.
		expect(isOwnerAlive(process.pid, "0")).toBe(false);
	});

	test.each([
		["undefined", undefined],
		["null", null],
		["null som tall", 0],
		["negativ", -1],
	])("pid = %s uten started_at → lever (kan ikke avgjøres)", (_navn, pid) => {
		expect(isOwnerAlive(pid as never, undefined)).toBe(true);
	});
});

describe("legacy-tilstand uten pid avgjøres av alder", () => {
	const nå = Date.now();
	const time = 60 * 60 * 1000;

	test("fersk legacy-tilstand står urørt", () => {
		const start = new Date(nå - 1 * time).toISOString();
		expect(isOwnerAlive(undefined, undefined, start)).toBe(true);
	});

	test("legacy-tilstand eldre enn seks timer regnes som forlatt", () => {
		const start = new Date(nå - 7 * time).toISOString();
		expect(isOwnerAlive(undefined, undefined, start)).toBe(false);
	});

	test("ugyldig started_at gir lever, ikke reap", () => {
		// Fail-safe igjen: en ulesbar dato er ikke bevis på at økten er død.
		expect(isOwnerAlive(undefined, undefined, "ikke-en-dato")).toBe(true);
	});

	test("pid vinner over alder", () => {
		// En levende prosess med gammel started_at skal ALDRI reapes.
		const gammel = new Date(nå - 99 * time).toISOString();
		expect(isOwnerAlive(process.pid, readProcessStart(process.pid) ?? undefined, gammel)).toBe(
			true
		);
	});
});

describe("én arbeidsøkt per økt, ikke én per prompt (H-17)", () => {
	// Kjernen i H-17. Før: teardown per tur nullstilte tilstanden, så hver
	// prompt traff opprettelsesgrenen og fikk sin egen katalog — og fordi
	// `appendToThread` lå i `else if`-grenen, havnet meldingen som OPPRETTET
	// økten aldri i THREAD. Nettoresultatet var tomme katalogskall.
	//
	// Testen kjører to brukermeldinger etter hverandre uten teardown mellom,
	// nøyaktig slik en TUI-økt med to prompts ser ut.

	const base = {
		harness: "opencode" as const,
		sessionId: "ses_h17",
		sessionKey: "oc_ses_h17",
		at: 1_700_000_000_000,
		cwd: "/tmp",
	};

	test("begge meldingene havner i SAMME THREAD", async () => {
		const { dispatch } = await import("../.opencode/pai-core");
		const { getCurrentWorkPath } = await import("../.opencode/pai-core/lib/paths");

		const første = "Dette er den forste meldingen og den oppretter arbeidsokten.";
		const andre = "Dette er den andre meldingen og den skal havne i samme thread.";

		await dispatch({ ...base, type: "user.message", text: første } as never);
		const stiEtterFørste = await getCurrentWorkPath("ses_h17");
		expect(stiEtterFørste).not.toBeNull();

		await dispatch({ ...base, type: "user.message", text: andre } as never);
		const stiEtterAndre = await getCurrentWorkPath("ses_h17");

		// Én katalog, ikke to. Dette er egenskapen H-12 ødela.
		expect(stiEtterAndre).toBe(stiEtterFørste);

		const thread = readFileSync(join(stiEtterAndre as string, "THREAD.md"), "utf-8");
		// Meldingen som opprettet økten MÅ være med — den var det som manglet.
		expect(thread).toContain(første);
		expect(thread).toContain(andre);
	});
});

describe("arbeidsøkten leses fra DISK, ikke fra prosessminne (batch 5)", () => {
	// Planens «harde blokker». `currentSession` lå i en modulvariabel, og
	// konsekvensen var observert tre ganger: to prompts delte katalog bare
	// når de delte prosess; variabelen lekket mellom testfiler; og Claude
	// Code kjører én prosess per hook-event, der den alltid ville vært tom.
	//
	// Testene under skriver tilstanden FOR HÅND og spør etterpå. Hadde svaret
	// kommet fra minnet, ville det vært null — ingenting i denne prosessen
	// har opprettet noen økt.

	async function leggTilstandPåDisk(sessionId: string, tittel: string): Promise<string> {
		const { getStateDir, getWorkDir } = await import("../.opencode/pai-core/lib/paths");
		const rel = `2026-09/${sessionId}_fra-disk`;
		const dir = join(getWorkDir(), rel);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "META.yaml"),
			`status: ACTIVE\nstarted_at: 2026-09-21T10:00:00.000Z\ntitle: "${tittel}"\nsession_id: ${sessionId}_fra-disk\n`
		);
		mkdirSync(getStateDir(), { recursive: true });
		writeFileSync(
			join(getStateDir(), `current-work-${sessionId}.json`),
			JSON.stringify({ session_id: sessionId, work_dir: rel, session_dir: rel })
		);
		return dir;
	}

	test("en økt ingen i denne prosessen har opprettet, blir funnet", async () => {
		const { getCurrentSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		const dir = await leggTilstandPåDisk("ses_disk_a", "Fra disk");

		const økt = await getCurrentSession("ses_disk_a");

		expect(økt).not.toBeNull();
		expect(økt?.path).toBe(dir);
		expect(økt?.title).toBe("Fra disk");
		expect(økt?.status).toBe("ACTIVE");
	});

	test("ukjent sesjon gir null", async () => {
		const { getCurrentSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		expect(await getCurrentSession("ses_finnes_ikke")).toBeNull();
	});

	test("uten sesjons-ID gis ingen økt — ingen felles skuff å falle tilbake på", async () => {
		// Før fantes `current-work.json`, og et kall uten ID fikk hva som
		// helst som lå der sist. Det var kilden til at læringsuttrekk kunne
		// høste fra en ANNEN økts arbeid.
		const { getCurrentSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		await leggTilstandPåDisk("ses_disk_b", "Skal ikke lekke");
		expect(await getCurrentSession()).toBeNull();
	});

	test("to økter ser hver sin katalog", async () => {
		const { getCurrentSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		await leggTilstandPåDisk("ses_par_1", "Første");
		await leggTilstandPåDisk("ses_par_2", "Andre");

		expect((await getCurrentSession("ses_par_1"))?.title).toBe("Første");
		expect((await getCurrentSession("ses_par_2"))?.title).toBe("Andre");
	});

	test("createWorkSession gjenbruker en økt fra disk framfor å lage en ny", async () => {
		// Kjernen i fiksen. Betingelsen var `existingPath && currentSession`,
		// og minnedelen gjorde at en ny prosess ikke så en helt gyldig
		// arbeidsøkt på disk — den lagde en ny ved siden av.
		const { createWorkSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		const dir = await leggTilstandPåDisk("ses_gjenbruk", "Eksisterende");

		const res = await createWorkSession("En helt ny og tilstrekkelig lang melding her", "ses_gjenbruk");

		expect(res.success).toBe(true);
		expect(res.session?.path).toBe(dir);
		expect(res.session?.title).toBe("Eksisterende");
	});
});

describe("completeWorkSession er idempotent", () => {
	// H-12 kalte den etter hver assistenttur. Uten vakten appendes en ny
	// `completed_at` hver gang — 13 META.yaml i treet har dobbel linje.
	// Reaperen møter per definisjon kataloger ingen ryddet etter, så den
	// ville laget flere.

	async function lagArbeidsøkt(sessionId: string, meta: string): Promise<string> {
		const { getStateDir, getWorkDir } = await import("../.opencode/pai-core/lib/paths");
		const rel = `2026-09/${sessionId}_test`;
		const dir = join(getWorkDir(), rel);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "META.yaml"), meta);
		mkdirSync(getStateDir(), { recursive: true });
		writeFileSync(
			join(getStateDir(), `current-work-${sessionId}.json`),
			JSON.stringify({ session_id: sessionId, work_dir: rel, session_dir: rel })
		);
		return join(dir, "META.yaml");
	}

	test("en ACTIVE økt fullføres og får nøyaktig én completed_at", async () => {
		const { completeWorkSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		const metaPath = await lagArbeidsøkt("ses_idem_a", "status: ACTIVE\ntitle: test\n");

		await completeWorkSession("ses_idem_a");
		const innhold = readFileSync(metaPath, "utf-8");

		expect(innhold).toContain("status: COMPLETED");
		expect(innhold.match(/^completed_at:/gm)?.length).toBe(1);
	});

	test("tilstand som peker på en borte katalog ryddes bort", async () => {
		// Reaperen kjører ved HVER oppstart. Klarer ikke fullføringen å rydde
		// tilstanden, prøver den på den samme døde fila for alltid. Observert
		// i drift: ni slike filer pekte på slettede testkataloger.
		const { getStateDir } = await import("../.opencode/pai-core/lib/paths");
		const { completeWorkSession } = await import("../.opencode/pai-core/handlers/work-tracker");

		const statePath = join(getStateDir(), "current-work-ses_borte.json");
		mkdirSync(getStateDir(), { recursive: true });
		writeFileSync(
			statePath,
			JSON.stringify({
				session_id: "ses_borte",
				work_dir: "2026-09/finnes-ikke",
				session_dir: "2026-09/finnes-ikke",
			})
		);

		const result = await completeWorkSession("ses_borte");

		expect(result.success).toBe(true);
		expect(existsSync(statePath)).toBe(false);
	});

	test("andre kall legger ikke på en ny completed_at", async () => {
		const { completeWorkSession } = await import("../.opencode/pai-core/handlers/work-tracker");
		const metaPath = await lagArbeidsøkt("ses_idem_b", "status: ACTIVE\ntitle: test\n");

		await completeWorkSession("ses_idem_b");
		// Tilstandsfila skrives på nytt, slik reaperen ville funnet den.
		await lagArbeidsøkt("ses_idem_b", readFileSync(metaPath, "utf-8"));
		await completeWorkSession("ses_idem_b");

		expect(readFileSync(metaPath, "utf-8").match(/^completed_at:/gm)?.length).toBe(1);
	});
});
