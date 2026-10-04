/**
 * v2-adapteren, fase 4: sesjonens livssyklus
 *
 * v2 har ingen start-hendelse for hovedøkten og ingen slutt-hendelse i det
 * hele tatt (MÅLT, fase 0). Det som holder livssyklusen sammen, er tre ting,
 * og denne fila pinner alle tre:
 *
 *   1. første `session.prompt` per hovedøkt er `session.start`,
 *   2. pluginens cleanup er `session.end` for øktene prosessen har sett,
 *   3. reaperen ved plugin-last tar det cleanup ikke rakk — og ALDRI en
 *      levende økt.
 *
 * Reaperen og teardown kjøres ekte, mot en temp-`PAI_HOME`, som i
 * `tests/reaper-sessionkey.test.ts`. Beviset mot den ekte binæren, med
 * SIGINT og SIGKILL, er `Tools/V2Smoke.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionKeyFor } from "../.opencode/pai-core";
import { getCurrentWorkPath, getStateDir, getWorkDir, readProcessStart } from "../.opencode/pai-core/lib/paths";
import adapter from "../.opencode/pai-adapters/opencode-v2";
import { SUBAGENT_PREFIKS } from "../.opencode/pai-adapters/opencode-v2/buss";
import { Livssyklus } from "../.opencode/pai-adapters/opencode-v2/livssyklus";

type Tilbakekall = (e: unknown) => Promise<void> | void;

let temp: string;
let logg: string;
const lagret: Record<string, string | undefined> = {};
const ekteFetch = globalThis.fetch;
/**
 * Cleanup fra hver `setup`, awaitet før `PAI_HOME` settes tilbake. Et
 * `session.start` som fortsatt kjørte da fila var ferdig, ville ellers skrevet
 * i det EKTE MEMORY-treet (observert i `opencode-v2-meldinger.test.ts`).
 */
const cleanups: (() => Promise<void>)[] = [];

/** En PID som garantert ikke lever lenger: et barn som har avsluttet. */
let dødPid: number;

beforeAll(() => {
	temp = mkdtempSync(join(tmpdir(), "pai-v2-livssyklus-"));
	logg = join(temp, "v2.log");
	for (const k of ["PAI_HOME", "PAI_HARNESS", "PAI_LOG_PATH", "PAI_OWNER_PID", "PAI_OWNER_PID_START"]) {
		lagret[k] = process.env[k];
	}
	process.env.PAI_HOME = temp;
	process.env.PAI_LOG_PATH = logg;
	dødPid = Bun.spawnSync(["true"]).pid;
	// `session.start` gjør en versjonssjekk mot GitHub. En test skal ikke
	// snakke med nettet, og den svarer uansett «ingen oppdatering» på en feil.
	globalThis.fetch = (async () => {
		throw new Error("ingen nett i test");
	}) as unknown as typeof fetch;
});

afterEach(() => {
	// `setup` setter PAI_HARNESS og fjerner PAI_OWNER_PID for hele prosessen,
	// og bun kjører alle testfilene i samme prosess.
	for (const k of ["PAI_HARNESS", "PAI_OWNER_PID", "PAI_OWNER_PID_START"]) {
		if (lagret[k] === undefined) delete process.env[k];
		else process.env[k] = lagret[k];
	}
});

afterAll(async () => {
	for (const c of cleanups.splice(0)) await c();
	globalThis.fetch = ekteFetch;
	for (const [k, v] of Object.entries(lagret)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(temp, { recursive: true, force: true });
});

/** Et løfte testen løser selv, for å styre rekkefølgen. */
function utsatt<T = void>() {
	let løs!: (v: T) => void;
	const løfte = new Promise<T>((r) => {
		løs = r;
	});
	return { løfte, løs };
}

const litt = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("Livssyklus", () => {
	function lag(rydding: Promise<unknown> = Promise.resolve(), start = async (_id: string) => {}) {
		const logg: string[] = [];
		const l = new Livssyklus({
			rydding,
			start: async (id) => {
				logg.push(`start:${id}`);
				await start(id);
			},
			slutt: async (id) => {
				logg.push(`slutt:${id}`);
			},
			fristMs: 200,
			nedstengingVentMs: 50,
		});
		return { l, logg };
	}

	test("første prompt starter økten, de neste gjør det ikke", async () => {
		const { l, logg } = lag();
		await l.prompt("ses_a");
		await l.prompt("ses_a");
		await l.prompt("ses_b");
		expect(logg).toEqual(["start:ses_a", "start:ses_b"]);
	});

	test("to samtidige prompts i samme økt gir én start", async () => {
		const { l, logg } = lag();
		await Promise.all([l.prompt("ses_a"), l.prompt("ses_a")]);
		expect(logg).toEqual(["start:ses_a"]);
	});

	test("en prompt uten sesjons-ID starter ingenting", async () => {
		const { l, logg } = lag();
		await l.prompt("");
		await l.slutt();
		expect(logg).toEqual([]);
	});

	test("prompten venter på reaperen", async () => {
		// Rekkefølgen brukermeldingen trenger: en gjenopptatt økt med død eier
		// skal være fullført av reaperen før `user.message` skriver i den.
		const rydding = utsatt();
		const { l, logg } = lag(rydding.løfte);
		let ferdig = false;
		const p = l.prompt("ses_a").then(() => {
			ferdig = true;
		});
		await litt(20);
		expect(ferdig).toBe(false);
		expect(logg).toEqual([]);
		rydding.løs();
		await p;
		expect(ferdig).toBe(true);
	});

	test("prompten venter IKKE på session.start", async () => {
		// Versjonssjekken i `session.start` har fem sekunders tidsavbrudd, og
		// den skal ikke ligge foran brukerens første modellkall.
		const start = utsatt();
		const { l } = lag(Promise.resolve(), () => start.løfte);
		const svar = await Promise.race([l.prompt("ses_a").then(() => "prompt"), litt(100).then(() => "heng")]);
		expect(svar).toBe("prompt");
		start.løs();
	});

	test("slutt sender session.end for hver startet økt, etter startene", async () => {
		const start = utsatt();
		const { l, logg } = lag(Promise.resolve(), () => start.løfte);
		await l.prompt("ses_a");
		await l.prompt("ses_b");
		l.nedstenging();
		const s = l.slutt();
		await litt(20);
		// Ingen slutt før starten er ferdig: startens rydding og teardown
		// skal ikke gå i hverandre.
		expect(logg).toEqual(["start:ses_a", "start:ses_b"]);
		start.løs();
		await s;
		expect(logg).toEqual(["start:ses_a", "start:ses_b", "slutt:ses_a", "slutt:ses_b"]);
	});

	test("slutt venter på reaperen, også uten økter", async () => {
		// En server som stenger midt i reaperens teardown, etterlater en
		// halvveis fullført økt.
		const rydding = utsatt();
		const { l } = lag(rydding.løfte);
		let ferdig = false;
		const s = l.slutt().then(() => {
			ferdig = true;
		});
		await litt(20);
		expect(ferdig).toBe(false);
		rydding.løs();
		await s;
		expect(ferdig).toBe(true);
	});

	test("slutt to ganger avslutter ikke to ganger", async () => {
		const { l, logg } = lag();
		await l.prompt("ses_a");
		l.nedstenging();
		await Promise.all([l.slutt(), l.slutt()]);
		await l.slutt();
		expect(logg.filter((x) => x.startsWith("slutt:"))).toEqual(["slutt:ses_a"]);
	});

	test("en teardown som henger, holder ikke nedstengingen", async () => {
		// v2 awaiter cleanup. En slutt som aldri blir ferdig, ville hengt CLI-en.
		const l = new Livssyklus({
			rydding: Promise.resolve(),
			start: async () => {},
			slutt: () => new Promise(() => {}),
			fristMs: 50,
		});
		await l.prompt("ses_a");
		l.nedstenging();
		const svar = await Promise.race([l.slutt().then(() => "ferdig"), litt(1000).then(() => "heng")]);
		expect(svar).toBe("ferdig");
	});

	test("en start som feiler, stopper ikke slutten", async () => {
		let sluttet = false;
		const l = new Livssyklus({
			rydding: Promise.resolve(),
			start: async () => {
				throw new Error("PAI-feil");
			},
			slutt: async () => {
				sluttet = true;
			},
		});
		await l.prompt("ses_a");
		l.nedstenging();
		await l.slutt();
		expect(sluttet).toBe(true);
	});

	test("cleanup uten nedstenging er en omlasting: ingen session.end", async () => {
		// v2 kaller cleanup også når pluginen lastes på nytt, midt i økten, og da
		// uten `location.shutdown` (MÅLT). Teardown der ville fullført en
		// levende økt.
		const { l, logg } = lag();
		await l.prompt("ses_a");
		await l.slutt();
		expect(logg).toEqual(["start:ses_a"]);
	});

	test("nedstenging meldt kort ETTER at cleanup begynte, gir teardown", async () => {
		// Bussen leveres asynkront. Cleanup venter litt på signalet før den
		// konkluderer med omlasting.
		const { l, logg } = lag();
		await l.prompt("ses_a");
		const s = l.slutt();
		await litt(10);
		l.nedstenging();
		await s;
		expect(logg).toEqual(["start:ses_a", "slutt:ses_a"]);
	});
});

// ─── Hele kjeden, gjennom adapteren ───────────────────────────────────────

/**
 * En buss testen kan mate. Hvert `subscribe` får sin egen strøm med alle
 * hendelsene, som hos motoren: adapteren abonnerer to ganger.
 */
function lagBuss() {
	const abonnenter: { kø: unknown[]; vekk?: () => void }[] = [];
	async function* strøm(a: { kø: unknown[]; vekk?: () => void }) {
		while (true) {
			while (a.kø.length > 0) yield a.kø.shift();
			await new Promise<void>((r) => {
				a.vekk = r;
			});
		}
	}
	return {
		abonner() {
			const a: { kø: unknown[]; vekk?: () => void } = { kø: [] };
			abonnenter.push(a);
			return strøm(a);
		},
		send(...hendelser: unknown[]) {
			for (const a of abonnenter) {
				a.kø.push(...hendelser);
				a.vekk?.();
			}
		},
	};
}

const NEDSTENGING = { type: "location.shutdown", data: {} };

async function oppsett() {
	const registrert = new Map<string, Tilbakekall>();
	const buss = lagBuss();
	const domene = (navn: string) => ({
		hook: async (hook: string, cb: Tilbakekall) => {
			registrert.set(`${navn}.${hook}`, cb);
			return { dispose: async () => {} };
		},
	});
	const ctx = {
		location: { directory: "/prosjekt" },
		tool: domene("tool"),
		session: domene("session"),
		shell: domene("shell"),
		permission: domene("permission"),
		event: { subscribe: () => buss.abonner() },
	};
	// biome-ignore lint/suspicious/noExplicitAny: falsk kontekst med bare domenene adapteren bruker
	const cleanup = (await adapter.setup(ctx as any)) as () => Promise<void>;
	cleanups.push(cleanup);
	const prompt = (sessionID: string, text: string) =>
		(registrert.get("session.prompt") as Tilbakekall)({
			sessionID,
			messageID: "msg_1",
			delivery: "immediate",
			metadata: {},
			prompt: { text, files: [] },
		});
	/** Ekte nedstenging: `location.shutdown` på bussen, så cleanup. */
	const stengNed = async () => {
		buss.send(NEDSTENGING);
		await cleanup();
	};
	return { prompt, cleanup, stengNed, buss };
}

const MELDING = "Sett opp en ny tjeneste for backup av databasen i kveld";

function meta(dir: string): string {
	return readFileSync(join(dir, "META.yaml"), "utf-8");
}

/** Skriv en arbeidsøkt på disk med valgfri eier, slik en tidligere prosess ville etterlatt den. */
function arbeidsøktPåDisk(sessionId: string, eier: { pid: number; pid_start?: string }): string {
	const rel = `2026-09/${sessionId}_fra-disk`;
	const dir = join(getWorkDir(), rel);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "META.yaml"), `status: ACTIVE\nstarted_at: 2026-09-25T10:00:00.000Z\ntitle: "fra disk"\n`);
	writeFileSync(join(dir, "THREAD.md"), "# THREAD\n");
	mkdirSync(getStateDir(), { recursive: true });
	writeFileSync(
		join(getStateDir(), `current-work-${sessionId}.json`),
		JSON.stringify({
			session_id: sessionId,
			work_dir: rel,
			session_dir: rel,
			current_task: "main",
			started_at: new Date().toISOString(),
			pid: eier.pid,
			pid_start: eier.pid_start,
			session_key: sessionKeyFor("opencode2", sessionId),
		})
	);
	return dir;
}

describe("session.start fra første prompt, session.end fra cleanup", () => {
	test("en økt fra første prompt fullføres av cleanup", async () => {
		const { prompt, stengNed } = await oppsett();
		await prompt("ses_v2liv_a", MELDING);
		const dir = await getCurrentWorkPath("ses_v2liv_a");
		expect(dir).not.toBeNull();
		expect(meta(dir as string)).toContain("status: ACTIVE");

		await stengNed();

		expect(meta(dir as string)).toContain("status: COMPLETED");
		expect(existsSync(join(getStateDir(), "current-work-ses_v2liv_a.json"))).toBe(false);
		expect(readFileSync(logg, "utf-8")).toContain("session.start for ses_v2liv_a");
	});

	test("en barneøkts prompt starter ingen økt", async () => {
		// Subagentens barneøkt er ikke brukerens. Startet den, ville cleanup
		// kjørt en teardown for den også.
		const { prompt, stengNed } = await oppsett();
		await prompt("ses_v2liv_barn", `${SUBAGENT_PREFIKS}\n\nFinn filene som importerer X og list dem opp.`);
		await stengNed();
		const tekst = readFileSync(logg, "utf-8");
		expect(tekst).not.toContain("session.start for ses_v2liv_barn");
		expect(tekst).not.toContain("Session Ending");
	});

	test("turslutt og sletting på bussen er ikke teardown (H-17)", async () => {
		// `session.execution.succeeded` kommer etter hver tur, og
		// `session.deleted` er sletting fra historikken (MÅLT, M4). Behandlet
		// som slutt, ville neste prompt fått en ny arbeidskatalog — H-17 på nytt.
		const { prompt, stengNed, buss } = await oppsett();
		await prompt("ses_v2liv_tur", MELDING);
		const dir = (await getCurrentWorkPath("ses_v2liv_tur")) as string;
		buss.send(
			{ type: "session.execution.succeeded", data: { sessionID: "ses_v2liv_tur" } },
			{ type: "session.execution.interrupted", data: { sessionID: "ses_v2liv_tur", reason: "user" } },
			{ type: "session.deleted", data: { sessionID: "ses_v2liv_tur" } },
			{ type: "session.idle", data: { sessionID: "ses_v2liv_tur" } }
		);
		await litt();
		expect(meta(dir)).toContain("status: ACTIVE");
		expect(await getCurrentWorkPath("ses_v2liv_tur")).toBe(dir);

		// Kontrollen: sjekken over er levende, nedstengingen fullfører den.
		await stengNed();
		expect(meta(dir)).toContain("status: COMPLETED");
	});
});

describe("omlasting er ikke nedstenging", () => {
	test("cleanup uten location.shutdown lar økten leve, og neste instans fortsetter i SAMME katalog", async () => {
		// v2 laster pluginen på nytt når en adapterfil endres, i samme prosess
		// (MÅLT). Den gamle instansens cleanup kalles midt i økten. Med
		// teardown der ville en `git pull` fullført økten brukeren sitter i, og
		// neste prompt fått en ny arbeidskatalog — H-17.
		const gammel = await oppsett();
		await gammel.prompt("ses_v2liv_omlast", MELDING);
		const dir = (await getCurrentWorkPath("ses_v2liv_omlast")) as string;
		await gammel.cleanup();
		expect(meta(dir)).toContain("status: ACTIVE");
		expect(readFileSync(logg, "utf-8")).toContain("omlasting, ikke nedstenging");

		const ny = await oppsett();
		const andre = "Og legg til varsling på e-post når backupen feiler i natt";
		await ny.prompt("ses_v2liv_omlast", andre);
		expect(await getCurrentWorkPath("ses_v2liv_omlast")).toBe(dir);
		const thread = readFileSync(join(dir, "THREAD.md"), "utf-8");
		expect(thread).toContain(MELDING);
		expect(thread).toContain(andre);

		// Den nye instansen har sett økten, og fullfører den ved nedstenging.
		await ny.stengNed();
		expect(meta(dir)).toContain("status: COMPLETED");
	});
});

describe("eieren er serverprosessen (B5)", () => {
	test("en arvet PAI_OWNER_PID fjernes, og tilstanden får process.pid", async () => {
		// Med en arvet verdi ville reaperen sjekket liveness på en helt annen
		// prosess — og reapet en levende økt når den døde.
		process.env.PAI_OWNER_PID = String(dødPid);
		process.env.PAI_OWNER_PID_START = "0";
		const { prompt } = await oppsett();
		expect(process.env.PAI_OWNER_PID).toBeUndefined();
		expect(process.env.PAI_OWNER_PID_START).toBeUndefined();

		await prompt("ses_v2liv_eier", MELDING);
		const state = JSON.parse(readFileSync(join(getStateDir(), "current-work-ses_v2liv_eier.json"), "utf-8"));
		expect(state.pid).toBe(process.pid);
		expect(state.session_key).toBe("o2_ses_v2liv_eier");
	});
});

describe("reaperen ved plugin-last", () => {
	test("en død eiers økt fullføres, en levende står urørt", async () => {
		// Begge retninger i samme kjøring. Den levende er den dyreste feilen
		// reaperen kan gjøre: den ødelegger arbeid brukeren sitter i.
		const død = arbeidsøktPåDisk("ses_v2liv_død", { pid: dødPid, pid_start: "0" });
		const levende = arbeidsøktPåDisk("ses_v2liv_lever", {
			pid: process.pid,
			pid_start: readProcessStart(process.pid) ?? undefined,
		});

		const { prompt } = await oppsett();
		// Første prompt venter på reaperen, så etter den er ryddingen ferdig.
		await prompt("ses_v2liv_annen", MELDING);

		expect(meta(død)).toContain("status: COMPLETED");
		expect(existsSync(join(getStateDir(), "current-work-ses_v2liv_død.json"))).toBe(false);
		expect(meta(levende)).toContain("status: ACTIVE");
		expect(existsSync(join(getStateDir(), "current-work-ses_v2liv_lever.json"))).toBe(true);
	});

	test("en gjenopptatt økt med død eier fullføres FØR meldingen skrives", async () => {
		// Serveren ble drept midt i økten, og brukeren gjenopptar den med
		// `run --session`. Den gamle tilstandsfila har samme ID. Uten at
		// prompten venter på reaperen, ville meldingen havnet i den gamle
		// katalogen mens reaperen fullførte den.
		const gammel = arbeidsøktPåDisk("ses_v2liv_resume", { pid: dødPid, pid_start: "0" });
		const { prompt } = await oppsett();
		await prompt("ses_v2liv_resume", MELDING);

		expect(meta(gammel)).toContain("status: COMPLETED");
		expect(readFileSync(join(gammel, "THREAD.md"), "utf-8")).not.toContain(MELDING);
		const ny = await getCurrentWorkPath("ses_v2liv_resume");
		expect(ny).not.toBe(gammel);
		expect(readFileSync(join(ny as string, "THREAD.md"), "utf-8")).toContain(MELDING);
	});
});
