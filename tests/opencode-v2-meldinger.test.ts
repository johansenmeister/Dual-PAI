/**
 * v2-adapteren, fase 3: kontekst, meldinger, verktøyutfall og skallmiljø
 *
 * Payloadene har v2s MÅLTE form (fase 0 og fase 3-målingen 2026-09-25). Hele
 * kjeden kjøres: adapterens hook → `dispatch` → kjernens handler → disk under
 * en temp-`PAI_HOME`. Beviset mot den ekte binæren er `Tools/V2Smoke.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import adapter, { lyttPåBussen } from "../.opencode/pai-adapters/opencode-v2";
import {
	Bussoversetter,
	resultatTekst,
	SUBAGENT_PREFIKS,
} from "../.opencode/pai-adapters/opencode-v2/buss";

type Tilbakekall = (e: unknown) => Promise<void> | void;

let temp: string;
let logg: string;
const lagret: Record<string, string | undefined> = {};
const ekteFetch = globalThis.fetch;
/**
 * Cleanup fra hver `setup`, awaitet før `PAI_HOME` settes tilbake. Første
 * prompt sender `session.start` uten å vente på den (fase 4), og uten dette
 * ville en start som fortsatt kjørte da fila var ferdig, skrevet i det EKTE
 * MEMORY-treet. Det skjedde: en sesjonspeker fra denne fila havnet der.
 */
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => {
	temp = mkdtempSync(join(tmpdir(), "pai-v2-meldinger-"));
	logg = join(temp, "v2.log");
	for (const k of ["PAI_HOME", "PAI_HARNESS", "PAI_LOG_PATH", "PAI_ENABLED"]) lagret[k] = process.env[k];
	process.env.PAI_HOME = temp;
	process.env.PAI_LOG_PATH = logg;
	// `session.start` gjør en versjonssjekk mot GitHub. Ingen nett i test.
	globalThis.fetch = (async () => {
		throw new Error("ingen nett i test");
	}) as unknown as typeof fetch;
});

afterEach(() => {
	// `setup` setter PAI_HARNESS for hele prosessen, og bun kjører alle
	// testfilene i samme prosess.
	for (const k of ["PAI_HARNESS", "PAI_ENABLED"]) {
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

/**
 * En buss testen kan mate: `send` legger en hendelse i hver strøm adapteren
 * leser. Hvert `subscribe` får sin egen, som hos motoren — adapteren abonnerer
 * to ganger (fase 4), og én delt strøm ville fordelt hendelsene mellom dem.
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

/** Gi bussløkka og kjernens asynkrone skrivinger tid til å bli ferdige. */
const litt = (ms = 60) => new Promise((r) => setTimeout(r, ms));

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
	cleanups.push((await adapter.setup(ctx as any)) as () => Promise<void>);
	const hook = (navn: string) => registrert.get(navn) as Tilbakekall;
	return { hook, buss };
}

/** Arbeidsøktkatalogene under temp-`PAI_HOME`, som stier. */
function arbeidsøkter(): string[] {
	const rot = join(temp, "MEMORY", "WORK");
	if (!existsSync(rot)) return [];
	return readdirSync(rot)
		.map((m) => join(rot, m))
		.filter((m) => statSync(m).isDirectory())
		.flatMap((m) => readdirSync(m).map((ø) => join(m, ø)));
}

function thread(økt: string): string {
	return readFileSync(join(økt, "THREAD.md"), "utf-8");
}

const tekstSlutt = (sessionID: string, stegId: string, ordinal: number, text: string) => ({
	type: "session.text.ended",
	data: { sessionID, assistantMessageID: stegId, ordinal, text },
});
const stegSlutt = (sessionID: string, stegId: string, finish: string) => ({
	type: "session.step.ended",
	data: { sessionID, assistantMessageID: stegId, finish },
});

describe("Bussoversetter", () => {
	test("sluttsvaret er steget med finish stop, delene i ordinal-rekkefølge", () => {
		const b = new Bussoversetter();
		b.hendelse(tekstSlutt("ses_a", "msg_2", 1, "andre"));
		b.hendelse(tekstSlutt("ses_a", "msg_2", 0, "første"));
		expect(b.hendelse(stegSlutt("ses_a", "msg_2", "stop"))).toEqual({
			type: "svar",
			sessionId: "ses_a",
			tekst: "første\n\nandre",
		});
	});

	test("tekst i et steg som ender med tool-calls er mellomtekst, ikke svaret", () => {
		// MÅLT: «Jeg kjører …» kommer i steget med `finish: "tool-calls"`.
		const b = new Bussoversetter();
		b.hendelse(tekstSlutt("ses_a", "msg_1", 0, "Jeg kjører kommandoen."));
		expect(b.hendelse(stegSlutt("ses_a", "msg_1", "tool-calls"))).toBeUndefined();
		// Og teksten henger ikke igjen til neste steg.
		b.hendelse(tekstSlutt("ses_a", "msg_2", 0, "Ferdig."));
		expect(b.hendelse(stegSlutt("ses_a", "msg_2", "stop"))).toMatchObject({ tekst: "Ferdig." });
	});

	test("barneøktens svar er ikke brukerens samtale", () => {
		const b = new Bussoversetter();
		b.hendelse({ type: "session.created", data: { sessionID: "ses_barn", parentID: "ses_a" } });
		b.hendelse(tekstSlutt("ses_barn", "msg_b", 0, "svar fra subagenten"));
		expect(b.hendelse(stegSlutt("ses_barn", "msg_b", "stop"))).toBeUndefined();
	});

	test("en hovedøkt uten parentID er ikke et barn", () => {
		const b = new Bussoversetter();
		b.hendelse({ type: "session.created", data: { sessionID: "ses_a" } });
		expect(b.erBarn("ses_a")).toBe(false);
	});

	test("en subagents prompt kjennes igjen på prefikset, FØR bussen har sagt noe", () => {
		// Fase 0-rådataen: barnets `session.prompt` kom 7 ms før dets
		// `session.created`. Prefikset er den primære kilden.
		const b = new Bussoversetter();
		expect(b.erBarneprompt("ses_ny", `${SUBAGENT_PREFIKS}\nKjør echo`)).toBe(true);
		expect(b.erBarneprompt("ses_ny", "Kjør echo")).toBe(false);
	});

	test("ukjente og misformede hendelser gir ingenting og kaster ikke", () => {
		const b = new Bussoversetter();
		for (const h of [null, "x", {}, { type: "session.step.ended" }, { type: "session.text.ended", data: null }]) {
			expect(b.hendelse(h)).toBeUndefined();
		}
	});
});

describe("bussløkka", () => {
	test("én hendelse som feiler, stopper ikke de neste", async () => {
		// Ellers ville hvert svar etter en feil i én hendelse blitt borte
		// uten spor, resten av økta.
		async function* strøm() {
			yield "første";
			yield "andre";
			yield "tredje";
		}
		const sett: unknown[] = [];
		await lyttPåBussen(strøm(), async (h) => {
			if (h === "første") throw new Error("PAI-feil");
			sett.push(h);
		});
		expect(sett).toEqual(["andre", "tredje"]);
	});

	test("en strøm som kaster, avvises ikke ut av løkka", async () => {
		async function* strøm(): AsyncGenerator<unknown> {
			yield "x";
			throw new Error("strømmen brøt");
		}
		await expect(lyttPåBussen(strøm(), async () => {})).resolves.toBeUndefined();
	});
});

describe("resultatTekst", () => {
	test("teksten modellen så, fra content", () => {
		// MÅLT form for shell (fase 0).
		expect(
			resultatTekst({
				output: { exit: 0, output: "hei\n", status: "completed" },
				content: [{ type: "text", text: "hei\n" }],
			})
		).toBe("hei\n");
	});

	test("reserve: output som streng, så som JSON", () => {
		expect(resultatTekst({ output: "rå" })).toBe("rå");
		expect(resultatTekst({ output: { a: 1 } })).toBe('{"a":1}');
		expect(resultatTekst(undefined)).toBe("");
	});
});

describe("fase 3 gjennom adapteren", () => {
	test("session.context injiserer PAI-konteksten som system-del", async () => {
		const { hook } = await oppsett();
		process.env.PAI_ENABLED = "1";
		const e = { sessionID: "ses_ctx", agent: "build", system: [] as { type: string; text: string }[] };
		await hook("session.context")(e);
		expect(e.system.length).toBeGreaterThan(0);
		expect(e.system[0].type).toBe("text");
		// Den ekte konteksten er ~26 KB. Et tomt eller avkortet resultat er
		// ikke konteksten.
		expect(e.system[0].text.length).toBeGreaterThan(10_000);
	});

	test("uten PAI_ENABLED injiseres ingenting", async () => {
		const { hook } = await oppsett();
		delete process.env.PAI_ENABLED;
		const e = { sessionID: "ses_ctx2", system: [] as unknown[] };
		await hook("session.context")(e);
		expect(e.system).toEqual([]);
	});

	test("brukermelding og sluttsvar havner i samme arbeidsøkt, merket opencode2", async () => {
		const { hook, buss } = await oppsett();
		const før = new Set(arbeidsøkter());
		await hook("session.prompt")({
			sessionID: "ses_hoved",
			messageID: "msg_u",
			prompt: { text: "Dette er en brukermelding som er lang nok til en arbeidsøkt", files: [] },
			delivery: "steer",
		});
		const nye = arbeidsøkter().filter((ø) => !før.has(ø));
		expect(nye).toHaveLength(1);
		const økt = nye[0];
		expect(readFileSync(join(økt, "META.yaml"), "utf-8")).toContain("harness: opencode2");
		expect(thread(økt)).toContain("**User:** Dette er en brukermelding");

		const svar = `Her er svaret. ${"Det er langt nok til at kjernen behandler det. ".repeat(3)}`;
		buss.send(
			tekstSlutt("ses_hoved", "msg_1", 0, "Mellomtekst før et verktøykall."),
			stegSlutt("ses_hoved", "msg_1", "tool-calls"),
			tekstSlutt("ses_hoved", "msg_2", 0, svar),
			stegSlutt("ses_hoved", "msg_2", "stop")
		);
		await litt(150);
		const t = thread(økt);
		expect(t).toContain(`**Assistant:** ${svar}`);
		expect(t).not.toContain("Mellomtekst før et verktøykall.");
	});

	test("en subagents prompt gir ingen arbeidsøkt", async () => {
		const { hook } = await oppsett();
		const før = arbeidsøkter().length;
		await hook("session.prompt")({
			sessionID: "ses_barn2",
			prompt: { text: `${SUBAGENT_PREFIKS}\nKjør skallkommandoen echo fra-subagent og rapporter` },
		});
		expect(arbeidsøkter().length).toBe(før);
	});

	test("execute.after med status error blir tool.failed med motorens melding", async () => {
		const { hook } = await oppsett();
		await hook("tool.execute.after")({
			tool: "read",
			sessionID: "ses_feil",
			id: "read_4",
			input: { path: "/finnes/ikke/fil.txt" },
			status: "error",
			error: { _tag: "Tool.Error", message: "File not found: /finnes/ikke/fil.txt" },
		});
		expect(readFileSync(logg, "utf-8")).toContain("Tool failed: read — File not found: /finnes/ikke/fil.txt");
	});

	test("execute.after med status completed blir tool.after, ikke tool.failed", async () => {
		const { hook } = await oppsett();
		await hook("tool.execute.after")({
			tool: "shell",
			sessionID: "ses_ok",
			id: "shell_1",
			input: { command: "echo hei" },
			status: "completed",
			result: { output: { exit: 0 }, content: [{ type: "text", text: "hei\n" }], metadata: {} },
		});
		const l = readFileSync(logg, "utf-8");
		expect(l).toContain("Tool after: shell");
		expect(l).not.toContain("Tool failed: shell");
	});

	test("skallet får PAI-miljøet med økten fra execute.before for samme kall", async () => {
		// `shell.create.before` har ingen sessionID (MÅLT); den fyrer rett
		// etter `execute.before` for samme skallkall.
		const { hook } = await oppsett();
		await hook("tool.execute.before")({
			tool: "shell",
			sessionID: "ses_skall",
			id: "shell_2",
			input: { command: "echo hei" },
		});
		const e = { command: "echo hei", cwd: "/prosjekt", env: {} as Record<string, string | undefined> };
		await hook("shell.create.before")(e);
		expect(e.env.PAI_SESSION_ID).toBe("ses_skall");
		expect(e.env.PAI_CONTEXT).toBe("1");
		expect(e.env.PAI_WORK_DIR).toBe("/prosjekt");
	});
});
