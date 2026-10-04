/**
 * Kontrakt-test: dedupe og meldingsbuffere ligger på DISK (batch 5b)
 *
 * `dedupe-contract.test.ts` dekker H-08-semantikken — hvem som dedupes mot
 * hvem. Denne fila dekker det batch 5b faktisk endret: at svaret er det
 * samme uansett hvilken prosess som spør.
 *
 * Hvorfor det ikke er en detalj: Claude Code kjører **én prosess per
 * hook-event**. Et minnebasert dedupe-vindu ville vært tomt hver gang, så
 * dedupe hadde aldri slått til der — og meldingsbufferne
 * relationship-memory leser ville alltid vært tomme.
 *
 * Testene skriver og leser filene DIREKTE, uten å gå veien om modulens egen
 * cache. Det er slik «en annen prosess» ser ut innenfra én prosess.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendMessage,
	clearMessages,
	pruneStaleState,
	readMessages,
	wasMessageRecentlyProcessed,
} from "../.opencode/pai-core/dispatch/state";
import { getStateDir } from "../.opencode/pai-core/lib/paths";

let tempHome: string;
let opprinnelig: string | undefined;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "pai-state-disk-"));
	opprinnelig = process.env.PAI_HOME;
	process.env.PAI_HOME = tempHome;
});

afterEach(() => {
	if (opprinnelig === undefined) delete process.env.PAI_HOME;
	else process.env.PAI_HOME = opprinnelig;
	rmSync(tempHome, { recursive: true, force: true });
});

describe("dedupe-vinduet krysser prosessgrenser", () => {
	test("vinduet havner i en fil, ikke bare i minnet", async () => {
		await wasMessageRecentlyProcessed("oc_fil", "en melding som skal dedupes");
		expect(existsSync(join(getStateDir(), "dedupe-oc_fil.json"))).toBe(true);
	});

	test("et vindu skrevet av «en annen prosess» blir respektert", async () => {
		// Kjernen. Ingenting i DENNE prosessen har sett meldingen; vinduet
		// kommer utelukkende fra fila. Var dedupe minnebasert, ville svaret
		// vært false — og Claude Code hadde behandlet hver melding dobbelt.
		const tekst = "melding fra en annen prosess";
		const hash = `${tekst.length}:${tekst.substring(0, 100)}`;
		mkdirSync(getStateDir(), { recursive: true });
		writeFileSync(
			join(getStateDir(), "dedupe-oc_annen.json"),
			JSON.stringify({ [hash]: Date.now() })
		);

		expect(await wasMessageRecentlyProcessed("oc_annen", tekst)).toBe(true);
	});

	test("et utløpt vindu slipper meldingen gjennom", async () => {
		// TTL er 5 s. En melding fra i går er ikke et duplikat.
		const tekst = "gammel melding";
		const hash = `${tekst.length}:${tekst.substring(0, 100)}`;
		mkdirSync(getStateDir(), { recursive: true });
		writeFileSync(
			join(getStateDir(), "dedupe-oc_gammel.json"),
			JSON.stringify({ [hash]: Date.now() - 60_000 })
		);

		expect(await wasMessageRecentlyProcessed("oc_gammel", tekst)).toBe(false);
	});

	test("ulesbar tilstand slipper meldingen gjennom (fail-open)", async () => {
		// Retningen er valgt: å gjette på duplikat ville forkastet en EKTE
		// brukermelding. Det er den dyreste feilen systemet kan gjøre.
		mkdirSync(getStateDir(), { recursive: true });
		writeFileSync(join(getStateDir(), "dedupe-oc_ødelagt.json"), "{ dette er ikke json");
		expect(await wasMessageRecentlyProcessed("oc_ødelagt", "en melding")).toBe(false);
	});
});

describe("meldingsbufferne krysser prosessgrenser", () => {
	test("meldinger skrevet i én omgang leses i en annen", async () => {
		await appendMessage("oc_buf", "user", "hva er klokka");
		await appendMessage("oc_buf", "assistant", "den er tre");
		await appendMessage("oc_buf", "user", "takk");

		const m = await readMessages("oc_buf");
		expect(m.user).toEqual(["hva er klokka", "takk"]);
		expect(m.assistant).toEqual(["den er tre"]);
	});

	test("ukjent økt gir tomme lister, ikke kast", async () => {
		const m = await readMessages("oc_finnes_ikke");
		expect(m).toEqual({ user: [], assistant: [] });
	});

	test("to økter blander ikke meldinger", async () => {
		await appendMessage("oc_en", "user", "fra økt en");
		await appendMessage("oc_to", "user", "fra økt to");
		expect((await readMessages("oc_en")).user).toEqual(["fra økt en"]);
		expect((await readMessages("oc_to")).user).toEqual(["fra økt to"]);
	});

	test("takene håndheves ved lesing, nyeste beholdes", async () => {
		// Append-only er valgt nettopp for å unngå les-endre-skriv, så
		// trimmingen må skje her. Og det MÅ være de nyeste som overlever —
		// relationship-memory skal se slutten av samtalen, ikke starten.
		for (let i = 0; i < 60; i++) await appendMessage("oc_tak", "user", `bruker ${i}`);
		for (let i = 0; i < 30; i++) await appendMessage("oc_tak", "assistant", `svar ${i}`);

		const m = await readMessages("oc_tak");
		expect(m.user).toHaveLength(50);
		expect(m.user.at(-1)).toBe("bruker 59");
		expect(m.assistant).toHaveLength(20);
		expect(m.assistant.at(-1)).toBe("svar 29");
	});

	test("en avkortet siste linje ødelegger ikke resten", async () => {
		// Dør prosessen midt i en append, står halve linja igjen. Resten av
		// samtalen er fortsatt gyldig og skal ikke kastes.
		await appendMessage("oc_kuttet", "user", "hel melding");
		const fil = join(getStateDir(), "msgbuf-oc_kuttet.jsonl");
		writeFileSync(fil, `${readFileSync(fil, "utf-8")}{"role":"user","te`);

		expect((await readMessages("oc_kuttet")).user).toEqual(["hel melding"]);
	});

	test("clearMessages fjerner både buffer og dedupe", async () => {
		await appendMessage("oc_ryddes", "user", "noe");
		await wasMessageRecentlyProcessed("oc_ryddes", "noe");
		await clearMessages("oc_ryddes");

		expect(existsSync(join(getStateDir(), "msgbuf-oc_ryddes.jsonl"))).toBe(false);
		expect(existsSync(join(getStateDir(), "dedupe-oc_ryddes.json"))).toBe(false);
	});
});

describe("foreldede øktfiler ryddes", () => {
	test("ferske filer røres ikke", async () => {
		await appendMessage("oc_fersk", "user", "noe");
		expect(await pruneStaleState()).toBe(0);
		expect(existsSync(join(getStateDir(), "msgbuf-oc_fersk.jsonl"))).toBe(true);
	});

	test("gamle filer fjernes", async () => {
		// Dedupe og buffere er caching. Dør en prosess uten teardown, blir de
		// liggende — og uten rydding samler STATE/ dem opp i det uendelige.
		mkdirSync(getStateDir(), { recursive: true });
		const gammel = join(getStateDir(), "msgbuf-oc_gammel.jsonl");
		writeFileSync(gammel, '{"role":"user","text":"x"}\n');
		const forrige = Date.now() - 48 * 60 * 60 * 1000;
		utimesSync(gammel, forrige / 1000, forrige / 1000);

		expect(await pruneStaleState()).toBe(1);
		expect(existsSync(gammel)).toBe(false);
	});

	test("andre STATE-filer røres ALDRI", async () => {
		// Ryddingen må ikke komme nær `current-work-*` eller
		// `algorithm-state-*`. De er arbeidstilstand, ikke caching, og
		// reaperen er avhengig av at de står.
		mkdirSync(getStateDir(), { recursive: true });
		const arbeid = join(getStateDir(), "current-work-ses_x.json");
		writeFileSync(arbeid, "{}");
		const forrige = Date.now() - 48 * 60 * 60 * 1000;
		utimesSync(arbeid, forrige / 1000, forrige / 1000);

		await pruneStaleState();
		expect(existsSync(arbeid)).toBe(true);
		expect(readdirSync(getStateDir())).toContain("current-work-ses_x.json");
	});
});
