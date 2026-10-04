/**
 * Røyktestenes nye forsøk (K7) og rapport (K43), uten modellkall
 *
 * K7: `V2Smoke` var rød i fire av seks kjøringer 2026-09-26 og 2026-09-28 fordi
 * modellen lot et kall være, og en slik rød ser lik ut som en regresjon. Det nye
 * forsøket må aldri komme når kallet ble gjort, ellers blir en ekte regresjon
 * kjørt til den er grønn av flaks.
 *
 * K43: en rød `ClaudeSmoke` i jobbtreet mistet hvilken sjekk som falt, fordi
 * rapporten bare sto i terminalen. Rapporten til fil må ikke bli et nytt sted
 * modellnøkkelen havner.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lesStrøm, manglendeKontekstkall } from "../Tools/ClaudeSmoke";
import {
	lagKvittering,
	medNyttForsøk,
	merknaderFra,
	type Omkjøring,
	omkjøringslinjer,
	rødVeiSjekker,
	stegFeil,
	Utskrift,
} from "../Tools/lib/roeyktest";
import { askAvslått, KALLKRAV, skallBareForSluppne, strømfeil, uprøvdAsk, uprøvdeKall } from "../Tools/V2Smoke";

const tmp = mkdtempSync(join(tmpdir(), "pai-roeyktest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Én `tool_use`-linje slik `run --format json` skriver den. */
function kall(tool: string, input: Record<string, unknown>, status = "completed"): string {
	return JSON.stringify({ type: "tool_use", part: { tool, state: { status, input, output: "" } } });
}

/** En stille utskrift, så testene ikke fyller terminalen. */
function stille(): Utskrift {
	const u = new Utskrift();
	u.log = (t = "") => u.bareIRapport(t);
	u.feil = (t: string) => u.bareIRapport(t);
	return u;
}

function steg(navn: string, omkjørt: Omkjøring[] = []) {
	const w = join(tmp, navn);
	mkdirSync(w);
	return { w, fil: "vakt", etikett: "steg v", ut: stille(), omkjørt };
}

describe("K7: medNyttForsøk", () => {
	test("kjører én gang når modellen gjorde kallene", async () => {
		const s = steg("en-gang");
		let n = 0;
		const r = await medNyttForsøk(s, async () => ++n, () => []);
		expect(r).toBe(1);
		expect(s.omkjørt).toEqual([]);
	});

	test("kjører én gang til når et kall mangler, og gir det nye forsøket", async () => {
		const s = steg("to-ganger");
		let n = 0;
		const r = await medNyttForsøk(s, async () => ++n, (k) => (k === 1 ? ["write mot .ssh/"] : []));
		expect(r).toBe(2);
		expect(s.omkjørt).toEqual([{ steg: "steg v", uprøvd: ["write mot .ssh/"] }]);
	});

	// Gjør modellen det ikke andre gang heller, er prompten feil, og det skal bli rødt.
	test("aldri mer enn to forsøk, selv når kallet mangler begge gangene", async () => {
		const s = steg("aldri-tre");
		let n = 0;
		const r = await medNyttForsøk(s, async () => ++n, () => ["execute"]);
		expect(r).toBe(2);
		expect(s.omkjørt).toHaveLength(1);
	});

	test("første forsøks filer får nytt navn, og bare stegets egne", async () => {
		const s = steg("filer");
		let n = 0;
		const r = await medNyttForsøk(
			s,
			async () => {
				n++;
				writeFileSync(join(s.w, "vakt.log"), `forsøk ${n}\n`);
				writeFileSync(join(s.w, "vakt.jsonl"), `forsøk ${n}\n`);
				return n;
			},
			(k) => (k === 1 ? ["shell med rm -rf"] : [])
		);
		expect(r).toBe(2);
		expect(readFileSync(join(s.w, "vakt.log"), "utf-8")).toBe("forsøk 2\n");
		expect(readFileSync(join(s.w, "vakt.forsøk1.log"), "utf-8")).toBe("forsøk 1\n");
		expect(readFileSync(join(s.w, "vakt.forsøk1.jsonl"), "utf-8")).toBe("forsøk 1\n");
	});

	// Probens payloadlogg deles av forsøkene, og `vakter` er et annet steg.
	test("filer med et annet prefiks blir stående", async () => {
		const s = steg("andre-filer");
		writeFileSync(join(s.w, "vakt-probe.jsonl"), "delt\n");
		writeFileSync(join(s.w, "vakter.log"), "annet steg\n");
		await medNyttForsøk(s, async () => 0, (k) => (k === 0 ? ["x"] : []));
		expect(readdirSync(s.w).sort()).toEqual(["vakt-probe.jsonl", "vakter.log"]);
	});

	test("rapporten nevner steget og kallet som manglet", () => {
		expect(omkjøringslinjer([])).toEqual([]);
		const linjer = omkjøringslinjer([{ steg: "steg p", uprøvd: ["write"] }]).join("\n");
		expect(linjer).toContain("steg p");
		expect(linjer).toContain("modellen kalte ikke write");
	});
});

describe("K7: kallkravene i V2Smoke", () => {
	test("et blokkert kall teller som gjort: utfallet er det som måles", () => {
		const ut = [
			kall("shell", { command: "rm -rf /tmp/x/offer" }, "error"),
			kall("write", { path: ".ssh/authorized_keys", content: "test" }, "error"),
			kall("execute", { code: "return 1" }),
		].join("\n");
		expect(uprøvdeKall(ut, KALLKRAV.vakt)).toEqual([]);
	});

	test("et kall mot noe annet enn det steget ber om, teller ikke", () => {
		const ut = [kall("shell", { command: "ls" }), kall("write", { path: "annet.txt", content: "x" })].join("\n");
		expect(uprøvdeKall(ut, KALLKRAV.vakt)).toEqual(["shell med rm -rf", "write mot .ssh/", "execute"]);
	});

	test("steg 1, s og p", () => {
		expect(uprøvdeKall(kall("shell", { command: "echo sesjon=$PAI_SESSION_ID" }), KALLKRAV.steg1)).toEqual(["read"]);
		expect(uprøvdeKall(kall("subagent", { agent: "general", prompt: "x" }), KALLKRAV.subagent)).toEqual([
			"subagent med Intern",
			"execute med verktøykoden",
		]);
		expect(uprøvdeKall(kall("write", { path: "/h/.opencode/plan/p.md" }), KALLKRAV.plan)).toEqual([]);
		expect(uprøvdeKall("", KALLKRAV.plan)).toEqual(["write"]);
	});

	// `run` avslår forespørselen og avslutter; motorens egen linje er beviset.
	test("steg a: forespørselen i stderr beviser kallet, også uten tool_use", () => {
		const stderr = "permission requested: shell (git reset --hard); auto-rejecting";
		expect(uprøvdAsk("", stderr)).toEqual([]);
		expect(uprøvdAsk(kall("shell", { command: "git reset --hard" }), "")).toEqual([]);
		expect(uprøvdAsk("", "")).toEqual(["shell med git reset"]);
	});

	// Fra 2.0.20 fortsetter `run` etter avslaget med exit 0 (#153): linja og det
	// avviste kallet er beviset, ikke exitkoden.
	test("steg a: avslått krever linja og et git reset-kall som endte i error", () => {
		const linje = "! permission requested: shell (git reset --hard); auto-rejecting";
		const avvist = kall("shell", { command: "git reset --hard" }, "error");
		expect(askAvslått(avvist, linje)).toEqual({ ok: true });
		expect(askAvslått(avvist, "").ok).toBe(false);
		expect(askAvslått("", linje).detalj).toBe("ingen tool_use for git reset i strømmen");
		const kjørt = askAvslått(kall("shell", { command: "git reset --hard" }), linje);
		expect(kjørt).toEqual({ ok: false, detalj: "git reset-kallet endte completed, ikke error" });
		// Et annet skallkall som feilet, beviser ikke avslaget.
		expect(askAvslått(kall("shell", { command: "ls" }, "error"), linje).ok).toBe(false);
	});
});

describe("V2Smoke: vakt-steget teller skallene", () => {
	// Modellen la til en ufarlig `ls -la` etter blokkene (MÅLT 2026-09-29), og
	// den gamle sjekken, «shell.create.before fyrte aldri», ble rød uten funn.
	const blokkert = { tool: "shell", status: "error", utfall: "[PAI Security] rm -rf er blokkert" };
	const tillatt = { tool: "shell", status: "completed", utfall: "total 0" };
	const feiletKommando = { tool: "shell", status: "error", utfall: "exit 2" };

	test("et blokkert kall uten skall er grønt, også med et tillatt ved siden av", () => {
		expect(skallBareForSluppne([blokkert], []).ok).toBe(true);
		expect(skallBareForSluppne([blokkert, tillatt], ["tool.execute.before", "shell.create.before"]).ok).toBe(true);
	});

	test("startet det blokkerte kallet et skall, er det rødt, med tallene i detaljen", () => {
		const s = skallBareForSluppne([blokkert], ["shell.create.before"]);
		expect(s.ok).toBe(false);
		expect(s.detalj).toBe("1 skall startet, 0 skallkall sluppet gjennom");
		expect(skallBareForSluppne([blokkert, tillatt], ["shell.create.before", "shell.create.before"]).ok).toBe(false);
	});

	test("et sluppet kall uten skall er også rødt: da fyrte ikke hooken", () => {
		expect(skallBareForSluppne([blokkert, tillatt], []).ok).toBe(false);
	});

	test("et sluppet kall som feilet i skallet, teller som sluppet", () => {
		expect(skallBareForSluppne([blokkert, feiletKommando], ["shell.create.before"]).ok).toBe(true);
	});
});

describe("K7: steg K i ClaudeSmoke", () => {
	const strøm = (navn: string, input: Record<string, unknown>) =>
		({ hooks: [], kall: [{ id: "1", navn, input, resultat: "", feil: false }], svar: "", tekst: [] });

	test("echo-kallet teller, et annet Bash-kall gjør det ikke", () => {
		expect(manglendeKontekstkall(strøm("Bash", { command: "echo claudesmoke-k" }))).toEqual([]);
		expect(manglendeKontekstkall(strøm("Bash", { command: "ls" }))).toEqual(["Bash echo claudesmoke-k"]);
	});
});

describe("K43: rapporten", () => {
	test("har alt, også det som bare skal i rapporten, og nøkkelen er byttet ut", () => {
		const dir = join(tmp, "rapport");
		mkdirSync(dir);
		const u = stille();
		u.log("  ❌ Write til .ssh/ (fw_hemmelig123)");
		u.bareIRapport("Hele stderr: FIREWORKS_API_KEY=fw_hemmelig123");
		const sti = u.skriv(dir, ["fw_hemmelig123"]);
		const tekst = readFileSync(sti, "utf-8");
		expect(sti).toBe(join(dir, "rapport.txt"));
		expect(tekst).toContain("❌ Write til .ssh/");
		expect(tekst).toContain("Hele stderr");
		expect(tekst).not.toContain("fw_hemmelig123");
	});

	// En tom nøkkel ville satt erstatningen mellom hvert tegn.
	test("en tom hemmelighet endrer ingenting", () => {
		const dir = join(tmp, "tom-hemmelighet");
		mkdirSync(dir);
		const u = stille();
		u.log("abc");
		expect(readFileSync(u.skriv(dir, [""]), "utf-8")).toBe("abc\n");
		expect(existsSync(join(dir, "rapport.txt"))).toBe(true);
	});
});

describe("K55: merknadene i kvitteringen", () => {
	test("merknaderFra tar merknadene i rekkefølge, uten dubletter og tomme", () => {
		expect(merknaderFra([{ merknad: "b" }, {}, { merknad: "a" }, { merknad: "b" }, { merknad: "" }])).toEqual(["b", "a"]);
		expect(merknaderFra([{}, {}])).toEqual([]);
	});

	test("en grønn sjekk med merknad gir merknader i kvitteringen", () => {
		const k = lagKvittering("2.1.283", 8, [{ merknad: "subagent: ny nøkkel run_in_background" }, {}], "abc", "2026-09-30");
		expect(k).toEqual({
			versjon: "2.1.283",
			dato: "2026-09-30",
			hooks: 8,
			sjekker: 2,
			adapter: "abc",
			merknader: ["subagent: ny nøkkel run_in_background"],
		});
	});

	// En kjøring uten merknader skal ikke gi en diff i kvitteringen utover datoen.
	test("uten merknader, og uten adapter-hash, står feltene ikke i kvitteringen", () => {
		const k = lagKvittering("2.0.18", 10, [{}, {}, {}], null, "2026-09-30");
		expect(k).toEqual({ versjon: "2.0.18", dato: "2026-09-30", hooks: 10, sjekker: 3 });
		expect(Object.keys(k)).not.toContain("merknader");
	});

	// main() i røyktestene kjører modellen og testes ikke; koblingen pinnes i kilden.
	test("begge røyktestene skriver kvitteringen med lagKvittering", () => {
		for (const [fil, kall] of [
			["Tools/ClaudeSmoke.ts", "skrivClaudeKvittering("],
			["Tools/V2Smoke.ts", "skrivKvittering("],
		] as const) {
			const kilde = readFileSync(join(import.meta.dir, "..", fil), "utf-8");
			const linjer = kilde.split("\n").filter((l) => l.includes(kall) && !l.includes("import"));
			expect(linjer.length).toBe(1);
			expect(linjer[0]).toMatch(/lagKvittering\([^)]*sjekker/);
		}
	});
});

describe("K46: den røde veien", () => {
	// Linjene er målt 2026-10-01 med en ukjent modell (Claude Code 2.1.283, v2 2.0.18).
	const claudeFeil = JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: true,
		result: "There's an issue with the selected model (finnes-ikke-modell).",
		terminal_reason: "api_error",
	});
	const claudeOk = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hei" });
	const v2Feil = JSON.stringify({
		type: "error",
		sessionID: "ses_x",
		error: { type: "provider.no-route", message: "Model unavailable: fireworks-ai/accounts/fireworks/routers/finnes-ikke-modell" },
	});
	const ok = { exitCode: 0, tidsavbrudd: false };

	test("grønt steg: exit 0 og ingen feil i strømmen", () => {
		expect(stegFeil(ok)).toBeUndefined();
		expect(stegFeil(ok, lesStrøm(claudeOk).feil)).toBeUndefined();
		expect(stegFeil(ok, strømfeil('{"type":"text","part":{"text":"hei"}}'))).toBeUndefined();
	});

	test("exit ≠ 0 og tidsavbrudd er røde, med feilen fra strømmen når den finnes", () => {
		expect(stegFeil({ exitCode: 1, tidsavbrudd: false })).toBe("exit 1");
		expect(stegFeil({ exitCode: null, tidsavbrudd: true })).toBe("exit null, tidsavbrudd");
		expect(stegFeil({ exitCode: 0, tidsavbrudd: true })).toBe("exit 0, tidsavbrudd");
		expect(stegFeil({ exitCode: 1, tidsavbrudd: false }, strømfeil(v2Feil))).toBe(
			"exit 1: provider.no-route: Model unavailable: fireworks-ai/accounts/fireworks/routers/finnes-ikke-modell"
		);
	});

	// anthropics/claude-code#79500: en API-feil etter kallet gir exit 0.
	test("is_error: true i Claudes result gjør steget rødt også ved exit 0", () => {
		const banner = "PAI-banner som ikke er JSON";
		expect(lesStrøm(`${banner}\n${claudeFeil}\n`).feil).toBe(
			"is_error: There's an issue with the selected model (finnes-ikke-modell)."
		);
		expect(stegFeil(ok, lesStrøm(claudeFeil).feil)).toStartWith("exit 0, men is_error: ");
	});

	test("en error-hendelse i v2s strøm gjør steget rødt også ved exit 0", () => {
		expect(stegFeil(ok, strømfeil(`ikke json\n${v2Feil}\n`))).toStartWith("exit 0, men provider.no-route: ");
	});

	describe("rødVeiSjekker", () => {
		const dir = mkdtempSync(join(tmpdir(), "pai-rod-vei-"));
		afterAll(() => rmSync(dir, { recursive: true, force: true }));
		const rapport = join(dir, "rapport.txt");
		writeFileSync(rapport, "  steg K: ...\nHele stderr fra steg K:\n[claude-code:unrecognized_model]\n");
		const omkjørt: Omkjøring[] = [{ steg: "steg K", uprøvd: ["Bash echo claudesmoke-k"] }];
		const rødt = (sjekker: { navn: string; ok: boolean }[]) => sjekker.filter((s) => !s.ok).map((s) => s.navn);

		test("holder når steget ble kjørt på nytt, ga exit 1 og står i rapporten", () => {
			expect(rødt(rødVeiSjekker("steg K", { exitCode: 1 }, "exit 1", omkjørt, rapport))).toEqual([]);
		});

		test("uten nytt forsøk, eller med et nytt forsøk bare i et annet steg", () => {
			const navn = "steg K ble kjørt på nytt, fordi modellen ikke gjorde kallene (K7)";
			expect(rødt(rødVeiSjekker("steg K", { exitCode: 1 }, "exit 1", [], rapport))).toEqual([navn]);
			const annet: Omkjøring[] = [{ steg: "steg V", uprøvd: ["Write"] }];
			expect(rødt(rødVeiSjekker("steg K", { exitCode: 1 }, "exit 1", annet, rapport))).toEqual([navn]);
		});

		// Med is_error alene ville steget blitt rødt, og en launcher som svelger
		// exitkoden (M-51) sluppet gjennom.
		test("rødt bare av is_error, med exit 0: M-51 meldes", () => {
			expect(rødt(rødVeiSjekker("steg K", { exitCode: 0 }, "exit 0, men is_error: x", omkjørt, rapport))).toEqual([
				"steg K ga exit ≠ 0 (M-51)",
			]);
		});

		test("et grønt steg", () => {
			expect(rødt(rødVeiSjekker("steg K", { exitCode: 0 }, undefined, omkjørt, rapport))).toEqual([
				"steg K ble rødt",
				"steg K ga exit ≠ 0 (M-51)",
			]);
		});

		test("rapporten mangler, eller har et annet stegs stderr", () => {
			const navn = "rapport.txt har hele stderr fra steg K (K43)";
			expect(rødVeiSjekker("steg K", { exitCode: 1 }, "exit 1", omkjørt, join(dir, "borte.txt")).find((s) => s.navn === navn)).toMatchObject({
				ok: false,
				detalj: `fant ikke ${join(dir, "borte.txt")}`,
			});
			const annen = join(dir, "annen.txt");
			writeFileSync(annen, "Hele stderr fra steg V:\n");
			expect(rødt(rødVeiSjekker("steg K", { exitCode: 1 }, "exit 1", omkjørt, annen))).toEqual([navn]);
		});
	});
});
