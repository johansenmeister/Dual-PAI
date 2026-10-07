/**
 * Kontrakt-test: v2-adapterens registreringer og fyr-registeret
 *
 * v2 validerer ikke hooknavn (MÅLT: `tool.hook("finnes.ikke")` gir `[REG OK]`
 * og fyrer aldri). Beviset på at en hook FYRER er `Tools/V2Smoke.ts`, mot den
 * ekte binæren — men den koster modellkall og kjøres ikke her. Det denne fila
 * beviser gratis, er at de to sidene av beviset er samme liste:
 *
 *   - det `setup` faktisk registrerer, er nøyaktig `V2_HOOKS`, og
 *   - hver registrert hook skriver fyr-linja `V2Smoke` leter etter.
 *
 * Blir en hook lagt til på bare den ene siden, feiler en av dem.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import adapter, { FYR_MARKØR, V2_HOOKS, hendelsesbase, vakt } from "../.opencode/pai-adapters/opencode-v2";
import type { V2Verktøy } from "../.opencode/pai-adapters/opencode-v2/verktoy";
import { FYR_KRAV, lesDaNavn, manglende, verktøykall } from "../Tools/V2Smoke";

type Tilbakekall = (e: unknown) => Promise<void> | void;

let temp: string;
let logg: string;
const lagret: Record<string, string | undefined> = {};

/**
 * Cleanup fra hver `setup`, awaitet før `PAI_HOME` settes tilbake. Reaperen
 * startes i `setup` uten `await` (fase 4); overlevde den fila, ville den lest
 * det EKTE `STATE/`. Cleanup venter på den.
 */
const cleanups: (() => Promise<void> | void)[] = [];
function spor<T>(cleanup: T): T {
	if (typeof cleanup === "function") cleanups.push(cleanup as () => Promise<void> | void);
	return cleanup;
}

beforeAll(() => {
	temp = mkdtempSync(join(tmpdir(), "pai-v2-adapter-"));
	logg = join(temp, "v2.log");
	for (const k of ["PAI_HOME", "PAI_HARNESS", "PAI_LOG_PATH"]) lagret[k] = process.env[k];
	process.env.PAI_HOME = temp;
	process.env.PAI_LOG_PATH = logg;
});

afterEach(() => {
	// `setup` setter PAI_HARNESS for hele prosessen, og bun kjører alle
	// testfilene i SAMME prosess. Uten dette ville neste fil tro at den
	// kjører under v2.
	if (lagret.PAI_HARNESS === undefined) delete process.env.PAI_HARNESS;
	else process.env.PAI_HARNESS = lagret.PAI_HARNESS;
});

afterAll(async () => {
	for (const c of cleanups.splice(0)) await c();
	for (const [k, v] of Object.entries(lagret)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(temp, { recursive: true, force: true });
});

/** En v2-kontekst som husker hva som ble registrert, og under hvilket navn. */
function falskKontekst() {
	const registrert = new Map<string, Tilbakekall>();
	const verktøy: V2Verktøy[] = [];
	let abonnert = false;
	const domene = (navn: string) => ({
		hook: async (hook: string, cb: Tilbakekall) => {
			registrert.set(`${navn}.${hook}`, cb);
			return { dispose: async () => {} };
		},
	});
	// Motoren kaller transform-tilbakekallet med en editor straks det
	// registreres (MÅLT, fase 0: `[tool.transform] før add` i setup), og på
	// nytt ved en rebuild. Den falske gjør det samme, og hvert nytt kall
	// bygger lista fra bunnen, som en ny rebuild.
	const editor = {
		add: (v: V2Verktøy) => {
			verktøy.push(v);
		},
	};
	const ctx = {
		tool: {
			...domene("tool"),
			transform: async (cb: (e: typeof editor) => void) => {
				const kjør = () => {
					verktøy.length = 0;
					cb(editor);
				};
				registrert.set("tool.transform", kjør);
				kjør();
				return { dispose: async () => {} };
			},
		},
		session: domene("session"),
		shell: domene("shell"),
		permission: domene("permission"),
		event: {
			subscribe: () => {
				abonnert = true;
				return (async function* () {
					yield { type: "session.created", data: {} };
				})();
			},
		},
	};
	return { ctx, registrert, verktøy, abonnert: () => abonnert };
}

function fyrLinjer(): string[] {
	if (!existsSync(logg)) return [];
	return readFileSync(logg, "utf-8")
		.split("\n")
		.filter((l) => l.includes(FYR_MARKØR))
		.map((l) => l.slice(l.indexOf(FYR_MARKØR) + FYR_MARKØR.length).trim());
}

describe("det setup registrerer, er V2_HOOKS", () => {
	test("hver hook, bussen og cleanup — ingen flere, ingen færre", async () => {
		const f = falskKontekst();
		// biome-ignore lint/suspicious/noExplicitAny: falsk kontekst med bare domenene adapteren bruker
		const cleanup = spor(await adapter.setup(f.ctx as any));

		const faktisk = [...f.registrert.keys()];
		if (f.abonnert()) faktisk.push("event.subscribe");
		if (typeof cleanup === "function") faktisk.push("plugin.cleanup");

		expect(faktisk.sort()).toEqual([...V2_HOOKS].sort());
	});

	test("V2Smoke krever nøyaktig V2_HOOKS", () => {
		// Røyktesten er vakten mot stille hooknavn. Krever den færre navn
		// enn adapteren registrerer, er de manglende ubevoktet.
		expect([...FYR_KRAV].sort()).toEqual([...V2_HOOKS].sort());
	});
});

describe("hver registrert hook skriver fyr-linja", () => {
	/** Kjør setup, kall hver hook to ganger, tøm bussen og kall cleanup. */
	async function fyrAlt(): Promise<void> {
		const f = falskKontekst();
		// biome-ignore lint/suspicious/noExplicitAny: se over
		const cleanup = spor(await adapter.setup(f.ctx as any));
		for (const cb of f.registrert.values()) {
			await cb({});
			await cb({});
		}
		// Bussen tømmes i bakgrunnen; gi den en tur i hendelsesløkka.
		await new Promise((r) => setTimeout(r, 10));
		if (typeof cleanup === "function") await cleanup();
	}

	test("alle i V2_HOOKS er meldt", async () => {
		await fyrAlt();
		expect(new Set(fyrLinjer())).toEqual(new Set(V2_HOOKS));
	});

	test("én linje per hook, ikke én per kall", async () => {
		await fyrAlt();
		const linjer = fyrLinjer();
		expect(linjer.length).toBe(new Set(linjer).size);
	});

	test("en ny setup i samme prosess melder alle på nytt", async () => {
		// `setup` tømmer loggen. Huskes det fortsatt at hookene har fyrt,
		// står loggen uten fyr-linjer etter en reload.
		await fyrAlt();
		await fyrAlt();
		expect(new Set(fyrLinjer())).toEqual(new Set(V2_HOOKS));
	});

});

describe("vakt: en feil i PAI når aldri motoren", () => {
	// En kastet feil i en v2-hook er en BLOKK — `throw` i `execute.before`
	// stopper kallet (MÅLT). Kommer den fra en PAI-feil, blokkeres brukerens
	// verktøykall. Testet på innpakningen direkte: hookene er tomme i fase 1,
	// så et kall gjennom `setup` kan ikke kaste, og en slik test ville stått
	// grønn også uten fangsten (mutasjonstestet).
	test("synkron feil svelges og logges", async () => {
		const pakket = vakt("tool.execute.before", () => {
			throw new Error("PAI-feil");
		});
		await expect(pakket({})).resolves.toBeUndefined();
		expect(readFileSync(logg, "utf-8")).toContain("tool.execute.before feilet");
	});

	test("avvist promise svelges", async () => {
		const pakket = vakt("tool.execute.after", async () => {
			throw new Error("PAI-feil");
		});
		await expect(pakket({})).resolves.toBeUndefined();
	});

	test("fyr-linja skrives også når hooken feiler", async () => {
		// Hooken FYRTE — at PAI feilet etterpå er en annen sak. Uten dette
		// ville en krasjende handler sett ut som et hooknavn motoren ikke
		// kjenner.
		const f = falskKontekst();
		// biome-ignore lint/suspicious/noExplicitAny: se over
		spor(await adapter.setup(f.ctx as any));
		await vakt("permission.evaluate", () => {
			throw new Error("PAI-feil");
		})({});
		expect(fyrLinjer()).toContain("permission.evaluate");
	});
});

describe("v1-kontekst: setup registrerer ingenting", () => {
	test("uten tool.hook avslutter setup uten å merke prosessen som v2", async () => {
		// v1 kaller en v2-plugins setup med sin egen kontekst (MÅLT, M5).
		delete process.env.PAI_HARNESS;
		// biome-ignore lint/suspicious/noExplicitAny: v1s kontekst har ikke v2-domenene
		const cleanup = await adapter.setup({ client: {} } as any);
		expect(cleanup).toBeUndefined();
		expect(process.env.PAI_HARNESS).toBeUndefined();
	});
});

describe("hendelsesbasen", () => {
	test("merker hendelsen opencode2 med o2-nøkkel", () => {
		// Kjernen slår opp kapabilitetene på `harness`. Med `opencode` her
		// ville v2 fått v1s `subagentEvents: false`.
		const b = hendelsesbase("ses_abc", "/prosjekt");
		expect(b.harness).toBe("opencode2");
		expect(b.sessionKey).toBe("o2_ses_abc");
		expect(b.cwd).toBe("/prosjekt");
	});

	test("en sesjons-ID som ikke er en streng gir tom ID og unknown-nøkkel", () => {
		const b = hendelsesbase(undefined, "/p");
		expect(b.sessionId).toBe("");
		expect(b.sessionKey).toBe("o2_unknown");
	});
});

describe("fase 2: sikkerhetsvakten gjennom v2-adapteren", () => {
	// Payloadene har v2s MÅLTE form (fase 0, M2): skallet heter `shell`,
	// filverktøyene sender `path`, og `permission.evaluate` bærer kallets ID i
	// `source.id`. En test med v1- eller Claude-form ville bestått også om
	// vakten var blind under v2 — det var slik K-09 sto åpen.
	async function oppsett() {
		const f = falskKontekst();
		// biome-ignore lint/suspicious/noExplicitAny: se over
		spor(await adapter.setup(f.ctx as any));
		const før = f.registrert.get("tool.execute.before") as Tilbakekall;
		const evaluer = f.registrert.get("permission.evaluate") as Tilbakekall;
		return { før, evaluer };
	}

	const kall = (tool: string, input: Record<string, unknown>, id = "call_1") => ({
		tool,
		sessionID: "ses_v2vakt",
		agent: "build",
		messageID: "msg_1",
		id,
		input,
	});

	const evaluering = (id: string, effect = "allow") => ({
		sessionID: "ses_v2vakt",
		agent: "build",
		action: "shell",
		resources: ["x"],
		source: { type: "tool", messageID: "msg_1", id },
		effect,
		message: undefined as string | undefined,
	});

	test("et farlig skallmønster blokkeres, og begrunnelsen har PAI-prefikset", async () => {
		const { før } = await oppsett();
		await expect(
			Promise.resolve(før(kall("shell", { command: "rm -rf /tmp/noe" })))
		).rejects.toThrow("[PAI Security]");
	});

	test("Write til .ssh/ med v2s `path` blokkeres", async () => {
		const { før } = await oppsett();
		await expect(
			Promise.resolve(
				før(kall("write", { path: "/home/x/.ssh/authorized_keys", content: "ssh-ed25519 AAAA" }))
			)
		).rejects.toThrow("[PAI Security]");
	});

	test("edit med v2s `path` blokkeres", async () => {
		const { før } = await oppsett();
		await expect(
			Promise.resolve(
				før(kall("edit", { path: "/home/x/.ssh/config", oldString: "a", newString: "b" }))
			)
		).rejects.toThrow("[PAI Security]");
	});

	test("vanlige kall slipper gjennom — vakten nekter ikke alt", async () => {
		const { før } = await oppsett();
		await expect(Promise.resolve(før(kall("shell", { command: "echo hei" })))).resolves.toBeUndefined();
		await expect(
			Promise.resolve(før(kall("write", { path: "/tmp/notat.md", content: "hei" })))
		).resolves.toBeUndefined();
	});

	test("revisjonslinja merkes opencode2", async () => {
		const { før } = await oppsett();
		await Promise.resolve(før(kall("shell", { command: "rm -rf /tmp/revisjon" }))).catch(() => {});
		// Revisjonen skrives fire-and-forget.
		await new Promise((r) => setTimeout(r, 50));
		const fil = join(temp, "MEMORY", "STATE", "security-audit.jsonl");
		const linjer = readFileSync(fil, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
		const blokk = linjer.find((l) => l.action === "blocked" && l.commandPreview?.includes("revisjon"));
		expect(blokk?.harness).toBe("opencode2");
		expect(blokk?.tool).toBe("shell");
	});

	test("kjernens ask blir effect = ask i permission.evaluate for SAMME kall", async () => {
		const { før, evaluer } = await oppsett();
		await før(kall("shell", { command: "git reset --hard" }, "shell_7"));
		const e = evaluering("shell_7");
		await evaluer(e);
		expect(e.effect).toBe("ask");
		expect(e.message).toContain("[PAI Security]");
	});

	test("et annet kall i samme økt spørres ikke", async () => {
		const { før, evaluer } = await oppsett();
		await før(kall("shell", { command: "git reset --hard" }, "shell_8"));
		const e = evaluering("shell_9");
		await evaluer(e);
		expect(e.effect).toBe("allow");
	});

	test("svaret brukes én gang", async () => {
		// Et kall kan gi flere evaluate (fase 0: `external_directory` og så
		// `read` for samme kall). Brukeren skal spørres én gang, ikke to.
		const { før, evaluer } = await oppsett();
		await før(kall("shell", { command: "git reset --hard" }, "shell_10"));
		await evaluer(evaluering("shell_10"));
		const andre = evaluering("shell_10");
		await evaluer(andre);
		expect(andre.effect).toBe("allow");
	});

	test("en deny motoren har satt, svekkes ikke til ask", async () => {
		const { før, evaluer } = await oppsett();
		await før(kall("shell", { command: "git reset --hard" }, "shell_11"));
		const e = evaluering("shell_11", "deny");
		await evaluer(e);
		expect(e.effect).toBe("deny");
	});

	test("Code Mode: et indre kall med det ytre kallets ID blokkeres også", async () => {
		// Indre kall fyrer `execute.before` med sitt eget verktøynavn, men
		// deler `id` med det ytre `execute` (MÅLT, M2: `execute_6` for begge).
		const { før } = await oppsett();
		await før(kall("execute", { code: "await tools.write({ path: '.ssh/x', content: 'y' })" }, "execute_6"));
		await expect(
			Promise.resolve(før(kall("write", { path: ".ssh/x", content: "y" }, "execute_6")))
		).rejects.toThrow("[PAI Security]");
	});
});

describe("V2Smoke leser run-utdataen riktig", () => {
	// Vaktsjekkene i røyktesten står og faller med denne parseren. Leser den
	// feil felt, feiler hver sjekk som «modellen kalte ikke …» — eller verre,
	// finner ingenting og lar en tom liste se ut som ingen blokk.
	test("en blokkert shell gir status error og PAI-teksten", () => {
		const linje = JSON.stringify({
			type: "tool_use",
			part: {
				tool: "shell",
				state: { status: "error", input: { command: "rm -rf /x" }, error: "[PAI Security] blokkert" },
			},
		});
		const [k] = verktøykall(`${linje}\n{"type":"text","part":{"text":"hei"}}\nikke json`);
		expect(k).toEqual({
			tool: "shell",
			status: "error",
			input: JSON.stringify({ command: "rm -rf /x" }),
			utfall: "[PAI Security] blokkert",
		});
	});

	test("manglende gir kravene uten fyr-linje", () => {
		expect(manglende(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
	});

	// Navnet var en konstant, og jobb-harnesset (en annen identitet) ville fått
	// to røde sjekker uten at noe var galt. Begge formene står i ekte filer.
	test("lesDaNavn tar navnet fra DAIDENTITY.md, med og uten listestrek", () => {
		expect(lesDaNavn("# Identitet\n\n- **Name:** Ada Lovelace\n- **Role:** x\n")).toBe("Ada Lovelace");
		expect(lesDaNavn("# Identitet\n\n**Name:** Kari  \n**Role:** x\n")).toBe("Kari");
		expect(lesDaNavn("# Identitet\n\nIngen navnelinje her.\n")).toBe("");
	});

	// Malen blir DAIDENTITY.md i public (#162): uten navnelinja er røyktestene røde
	// for en ny bruker som ikke har kjørt intervjuet.
	test("lesDaNavn leser navnet i identitetsmalen", () => {
		const mal = readFileSync(join(import.meta.dir, "..", ".opencode", "PAI", "DAIDENTITY.template.md"), "utf-8");
		expect(lesDaNavn(mal)).toBe("Juno");
	});
});

describe("execute.after masks secrets before the model sees them (#367)", () => {
	const secret = `secret${"v".repeat(12)}`;
	const result = () => ({
		output: { exit: 0, output: `url = https://svc:${secret}@git.example.com/x.git\n`, status: "completed" },
		content: [{ type: "text", text: `url = https://svc:${secret}@git.example.com/x.git\n` }],
		metadata: { status: "complete" },
	});

	test("a credential in shell output is replaced in result, with a note for the model", async () => {
		const f = falskKontekst();
		// biome-ignore lint/suspicious/noExplicitAny: fake context with only the domains the adapter uses
		spor(await adapter.setup(f.ctx as any));
		const e = { tool: "shell", sessionID: "mask-test", id: "call-1", input: { command: "grep -n svc .git/config" }, status: "completed", result: result() };
		await f.registrert.get("tool.execute.after")?.(e);
		const after = JSON.stringify(e.result);
		expect(after).not.toContain(secret);
		expect(after).toContain("svc:[MASKED:url-credential]@");
		expect(e.result.content.at(-1)?.text).toContain("[PAI Security] Secrets in this output were masked");
	});

	test("clean output is left exactly as it was", async () => {
		const f = falskKontekst();
		// biome-ignore lint/suspicious/noExplicitAny: fake context with only the domains the adapter uses
		spor(await adapter.setup(f.ctx as any));
		const clean = { content: [{ type: "text", text: "nothing to hide" }] };
		const e = { tool: "shell", sessionID: "mask-test", id: "call-2", input: {}, status: "completed", result: clean };
		await f.registrert.get("tool.execute.after")?.(e);
		expect(e.result).toBe(clean);
	});
});
