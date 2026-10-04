/**
 * Kontrakt-test: MCP-serveren og sesjonsoppslaget
 *
 * MÅLT 2026-09-22 mot Claude Code 2.1.278 med en kastbar probe-plugin:
 *
 *   Verktøynavnet blir `mcp__plugin_<plugin>_<server>__<verktøy>`, altså
 *   `mcp__plugin_pai_pai__session_registry`. Planens `mcp__pai__<verktøy>`
 *   finnes ikke.
 *
 *   MCP-serveren er et DIREKTE barn av motorprosessen:
 *     dybde=0 pid=68443 comm=bun     ← serveren
 *     dybde=1 pid=68419 comm=claude  ← motoren
 *   Hookene har `sh` og `bash` imellom og må lete oppover. Her er
 *   forelderen motoren, og det er hele grunnlaget for sesjonspekeren.
 *
 *   Serveren er langlivet, én prosess per økt, med rekkefølgen
 *   `initialize` → `notifications/initialized` → `tools/list` →
 *   `tools/call`.
 *
 * Ende-til-ende verifisert i samme økt: `[MCP] session_registry for
 * daf509fe-… (kilde: forelder)`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	finnSesjonForKatalog,
	finnSesjonForProsess,
	ryddPekere,
	skrivSesjonsPeker,
} from "../.opencode/pai-core/lib/session-pointer";
import { forelderPid, ppidFraStat } from "../claude-plugin/src/session";
import { tilKjernehendelser } from "../claude-plugin/src/adapter/in";

const ROT = join(import.meta.dir, "..");
let tidligereHome: string | undefined;

beforeEach(() => {
	// ALLE testene her skriver til STATE. Uten en temp-PAI_HOME havner de i
	// brukerens EKTE MEMORY-tre — det skjedde for `claude-adapter.test.ts`,
	// som la igjen en peker mot en levende økt.
	tidligereHome = process.env.PAI_HOME;
	process.env.PAI_HOME = mkdtempSync(join(tmpdir(), "pai-mcp-"));
});

afterEach(() => {
	if (tidligereHome === undefined) delete process.env.PAI_HOME;
	else process.env.PAI_HOME = tidligereHome;
});

// ---------------------------------------------------------------------------
// Sesjonspekeren
// ---------------------------------------------------------------------------

describe("sesjonspekeren", () => {
	test("skrives og slås opp på motorens pid", () => {
		// Egen pid som stand-in for motoren: den lever, så liveness-sjekken
		// gjør det den skal framfor å bli hoppet over.
		skrivSesjonsPeker("økt-1", process.pid, "/tmp/x");
		expect(finnSesjonForProsess(process.pid)).toBe("økt-1");
	});

	test("en ukjent pid gir null, ikke en gjetning", () => {
		// Å svare «vet ikke» er riktig. Gjetter vi, svarer verktøyet
		// selvsikkert om FEIL økts subagenter.
		skrivSesjonsPeker("økt-1", process.pid, "/tmp/x");
		expect(finnSesjonForProsess(999_999_998)).toBeNull();
	});

	test("en GJENBRUKT pid forkastes", () => {
		// Operativsystemet resirkulerer pid-er. Uten starttidssjekken ville
		// en ny prosess arvet en død økts identitet.
		skrivSesjonsPeker("økt-1", process.pid, "/tmp/x");
		const sti = join(process.env.PAI_HOME as string, "MEMORY/STATE/sessions/by-ppid", `${process.pid}.json`);
		const peker = JSON.parse(readFileSync(sti, "utf-8"));
		peker.engineStart = "0"; // umulig starttid for en levende prosess
		writeFileSync(sti, JSON.stringify(peker), "utf-8");
		expect(finnSesjonForProsess(process.pid)).toBeNull();
	});

	test("skriver ingenting for ukjent motor-pid", () => {
		// En peker med feil pid er verre enn ingen: serveren ville lest en
		// annen økts register.
		skrivSesjonsPeker("økt-1", undefined, "/tmp/x");
		expect(finnSesjonForKatalog("/tmp/x")).toBeNull();
	});

	test("skriver ingenting for ukjent sesjons-ID", () => {
		skrivSesjonsPeker("unknown", process.pid, "/tmp/x");
		expect(finnSesjonForProsess(process.pid)).toBeNull();
	});

	test("katalogoppslaget er siste utvei og tar den nyeste", () => {
		skrivSesjonsPeker("gammel", process.pid, "/tmp/delt");
		skrivSesjonsPeker("ny", process.ppid, "/tmp/delt");
		expect(finnSesjonForKatalog("/tmp/delt")).toBe("ny");
		expect(finnSesjonForKatalog("/tmp/annen")).toBeNull();
	});

	test("reaperen fjerner pekere etter døde motorer", () => {
		skrivSesjonsPeker("levende", process.pid, "/tmp/x");
		// En pid som garantert ikke finnes.
		const død = join(process.env.PAI_HOME as string, "MEMORY/STATE/sessions/by-ppid", "999999997.json");
		writeFileSync(død, JSON.stringify({ sessionId: "død", enginePid: 999_999_997, engineStart: "1", cwd: "/tmp", at: Date.now() }), "utf-8");
		expect(ryddPekere()).toBeGreaterThanOrEqual(1);
		expect(finnSesjonForProsess(process.pid)).toBe("levende");
	});
});

describe("forelderPid", () => {
	test("leser ppid for den ekte prosessen", () => {
		expect(forelderPid()).toBe(process.ppid);
	});

	test("et prosessnavn med MELLOMROM forskyver ikke ppid", () => {
		// Den ekte prosessen heter `bun` og avslører ingenting: en rå
		// `split(" ")` treffer riktig felt så lenge navnet er ett ord. Denne
		// linja er grunnen til at parsingen klipper etter SISTE `)`.
		expect(ppidFraStat("4242 (my weird name) S 1234 4242 4242 0 -1 4194304")).toBe(1234);
	});

	test("et prosessnavn med PARENTESER forskyver ikke ppid heller", () => {
		expect(ppidFraStat("4242 (a (b) c) S 7777 4242 0 0")).toBe(7777);
	});

	test("vanlig navn gir samme svar som før", () => {
		expect(ppidFraStat("68443 (bun) S 68419 68443 0 0")).toBe(68419);
	});

	test("en linje uten parentes gir null framfor et tall fra ingensteds", () => {
		expect(ppidFraStat("noe helt annet")).toBeNull();
	});

	test("en pid som ikke finnes gir null", () => {
		expect(forelderPid(999_999_996)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Serveren som prosess — stdout er protokollen
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: MCP-svar leses som rå JSON-RPC i testen
async function kjørServer(meldinger: string[]): Promise<any[]> {
	const proc = Bun.spawn(["bun", join(ROT, "claude-plugin/mcp/pai-mcp.ts")], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PAI_HARNESS: "claude" },
	});
	proc.stdin.write(`${meldinger.join("\n")}\n`);
	await proc.stdin.end();
	const ut = await new Response(proc.stdout).text();
	await proc.exited;
	return ut
		.trim()
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l));
}

describe("MCP-protokollen", () => {
	test("initialize svarer med protokollversjon og servernavn", async () => {
		const [svar] = await kjørServer(['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}']);
		expect(svar.id).toBe(1);
		expect(svar.result.protocolVersion).toBe("2024-11-05");
		expect(svar.result.serverInfo.name).toBe("pai");
	});

	test("tools/list gir verktøyene, og hvert av dem har et skjema", async () => {
		const [, svar] = await kjørServer([
			'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
			'{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
		]);
		const navn = svar.result.tools.map((t: { name: string }) => t.name);
		expect(navn).toContain("session_registry");
		expect(navn).toContain("session_results");
		for (const t of svar.result.tools) {
			expect(t.inputSchema.type).toBe("object");
			expect(typeof t.description).toBe("string");
		}
	});

	test("notifications/initialized besvares IKKE", async () => {
		// En notifikasjon har ingen `id`, og et svar på den er protokollfeil.
		const svar = await kjørServer([
			'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
			'{"jsonrpc":"2.0","method":"notifications/initialized"}',
		]);
		expect(svar.length).toBe(1);
	});

	test("hver linje på stdout er nøyaktig ett gyldig JSON-dokument", async () => {
		// stdout ER protokollen. En stray console.log ødelegger rammen, og
		// motoren rapporterer det som en generisk serverfeil.
		const svar = await kjørServer([
			'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
			'{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
			'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"session_registry","arguments":{}}}',
		]);
		expect(svar.length).toBe(3);
		for (const s of svar) expect(s.jsonrpc).toBe("2.0");
	});

	test("ugyldig JSON på stdin dreper ikke serveren", async () => {
		// Dør serveren, mister økten ALLE verktøyene for godt.
		const svar = await kjørServer([
			"{ dette er ikke json",
			'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
		]);
		expect(svar.length).toBe(1);
		expect(svar[0].result.serverInfo.name).toBe("pai");
	});

	test("et ukjent verktøy gir isError, ikke en krasj", async () => {
		const [, svar] = await kjørServer([
			'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
			'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"finnes_ikke","arguments":{}}}',
		]);
		expect(svar.result.isError).toBe(true);
	});

	test("uten sesjonspeker svarer verktøyet «vet ikke» framfor å gjette", async () => {
		const [, svar] = await kjørServer([
			'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
			'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"session_registry","arguments":{}}}',
		]);
		expect(svar.result.content[0].text).toContain("Fant ikke ut hvilken økt");
	});
});

// ---------------------------------------------------------------------------
// Registreringen motoren leser
// ---------------------------------------------------------------------------

describe("plugin-registreringen", () => {
	test(".mcp.json peker kun på bin/pai-mcp", () => {
		// Kontrakten som gjør en kompilert binær i batch 12 gratis, og som
		// motoren dessuten validerer: kommandoen må matche
		// `^\\$\\{CLAUDE_PLUGIN_ROOT\\}/bin/([^/\\\\]+)$`.
		const mcp = JSON.parse(readFileSync(join(ROT, "claude-plugin/.mcp.json"), "utf-8"));
		const server = mcp.mcpServers.pai;
		// biome-ignore lint/suspicious/noTemplateCurlyInString: ${CLAUDE_PLUGIN_ROOT} er en literal motoren substituerer — den validerer selv formen ^\$\{CLAUDE_PLUGIN_ROOT\}/bin/([^/\\]+)$ (målt i batch 9)
		expect(server.command).toBe("${CLAUDE_PLUGIN_ROOT}/bin/pai-mcp");
		expect(server.command).toMatch(/^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/[^/\\]+$/);
	});

	test("servernavnet er `pai`, så verktøynavnene blir som målt", () => {
		// MÅLT: motoren bygger `mcp__plugin_<plugin>_<server>__<verktøy>`.
		// Endres nøkkelen her, endres hvert verktøynavn brukeren må godkjenne.
		const mcp = JSON.parse(readFileSync(join(ROT, "claude-plugin/.mcp.json"), "utf-8"));
		expect(Object.keys(mcp.mcpServers)).toEqual(["pai"]);
	});

	test("oppstarteren er kjørbar", () => {
		const { mode } = require("node:fs").statSync(join(ROT, "claude-plugin/bin/pai-mcp"));
		// En MCP-server som ikke kan kjøres feiler stille: verktøyene bare
		// finnes ikke, og ingenting sier hvorfor.
		expect(mode & 0o111).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Navnet motoren gir tilbake er ikke navnet kjernen skal lagre
// ---------------------------------------------------------------------------

describe("pluginprefikset følger ikke med inn i kjernen", () => {
	test("SubagentStart/Stop gir `Intern`, ikke `pai:Intern`", () => {
		// OBSERVERT i røyktest 2026-09-22: uten strippingen ble fangstfila
		// hetende `AGENT-pai:Intern_….md`. Prefikset er en ADRESSE, ikke
		// agentens identitet, og MEMORY-treet deles med OpenCode-siden der
		// samme agent heter `Intern`. To navn for samme agent gjør delt
		// tilstand til to tilstander.
		const felles = {
			session_id: "s1",
			cwd: "/tmp",
			agent_id: "a1",
		};
		const [start] = tilKjernehendelser({
			...felles,
			hook_event_name: "SubagentStart",
			agent_type: "pai:Intern",
		});
		expect(start).toMatchObject({ agentType: "Intern" });

		const [stop] = tilKjernehendelser({
			...felles,
			hook_event_name: "SubagentStop",
			agent_type: "pai:DeepResearcher",
			last_assistant_message: "noe",
			stop_hook_active: false,
		});
		expect(stop).toMatchObject({ agentType: "DeepResearcher" });
	});

	test("et navn UTEN prefiks røres ikke", () => {
		// Claude Codes egne agenter (`Explore`, `general-purpose`) har intet
		// prefiks, og en blind `split(":")[1]` ville gjort dem til undefined.
		const [start] = tilKjernehendelser({
			session_id: "s1",
			cwd: "/tmp",
			agent_id: "a1",
			hook_event_name: "SubagentStart",
			agent_type: "Explore",
		});
		expect(start).toMatchObject({ agentType: "Explore" });
	});
});
