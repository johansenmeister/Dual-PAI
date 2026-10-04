/**
 * v2-adapteren, fase 5: subagenter, kompaktering og PAIs egne verktøy
 *
 * Payloadene har v2s MÅLTE form: `session.created` for barnet og
 * `execute.after` på `subagent` fra målingen 2026-09-26 (M8, `Engineer` spawnet
 * med `mode: all`), `session.compaction.ended` fra fase 0. Hele kjeden kjøres:
 * adapterens hook eller buss → `dispatch` → kjernens handler → disk under en
 * temp-`PAI_HOME`. Beviset mot den ekte binæren er `Tools/V2Smoke.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import adapter from "../.opencode/pai-adapters/opencode-v2";
import { Bussoversetter, subagentFerdig } from "../.opencode/pai-adapters/opencode-v2/buss";
import { paiVerktøy, type V2Verktøy, VERKTØY_MARKØR } from "../.opencode/pai-adapters/opencode-v2/verktoy";
import { readRegistry } from "../.opencode/pai-core/handlers/session-registry";

type Tilbakekall = (e: unknown) => Promise<void> | void;

let temp: string;
let logg: string;
const lagret: Record<string, string | undefined> = {};
const ekteFetch = globalThis.fetch;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => {
	temp = mkdtempSync(join(tmpdir(), "pai-v2-fase5-"));
	logg = join(temp, "v2.log");
	for (const k of ["PAI_HOME", "PAI_HARNESS", "PAI_LOG_PATH"]) lagret[k] = process.env[k];
	process.env.PAI_HOME = temp;
	process.env.PAI_LOG_PATH = logg;
	globalThis.fetch = (async () => {
		throw new Error("ingen nett i test");
	}) as unknown as typeof fetch;
});

afterEach(() => {
	if (lagret.PAI_HARNESS === undefined) delete process.env.PAI_HARNESS;
	else process.env.PAI_HARNESS = lagret.PAI_HARNESS;
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

/** Samme buss som i meldingstestene: hvert `subscribe` får sin egen strøm. */
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

/** Vent til `pred` er sann. Bussløkka og kjernens skrivinger er asynkrone. */
async function vent(pred: () => boolean, ms = 2000): Promise<boolean> {
	const slutt = Date.now() + ms;
	while (Date.now() < slutt) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return pred();
}

async function oppsett() {
	const registrert = new Map<string, Tilbakekall>();
	const verktøy: V2Verktøy[] = [];
	const buss = lagBuss();
	const domene = (navn: string) => ({
		hook: async (hook: string, cb: Tilbakekall) => {
			registrert.set(`${navn}.${hook}`, cb);
			return { dispose: async () => {} };
		},
	});
	const ctx = {
		location: { directory: "/prosjekt" },
		tool: {
			...domene("tool"),
			transform: async (cb: (e: { add: (v: V2Verktøy) => void }) => void) => {
				cb({ add: (v) => verktøy.push(v) });
				return { dispose: async () => {} };
			},
		},
		session: domene("session"),
		shell: domene("shell"),
		permission: domene("permission"),
		event: { subscribe: () => buss.abonner() },
	};
	// biome-ignore lint/suspicious/noExplicitAny: falsk kontekst med bare domenene adapteren bruker
	cleanups.push((await adapter.setup(ctx as any)) as () => Promise<void>);
	const hook = (navn: string) => registrert.get(navn) as Tilbakekall;
	const verktøyet = (navn: string) => verktøy.find((v) => v.name === navn) as V2Verktøy;
	return { hook, buss, verktøy, verktøyet };
}

function lesLogg(): string {
	try {
		return readFileSync(logg, "utf-8");
	} catch {
		return "";
	}
}

/** `session.created` for en barneøkt, med feltene målt 2026-09-26. */
const barnOpprettet = (forelder: string, barn: string, agent = "Engineer", title = "Regn ut 17 ganger 3") => ({
	type: "session.created",
	data: { sessionID: barn, parentID: forelder, agent, title, slug: "calm-tiger" },
});

/** `execute.after` på `subagent`, med formen målt 2026-09-26. */
const subagentEtter = (forelder: string, barn: string, svar: string, agent = "Engineer") => ({
	tool: "subagent",
	sessionID: forelder,
	agent: "build",
	messageID: "msg_1",
	id: "call_sub",
	status: "completed",
	input: { agent, description: "Regn ut 17 ganger 3", prompt: "Hva er 17 ganger 3? Svar kort." },
	result: {
		output: { sessionID: barn, status: "completed", output: svar },
		content: [{ type: "text", text: `<subagent sessionID="${barn}" state="completed">\n${svar}\n</subagent>` }],
		metadata: { sessionID: barn, status: "completed" },
	},
});

describe("Bussoversetter: subagentstart og kompaktering", () => {
	test("en barneøkt blir agent.start på FORELDERENS økt, med agent og tittel", () => {
		const b = new Bussoversetter();
		expect(b.hendelse(barnOpprettet("ses_far", "ses_barn"))).toEqual({
			type: "agent.start",
			sessionId: "ses_far",
			agentId: "ses_barn",
			agentType: "Engineer",
			beskrivelse: "Regn ut 17 ganger 3",
		});
		expect(b.erBarn("ses_barn")).toBe(true);
	});

	test("en hovedøkt gir ingen agent.start", () => {
		const b = new Bussoversetter();
		expect(b.hendelse({ type: "session.created", data: { sessionID: "ses_a" } })).toBeUndefined();
	});

	test("compaction.ended blir session.compacted med utløser og sammendrag", () => {
		const b = new Bussoversetter();
		expect(
			b.hendelse({ type: "session.compaction.ended", data: { sessionID: "ses_a", reason: "manual", text: "## Objective" } })
		).toEqual({ type: "session.compacted", sessionId: "ses_a", trigger: "manual", sammendrag: "## Objective" });
	});

	test("en ukjent reason gir ingen utløser, framfor en gjettet", () => {
		const b = new Bussoversetter();
		const u = b.hendelse({ type: "session.compaction.ended", data: { sessionID: "ses_a", reason: "overflow" } });
		expect(u).toMatchObject({ type: "session.compacted", trigger: undefined });
	});

	test("en barneøkts kompaktering er ikke brukerens", () => {
		const b = new Bussoversetter();
		b.hendelse(barnOpprettet("ses_far", "ses_barn"));
		expect(b.hendelse({ type: "session.compaction.ended", data: { sessionID: "ses_barn", reason: "manual" } })).toBeUndefined();
	});
});

describe("subagentFerdig", () => {
	test("leser barneøkten og svaret alene, ikke innpakningen modellen ser", () => {
		const e = subagentEtter("ses_far", "ses_barn", "51");
		expect(subagentFerdig(e.input, e.result)).toEqual({ agentId: "ses_barn", agentType: "Engineer", output: "51" });
	});

	test("uten barneøkt i resultatet: ingenting", () => {
		expect(subagentFerdig({ agent: "Engineer" }, { output: { status: "completed" } })).toBeUndefined();
		expect(subagentFerdig({}, undefined)).toBeUndefined();
	});
});

describe("subagentene gjennom setup", () => {
	test("start fra bussen: registeret har barnet som running, med type og beskrivelse", async () => {
		const { buss } = await oppsett();
		buss.send(barnOpprettet("ses_s1", "ses_s1_barn"));
		expect(await vent(() => readRegistry("ses_s1").entries.length > 0)).toBe(true);
		expect(readRegistry("ses_s1").entries[0]).toMatchObject({
			sessionId: "ses_s1_barn",
			agentType: "Engineer",
			description: "Regn ut 17 ganger 3",
			status: "running",
		});
	});

	test("slutt fra execute.after: completed, og svaret er fanget med stien på oppføringen", async () => {
		const { hook, buss } = await oppsett();
		buss.send(barnOpprettet("ses_s2", "ses_s2_barn"));
		await vent(() => readRegistry("ses_s2").entries.length > 0);
		await hook("tool.execute.after")(subagentEtter("ses_s2", "ses_s2_barn", "FASE5-SVAR 51"));

		const oppføring = readRegistry("ses_s2").entries[0];
		expect(oppføring.status).toBe("completed");
		expect(oppføring.outputPath).toBeDefined();
		expect(readFileSync(oppføring.outputPath as string, "utf-8")).toContain("FASE5-SVAR 51");
	});

	test("slutt uten start (bussen sakket etter) gir likevel en fullført oppføring", async () => {
		const { hook } = await oppsett();
		await hook("tool.execute.after")(subagentEtter("ses_s3", "ses_s3_barn", "svar"));
		expect(readRegistry("ses_s3").entries[0]).toMatchObject({ sessionId: "ses_s3_barn", status: "completed" });
	});

	test("et subagentkall uten barneøkt gir ingen oppføring", async () => {
		const { hook } = await oppsett();
		const e = subagentEtter("ses_s4", "x", "svar");
		await hook("tool.execute.after")({ ...e, result: { output: { status: "completed" } } });
		expect(readRegistry("ses_s4").entries).toEqual([]);
		expect(lesLogg()).toContain("fullført uten barneøkt");
	});

	test("et annet verktøy gir ingen agent.stop", async () => {
		const { hook } = await oppsett();
		await hook("tool.execute.after")({ ...subagentEtter("ses_s5", "ses_s5_barn", "svar"), tool: "shell" });
		expect(readRegistry("ses_s5").entries).toEqual([]);
	});
});

describe("PAIs verktøy under v2", () => {
	test("setup legger til nøyaktig de tre, med JSON Schema som input", async () => {
		const { verktøy } = await oppsett();
		expect(verktøy.map((v) => v.name).sort()).toEqual(["code_review", "session_registry", "session_results"]);
		for (const v of verktøy) expect(v.input.type).toBe("object");
		expect(paiVerktøy().map((v) => v.name)).toEqual(verktøy.map((v) => v.name));
	});

	test("session_registry og session_results svarer fra registeret, med det FANGEDE svaret", async () => {
		const { hook, buss, verktøyet } = await oppsett();
		buss.send(barnOpprettet("ses_v1", "ses_v1_barn"));
		await vent(() => readRegistry("ses_v1").entries.length > 0);
		await hook("tool.execute.after")(subagentEtter("ses_v1", "ses_v1_barn", "KOKOSNØTT-SVAR"));

		const register = await verktøyet("session_registry").execute({}, { sessionID: "ses_v1" });
		expect(register.content).toContain("ses_v1_barn");
		expect(register.content).toContain("completed");

		const resultat = await verktøyet("session_results").execute({ session_id: "ses_v1_barn" }, { sessionID: "ses_v1" });
		expect(resultat.content).toContain("KOKOSNØTT-SVAR");
		// v2 kan ikke gjenoppta en subagent med sesjons-ID (M2). v1s
		// instruksjon ville sendt modellen etter et verktøy som ikke finnes.
		expect(resultat.content).not.toContain("Task(");
		expect(lesLogg()).toContain(`${VERKTØY_MARKØR} session_results for ses_v1`);
	});

	test("session_results for en ukjent ID sier fra, og kaster ikke", async () => {
		const { verktøyet } = await oppsett();
		const r = await verktøyet("session_results").execute({ session_id: "ses_finnes_ikke" }, { sessionID: "ses_v2" });
		expect(r.content).toContain("not found");
	});

	test("code_review svarer med tekst uansett, også med en ukjent modus", async () => {
		const { verktøyet } = await oppsett();
		const r = await verktøyet("code_review").execute({ mode: "tull", path: "x" }, { sessionID: "ses_v3" });
		expect(typeof r.content).toBe("string");
		expect(r.content.length).toBeGreaterThan(0);
	});
});

describe("kompaktering under v2", () => {
	test("compaction-hooken pusher PAIs seksjoner inn i kompakteringen", async () => {
		const { hook, buss } = await oppsett();
		buss.send(barnOpprettet("ses_k1", "ses_k1_barn"));
		await vent(() => readRegistry("ses_k1").entries.length > 0);
		const e = { sessionID: "ses_k1", system: [] as { type: string; text: string }[] };
		await hook("session.compaction")(e);
		const tekst = e.system.map((s) => s.text).join("\n");
		expect(e.system.every((s) => s.type === "text")).toBe(true);
		expect(tekst).toContain("Post-Compaction Recovery Tools");
		expect(tekst).toContain("ses_k1_barn");
	});

	test("en barneøkts kompaktering får ingenting", async () => {
		const { hook, buss } = await oppsett();
		buss.send(barnOpprettet("ses_k2", "ses_k2_barn"));
		await vent(() => readRegistry("ses_k2").entries.length > 0);
		const e = { sessionID: "ses_k2_barn", system: [] as unknown[] };
		await hook("session.compaction")(e);
		expect(e.system).toEqual([]);
	});

	test("compaction.ended på bussen når kjernen som session.compacted", async () => {
		const { buss } = await oppsett();
		buss.send({ type: "session.compaction.ended", data: { sessionID: "ses_k3", reason: "manual", text: "sammendrag" } });
		expect(await vent(() => /\[Compaction:Post\] Context compaction detected \(manual, sammendrag 10 tegn\)/.test(lesLogg()))).toBe(
			true
		);
	});
});

test("testen skrev under temp-PAI_HOME", () => {
	expect(existsSync(join(temp, "MEMORY", "STATE"))).toBe(true);
});
