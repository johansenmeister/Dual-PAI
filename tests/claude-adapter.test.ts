/**
 * Kontrakt-test: Claude Code-adapteren
 *
 * Mønsteret er fra `tests/security-validator.test.ts` og
 * `tests/adapter-mapping.test.ts`: test at RIKTIG feltnavn leses, OG at det
 * feile ikke gjør det. Det var den asymmetrien som avslørte
 * `filePath`/`file_path` etter to måneders død kode, og `output.result` i
 * H-16.
 *
 * Alle payloadene under er FROSNE MÅLINGER mot Claude Code 2.1.278, tatt
 * 2026-09-21 med en probe-plugin lastet via `--plugin-dir`. De er ikke
 * skrevet av fra dokumentasjon. Endrer Claude Code skjemaet, er det disse
 * som skal falle — det er den billigste måten å oppdage det på.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitiesFor, dispatch, sessionKeyFor } from "../.opencode/pai-core";
import { ownerProcess } from "../.opencode/pai-core/lib/paths";
import { isSubagentTool, SKRIVEVERKTØY } from "../.opencode/pai-core/lib/tool-names";
import { finnMotorprosess } from "../claude-plugin/src/owner";
import { tilKjernehendelser } from "../claude-plugin/src/adapter/in";
import { slåSammen, tilHookUtdata } from "../claude-plugin/src/adapter/out";
import { ASSISTENT_MIN_LENGDE, hurtigutgang } from "../claude-plugin/src/adapter/routes";

const ROT = join(import.meta.dir, "..");

/** Fjerner kommentarer, så prosa om et felt ikke teller som bruk av det. */
function utenKommentarer(kilde: string): string {
	return kilde.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------------
// FROSNE PAYLOADS — målt 2026-09-21, Claude Code 2.1.278
// ---------------------------------------------------------------------------

const SESSION_START = {
	session_id: "4e6211cd-2707-4fc2-9a26-23a3620f3462",
	transcript_path: "/home/user/.claude/projects/-tmp-x/4e6211cd.jsonl",
	cwd: "/tmp/x",
	hook_event_name: "SessionStart",
	source: "startup",
};

const USER_PROMPT_SUBMIT = {
	session_id: "4e6211cd-2707-4fc2-9a26-23a3620f3462",
	transcript_path: "/home/user/.claude/projects/-tmp-x/4e6211cd.jsonl",
	cwd: "/tmp/x",
	prompt_id: "7bc4609e-8348-4c10-996a-3729f172cd5c",
	permission_mode: "acceptEdits",
	hook_event_name: "UserPromptSubmit",
	prompt: "Kjør bash-kommandoen 'echo hei' og si deretter kodeordet du fikk i konteksten.",
};

const PRE_TOOL_USE = {
	session_id: "4e6211cd-2707-4fc2-9a26-23a3620f3462",
	cwd: "/tmp/x",
	permission_mode: "acceptEdits",
	hook_event_name: "PreToolUse",
	tool_name: "Bash",
	tool_input: { command: "echo hei", description: "Run echo command with hei" },
	tool_use_id: "toolu_01Uyh7xCB2BsaYuYyVrcgyaX",
};

const STOP = {
	session_id: "4e6211cd-2707-4fc2-9a26-23a3620f3462",
	cwd: "/tmp/x",
	hook_event_name: "Stop",
	stop_hook_active: false,
	last_assistant_message: `Kodeordet er PAI-MARKOR-7431. ${"Fyll på så svaret passerer terskelen. ".repeat(4)}`,
	background_tasks: [],
};

// ---------------------------------------------------------------------------
// BATCH 7 — skjemaene under er hentet fra Claude Code 2.1.278s EGNE zod-
// definisjoner, lest ut av binæren 2026-09-22:
//
//   grep -a -o -E 'hook_event_name:R\("[A-Za-z]+"\)[^}]{0,400}' "$(which claude)"
//
// Det er parseren som avviser payloaden hvis et navn er feil, altså en
// sterkere kilde enn dokumentasjon. Kommandoen står her så neste oppgradering
// kan etterprøves på ett minutt framfor med en probe-plugin.
// ---------------------------------------------------------------------------

const SESSION_END = {
	session_id: "4e6211cd-2707-4fc2-9a26-23a3620f3462",
	cwd: "/tmp/x",
	hook_event_name: "SessionEnd",
	reason: "prompt_input_exit",
};

const POST_TOOL_USE = {
	session_id: "4e6211cd-2707-4fc2-9a26-23a3620f3462",
	cwd: "/tmp/x",
	hook_event_name: "PostToolUse",
	tool_name: "Write",
	tool_input: { file_path: "/tmp/x/PRD.md", content: "# PRD" },
	tool_response: { filePath: "/tmp/x/PRD.md", success: true },
	tool_use_id: "toolu_01Uyh7xCB2BsaYuYyVrcgyaX",
	duration_ms: 12,
};

const POST_TOOL_USE_FAILURE = {
	session_id: "4e6211cd-2707-4fc2-9a26-23a3620f3462",
	cwd: "/tmp/x",
	hook_event_name: "PostToolUseFailure",
	tool_name: "Bash",
	tool_input: { command: "false" },
	tool_use_id: "toolu_01Uyh7xCB2BsaYuYyVrcgyaX",
	error: "Command exited with code 1",
	is_interrupt: false,
	duration_ms: 8,
};

const SUBAGENT_START = {
	session_id: "4e6211cd-2707-4fc2-9a26-23a3620f3462",
	cwd: "/tmp/x",
	hook_event_name: "SubagentStart",
	agent_id: "agent_01HZX",
	agent_type: "Explore",
};

const SUBAGENT_STOP = {
	session_id: "4e6211cd-2707-4fc2-9a26-23a3620f3462",
	cwd: "/tmp/x",
	hook_event_name: "SubagentStop",
	stop_hook_active: false,
	agent_id: "agent_01HZX",
	agent_transcript_path: "/home/user/.claude/projects/-tmp-x/agent_01HZX.jsonl",
	agent_type: "Explore",
	last_assistant_message: "Fant tre treff i lib/paths.ts.",
	background_tasks: [],
};

const POST_COMPACT = {
	session_id: "4e6211cd-2707-4fc2-9a26-23a3620f3462",
	cwd: "/tmp/x",
	hook_event_name: "PostCompact",
	trigger: "auto",
	compact_summary: "Brukeren ba om en gjennomgang av adapteren.",
};

const PERMISSION_DENIED = {
	session_id: "4e6211cd-2707-4fc2-9a26-23a3620f3462",
	cwd: "/tmp/x",
	hook_event_name: "PermissionDenied",
	tool_name: "Bash",
	tool_input: { command: "rm -rf /" },
	tool_use_id: "toolu_01Uyh7xCB2BsaYuYyVrcgyaX",
	reason: "User denied permission",
};

describe("feltnavn som er MÅLT, ikke lest ut av dokumentasjon", () => {
	test("UserPromptSubmit henter teksten fra `prompt`", () => {
		const [hendelse] = tilKjernehendelser(USER_PROMPT_SUBMIT);
		expect(hendelse.type).toBe("user.message");
		expect((hendelse as { text: string }).text).toBe(USER_PROMPT_SUBMIT.prompt);
	});

	test("Stop henter teksten fra `last_assistant_message`", () => {
		const [hendelse] = tilKjernehendelser(STOP);
		expect(hendelse.type).toBe("assistant.message");
		expect((hendelse as { text: string }).text).toBe(STOP.last_assistant_message);
	});

	test("PreToolUse henter verktøy fra `tool_name` og args fra `tool_input`", () => {
		const [hendelse] = tilKjernehendelser(PRE_TOOL_USE) as [
			{ type: string; tool: string; args: Record<string, unknown> },
		];
		expect(hendelse.type).toBe("tool.before");
		expect(hendelse.tool).toBe("Bash");
		expect(hendelse.args.command).toBe("echo hei");
	});

	test("sesjons-ID leses fra snake_case `session_id`, ikke camelCase", () => {
		// Speilvendingen som faktisk fanger feilen: OpenCode bruker
		// `sessionID`. Leser adapteren det navnet, blir sessionId tom, og
		// ALT nedenfor havner under `cc_unknown` — arbeidssporing, dedupe og
		// meldingsbuffer for alle økter i samme skuff. H-04 var nettopp
		// «fem steder hentet sessionID fra feil kilde».
		const medCamel = { ...PRE_TOOL_USE, sessionID: "feil-id" } as Record<string, unknown>;
		delete medCamel.session_id;
		const [hendelse] = tilKjernehendelser(medCamel);
		expect(hendelse.sessionId).toBe("");
		expect(hendelse.sessionId).not.toBe("feil-id");
	});

	test("sessionId er aldri `unknown` når motoren oppgir én", () => {
		for (const payload of [SESSION_START, USER_PROMPT_SUBMIT, PRE_TOOL_USE, STOP]) {
			for (const hendelse of tilKjernehendelser(payload)) {
				expect(hendelse.sessionId).toBe(SESSION_START.session_id);
				expect(hendelse.sessionId).not.toBe("unknown");
			}
		}
	});
});

describe("sesjonsnøkkelen bygges av kjernen, ikke for hånd", () => {
	test("nøkkelen er cc-prefikset og aldri lik rå ID", () => {
		const [hendelse] = tilKjernehendelser(PRE_TOOL_USE);
		expect(hendelse.sessionKey).toBe(sessionKeyFor("claude", PRE_TOOL_USE.session_id));
		expect(hendelse.sessionKey).not.toBe(hendelse.sessionId);
		expect(hendelse.sessionKey.startsWith("cc_")).toBe(true);
	});

	test("samme rå ID under OpenCode v2 gir en ANNEN nøkkel", () => {
		// De to motorene deler MEMORY-tre. Kolliderte nøklene, kunne den ene
		// overskrevet den andres tilstand uten noe spor.
		const [hendelse] = tilKjernehendelser(PRE_TOOL_USE);
		expect(hendelse.sessionKey).not.toBe(sessionKeyFor("opencode2", PRE_TOOL_USE.session_id));
	});
});

describe("SessionStart er to kjernehendelser", () => {
	test("gir session.start FØR context.build", () => {
		// Rekkefølgen er bindende: session.start kjører reaperen og rydder
		// foreldet tilstand, og det skal være gjort før konteksten bygges.
		const typer = tilKjernehendelser(SESSION_START).map((h) => h.type);
		expect(typer).toEqual(["session.start", "context.build"]);
	});

	test("gir begge uansett `source`", () => {
		// Kun "startup" er målt. Gating på en enum vi ikke har sett ville gitt
		// en sesjon uten PAI-kontekst hvis en verdi het noe annet enn antatt.
		for (const source of ["startup", "resume", "clear", "compact", "noe-nytt"]) {
			expect(tilKjernehendelser({ ...SESSION_START, source })).toHaveLength(2);
		}
	});
});

describe("utdataformen er MÅLT mot binæren", () => {
	test("deny bruker permissionDecision «deny», ikke legacy-feltet", () => {
		const ut = JSON.parse(
			tilHookUtdata("PreToolUse", { permission: "deny", reason: "farlig", message: "farlig" })
		);
		expect(ut.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(ut.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(ut.hookSpecificOutput.permissionDecisionReason).toContain("farlig");
		// Det gamle toppnivåfeltet er `approve|block`. Blandes de, tolkes
		// svaret som legacy og begrunnelsen når aldri modellen.
		expect(ut.decision).toBeUndefined();
	});

	test("ask heter «ask» — ikke «request», som planen anga", () => {
		// Binærens egen hjelpetekst, målt 2026-09-21:
		//   «- `permissionDecision` - "allow", "deny", or "ask" (PreToolUse only)»
		const ut = JSON.parse(tilHookUtdata("PreToolUse", { permission: "ask", reason: "usikker" }));
		expect(ut.hookSpecificOutput.permissionDecision).toBe("ask");
		expect(ut.hookSpecificOutput.permissionDecision).not.toBe("request");
	});

	test("«allow» sendes ALDRI — tillatelse er brukerens domene", () => {
		// Et eksplisitt allow ville overstyrt brukerens egne permission-regler
		// og gjort PAI til en omgåelse av dem.
		expect(tilHookUtdata("PreToolUse", { permission: "allow" })).toBe("{}");
		expect(tilHookUtdata("PreToolUse", {})).toBe("{}");
	});

	test("kontekst blir ÉN streng, ikke en liste", () => {
		// Kjernen gir liste fordi OpenCode tar `system.push(...)`. Claude Code
		// tar én streng — sendes lista rå, forsvinner konteksten i stillhet.
		const ut = JSON.parse(
			tilHookUtdata("SessionStart", { additionalContext: ["første", "andre"] })
		);
		expect(typeof ut.hookSpecificOutput.additionalContext).toBe("string");
		expect(ut.hookSpecificOutput.additionalContext).toBe("første\n\nandre");
		expect(ut.hookSpecificOutput.hookEventName).toBe("SessionStart");
	});

	test("Stop svarer tomt — ren observasjon", () => {
		expect(tilHookUtdata("Stop", { notes: ["tab-state"] })).toBe("{}");
	});

	test("alt som produseres er gyldig JSON", () => {
		const tilfeller: Array<[string, Parameters<typeof tilHookUtdata>[1]]> = [
			["PreToolUse", {}],
			["PreToolUse", { permission: "deny", reason: "x" }],
			["PreToolUse", { permission: "ask" }],
			["SessionStart", {}],
			["SessionStart", { additionalContext: ['med "hermetegn" og \n linjeskift'] }],
			["UserPromptSubmit", { additionalContext: ["a"] }],
			["Stop", {}],
			["Ukjent", { permission: "deny" }],
		];
		for (const [navn, res] of tilfeller) {
			expect(() => JSON.parse(tilHookUtdata(navn, res))).not.toThrow();
		}
	});
});

describe("sammenslåingen lar ikke en blokkering forsvinne", () => {
	test("deny vinner over et senere tomt resultat", () => {
		const samlet = slåSammen([{ permission: "deny", reason: "farlig" }, {}]);
		expect(samlet.permission).toBe("deny");
		expect(samlet.reason).toBe("farlig");
	});

	test("deny vinner over ask uansett rekkefølge", () => {
		expect(slåSammen([{ permission: "ask" }, { permission: "deny" }]).permission).toBe("deny");
		expect(slåSammen([{ permission: "deny" }, { permission: "ask" }]).permission).toBe("deny");
	});

	test("kontekst fra begge hendelsene blir med", () => {
		const samlet = slåSammen([{ notes: ["a"] }, { additionalContext: ["ctx"], notes: ["b"] }]);
		expect(samlet.additionalContext).toEqual(["ctx"]);
		expect(samlet.notes).toEqual(["a", "b"]);
	});
});

describe("hurtigutgangen speiler kjernen, den finner ikke på egne regler", () => {
	test("terskelen er den samme som i pai-core/dispatch/message.ts", () => {
		// Duplisert konstant med vilje — å importere den ville dratt inn
		// modulgrafen hurtigutgangen finnes for å unngå. Derfor låses de her.
		const kilde = readFileSync(join(ROT, ".opencode/pai-core/dispatch/message.ts"), "utf-8");
		const treff = kilde.match(/const ASSISTANT_MIN_LENGTH = (\d+)/);
		expect(treff).not.toBeNull();
		expect(Number(treff?.[1])).toBe(ASSISTENT_MIN_LENGDE);
	});

	test("Stop hoppes over på nøyaktig samme grense som kjernen (<=, ikke <)", () => {
		const akkurat = "x".repeat(ASSISTENT_MIN_LENGDE);
		const énTil = "x".repeat(ASSISTENT_MIN_LENGDE + 1);
		expect(hurtigutgang({ hook_event_name: "Stop", last_assistant_message: akkurat })).toBe(
			"kort-assistentsvar"
		);
		expect(hurtigutgang({ hook_event_name: "Stop", last_assistant_message: énTil })).toBeNull();
	});

	test("PreToolUse har INGEN hurtigutgang — vakten må se hvert kall", () => {
		// En filtrering her ville vært et hull i sikkerhetsvakten, ikke en
		// optimalisering.
		expect(hurtigutgang(PRE_TOOL_USE)).toBeNull();
		expect(hurtigutgang({ hook_event_name: "PreToolUse", tool_name: "Read" })).toBeNull();
	});

	test("tom prompt hoppes over, ikke-tom slipper gjennom", () => {
		expect(hurtigutgang({ hook_event_name: "UserPromptSubmit", prompt: "   " })).toBe(
			"tom-prompt"
		);
		expect(hurtigutgang(USER_PROMPT_SUBMIT)).toBeNull();
	});

	test("SessionStart hoppes ALDRI over — den kjører reaperen", () => {
		expect(hurtigutgang(SESSION_START)).toBeNull();
	});

	test("hendelser adapteren ikke dekker koster ingen modullasting", () => {
		// Claude Code har 33 hook-hendelser; PAI kobler tretten. Resten skal
		// koste bun-oppstart alene. Navnene under er ekte og bevisst utelatt:
		// de har ingen PAI-tilstand å røre.
		for (const navn of ["Notification", "PreModelSwitch", "TeammateIdle", "MessageDisplay"]) {
			expect(hurtigutgang({ hook_event_name: navn })).toContain("uhåndtert-hendelse");
		}
	});
});

describe("kapabiliteter, ikke harness-sjekker", () => {
	test("observability er AV under Claude Code", () => {
		expect(capabilitiesFor("claude").observability).toBe(false);
	});

	test("observability-emitteren spør om kapabilitet, ikke bare miljøvariabel", () => {
		// Uten dette forsøker hver eneste Claude-hook en TCP-tilkobling til en
		// server som ikke finnes, i en prosess som skal leve i millisekunder.
		const kilde = utenKommentarer(
			readFileSync(join(ROT, ".opencode/pai-core/handlers/observability-emitter.ts"), "utf-8")
		);
		expect(kilde).toContain("capabilitiesFor");
		// Og den må være en funksjon: en modulkonstant evalueres før adapteren
		// rekker å sette miljøet sitt. Det er feilklassen fra M-04.
		expect(kilde).not.toMatch(/const ENABLED = /);
	});
});

describe("reaperen er koblet inn — den ENESTE teardown-veien i batch 6", () => {
	const entry = readFileSync(join(ROT, "claude-plugin/bin/pai-hook.ts"), "utf-8");

	test("dispatcheren kaller reapOrphanedWorkSessions", () => {
		// Dette hullet fantes i første utkast av batch 6, og røyktesten avslørte
		// det: uten kallet blir INGEN Claude-arbeidsøkt noen gang fullført.
		// `SessionEnd` kobles først i batch 7, så reaperen er hele teardown-
		// kjeden fram til da — og den er uansett korrekthetsgarantien, siden
		// ingen motor varsler ved SIGKILL.
		expect(entry).toContain("reapOrphanedWorkSessions");
	});

	test("den kalles kun på SessionStart", () => {
		// Ikke på hvert verktøykall: reaperen leser hele STATE/ og kan kjøre
		// full teardown per foreldreløs økt. På PreToolUse ville det betydd den
		// jobben på hvert eneste verktøykall.
		const kropp = utenKommentarer(entry);
		const iVakt = kropp.indexOf('hendelsesnavn === "SessionStart"');
		const iKall = kropp.indexOf("reapOrphanedWorkSessions()");
		expect(iVakt).toBeGreaterThan(-1);
		expect(iKall).toBeGreaterThan(iVakt);
	});

	test("den ligger innenfor vaktbikkja", () => {
		// Et stort etterslep skal ikke kunne henge oppstarten. Kallet må derfor
		// stå i `arbeid`-promiset som `Promise.race` dekker, ikke før det.
		const kropp = utenKommentarer(entry);
		const iArbeid = kropp.indexOf("const arbeid =");
		const iKall = kropp.indexOf("reapOrphanedWorkSessions()");
		const iRace = kropp.indexOf("Promise.race");
		expect(iArbeid).toBeLessThan(iKall);
		expect(iKall).toBeLessThan(iRace);
	});
});

describe("adapteren forblir tynn", () => {
	const filer = [
		"claude-plugin/bin/pai-hook.ts",
		"claude-plugin/src/bootstrap.ts",
		"claude-plugin/src/owner.ts",
		"claude-plugin/src/adapter/in.ts",
		"claude-plugin/src/adapter/out.ts",
		"claude-plugin/src/adapter/routes.ts",
	];

	test("hele Claude-adapteren er under 550 kodelinjer", () => {
		// Batch 4 flyttet logikken til pai-core. Uten en vaktpost siger den
		// tilbake én bekvemmelighetsimport om gangen — nøyaktig slik
		// `pai-unified.ts` vokste til 1242 linjer.
		//
		// Taket er en SKRALLE, ikke en målestokk: det flyttes når
		// hendelsesflaten flyttes, og bare da. Batch 6 dekket fire hendelser
		// på ~230 linjer; batch 7 dekker tretten på ~475. Veksten er
		// oversettelse — tretten objektlitteraler med feltnavn — og det er
		// nettopp den koden som HØRER hjemme her. Krever neste batch et nytt
		// hopp uten at hendelseslista vokser, er det logikk som har sneket seg
		// inn, og da skal denne testen falle.
		let linjer = 0;
		for (const fil of filer) {
			linjer += utenKommentarer(readFileSync(join(ROT, fil), "utf-8"))
				.split("\n")
				.filter((l) => l.trim().length > 0).length;
		}
		expect(linjer).toBeLessThan(550);
	});

	test("rutetabellen importerer ingenting", () => {
		// Hele poenget: den konsulteres FØR kjernen lastes. En import her
		// koster modulgrafen på hvert eneste verktøykall.
		const kilde = utenKommentarer(readFileSync(join(ROT, "claude-plugin/src/adapter/routes.ts"), "utf-8"));
		expect(kilde).not.toMatch(/^\s*import\s/m);
	});

	test("bare ÉN fil rører stdout", () => {
		for (const fil of filer) {
			const kilde = utenKommentarer(readFileSync(join(ROT, fil), "utf-8"));
			if (fil.endsWith("bin/pai-hook.ts")) continue;
			// stdout er protokollen: enhver byte som ikke er sluttsvaret
			// ødelegger JSON-parsingen på den andre siden.
			expect(kilde).not.toContain("process.stdout");
			expect(kilde).not.toContain("console.log(");
		}
	});

	test("oppstartsvakten står som FØRSTE import i entry-fila", () => {
		// ESM evaluerer importer i rekkefølge. Flyttes linja ned, settes
		// PAI_HARNESS etter at file-logger er brukt, og de to motorene skriver
		// i samme loggfil — der `clearLog()` sletter den andres logg.
		const kilde = readFileSync(join(ROT, "claude-plugin/bin/pai-hook.ts"), "utf-8");
		const førsteImport = kilde.split("\n").find((l) => l.startsWith("import "));
		expect(førsteImport).toContain("src/bootstrap");
	});

	test("hooks.json peker kun på bin/pai-hook", () => {
		// Kontrakten batch 12 hviler på: erstattes fila med en kompilert binær
		// på samme sti, trenger ingen installert plugin å reinstalleres.
		const hooks = JSON.parse(readFileSync(join(ROT, "claude-plugin/hooks/hooks.json"), "utf-8"));
		const hendelser = Object.keys(hooks.hooks);
		expect(hendelser.sort()).toEqual([
			"PermissionDenied",
			"PermissionRequest",
			"PostCompact",
			"PostToolUse",
			"PostToolUseFailure",
			"PreCompact",
			"PreToolUse",
			"SessionEnd",
			"SessionStart",
			"Stop",
			"SubagentStart",
			"SubagentStop",
			"UserPromptSubmit",
		]);
		for (const oppføringer of Object.values(hooks.hooks) as Array<
			Array<{ hooks: Array<{ command: string }> }>
		>) {
			for (const oppføring of oppføringer) {
				for (const h of oppføring.hooks) {
					// biome-ignore lint/suspicious/noTemplateCurlyInString: ${CLAUDE_PLUGIN_ROOT} er en literal motoren substituerer — den validerer selv formen ^\$\{CLAUDE_PLUGIN_ROOT\}/bin/([^/\\]+)$ (målt i batch 9)
					expect(h.command).toBe("${CLAUDE_PLUGIN_ROOT}/bin/pai-hook");
				}
			}
		}
	});
});

describe("eierprosessen — den reaperen sjekker liveness på", () => {
	/**
	 * Dette er batch 6s farligste enkeltdetalj.
	 *
	 * Claude Code kjører ÉN PROSESS PER HOOK-EVENT. Skriver `setCurrentWorkPath`
	 * sin egen `process.pid`, er eieren død millisekunder senere, og neste
	 * `SessionStart` reaper en økt brukeren fortsatt sitter i. Handoveren sier
	 * det rett ut: en økt som fullføres for sent er kosmetisk, én som fullføres
	 * mens den er i bruk ødelegger arbeid.
	 */
	const opprinnelig = { pid: process.env.PAI_OWNER_PID, start: process.env.PAI_OWNER_PID_START };

	afterEach(() => {
		// Eksplisitt gjenoppretting: `PAI_OWNER_PID` leses av hvert kall, og en
		// lekkasje herfra ville satt eier-PID for alle senere testfiler i samme
		// bun-prosess.
		if (opprinnelig.pid === undefined) delete process.env.PAI_OWNER_PID;
		else process.env.PAI_OWNER_PID = opprinnelig.pid;
		if (opprinnelig.start === undefined) delete process.env.PAI_OWNER_PID_START;
		else process.env.PAI_OWNER_PID_START = opprinnelig.start;
	});

	test("uten PAI_OWNER_PID brukes egen pid — OpenCode-oppførselen, uendret", () => {
		delete process.env.PAI_OWNER_PID;
		expect(ownerProcess().pid).toBe(process.pid);
	});

	test("med PAI_OWNER_PID brukes DEN, ikke vår egen", () => {
		// Speilvendingen som fanger feilen: er det fortsatt `process.pid`, har
		// noen «forenklet» bort hele mekanismen.
		process.env.PAI_OWNER_PID = String(process.ppid);
		expect(ownerProcess().pid).toBe(process.ppid);
		expect(ownerProcess().pid).not.toBe(process.pid);
	});

	test("ugyldig verdi gir INGEN pid — ikke en pid vi vet er død", () => {
		// Adapterens måte å si «jeg fant ingen eier jeg stoler på». Kjernen
		// faller da tilbake på alderssjekken i `isOwnerAlive`: treg, men trygg.
		for (const verdi of ["ukjent", "0", "-1", "abc"]) {
			process.env.PAI_OWNER_PID = verdi;
			expect(ownerProcess().pid).toBeUndefined();
		}
	});

	test("finnMotorprosess velger aldri hook-prosessen selv", () => {
		// Dybde 0 er oss. Ville vi returnert den, hadde hele poenget falt bort.
		const funn = finnMotorprosess();
		if (funn) expect(funn.pid).not.toBe(process.pid);
	});

	test("finnMotorprosess svarer null framfor å gjette når slekten tar slutt", () => {
		// pid 1 er init. Over den finnes ingen motor, og `null` er da et gyldig
		// svar — ikke en feil.
		expect(finnMotorprosess(1)).toBeNull();
	});
});

describe("skill-restore er slettet, ikke bare gatet", () => {
	test("session.start har ingen vei til `git restore` på SKILL.md", () => {
		// Den reparerte at v1 skrev om SKILL.md ved lasting. Etter H-20 virket
		// den, og under Claude eller v2 ville den slettet ukommitterte
		// skill-redigeringer ved hver oppstart; der var den derfor gatet av.
		// Med v1 borte er det ingen motor igjen som trenger den.
		const rot = join(import.meta.dir, "..", ".opencode", "pai-core");
		expect(existsSync(join(rot, "handlers", "skill-restore.ts"))).toBe(false);
		expect(readFileSync(join(rot, "dispatch", "session.ts"), "utf-8")).not.toContain("skill-restore");
	});
});

// ===========================================================================
// BATCH 7 — full hendelsesdekning
// ===========================================================================

describe("batch 7: feltnavn, med speilvendingen som faktisk fanger feil", () => {
	test("SessionEnd blir `exit`, og motorens reason følger med som detail", () => {
		const [hendelse] = tilKjernehendelser(SESSION_END) as [
			{ type: string; reason: string; detail?: string },
		];
		expect(hendelse.type).toBe("session.end");
		// Alle fem verdiene i motorens enum betyr «denne økten er over».
		// Kjernens `reason` sier hvem som OPPDAGET slutten, ikke hvorfor den
		// kom — `reaped` er det andre alternativet, og det skal reaperen eie.
		expect(hendelse.reason).toBe("exit");
		expect(hendelse.detail).toBe("prompt_input_exit");
		expect(hendelse.reason).not.toBe("prompt_input_exit");
	});

	test("PostToolUse leser `tool_response`, ikke `tool_result`", () => {
		// H-16 om igjen i ny motor: koden leste `output.result` i månedsvis
		// mens resultatet lå i `output.output`, og ingenting feilet — hele
		// fanouten kjørte bare på `undefined`.
		const hendelser = tilKjernehendelser(POST_TOOL_USE) as Array<
			{ type: string; tool: string; args: Record<string, unknown>; result: unknown; output?: unknown }
		>;
		// tool.output first, so the core masks secrets before anything else (#367).
		expect(hendelser.map((h) => h.type)).toEqual(["tool.output", "tool.after"]);
		expect(hendelser[0].output).toEqual(POST_TOOL_USE.tool_response);
		const hendelse = hendelser[1];
		expect(hendelse.type).toBe("tool.after");
		expect(hendelse.tool).toBe("Write");
		expect(hendelse.args.file_path).toBe("/tmp/x/PRD.md");
		expect(hendelse.result).toEqual(POST_TOOL_USE.tool_response);

		const feilNavn = { ...POST_TOOL_USE, tool_result: { noe: "annet" } } as Record<
			string,
			unknown
		>;
		delete feilNavn.tool_response;
		const [, uten] = tilKjernehendelser(feilNavn) as [unknown, { result: unknown }];
		expect(uten.result).toBeUndefined();
	});

	test("PostToolUseFailure bærer `error` og `is_interrupt` hver for seg", () => {
		const [hendelse] = tilKjernehendelser(POST_TOOL_USE_FAILURE) as [
			{ type: string; error: string; isInterrupt?: boolean; callId?: string },
		];
		expect(hendelse.type).toBe("tool.failed");
		expect(hendelse.error).toBe("Command exited with code 1");
		expect(hendelse.isInterrupt).toBe(false);
		expect(hendelse.callId).toBe(POST_TOOL_USE_FAILURE.tool_use_id);
	});

	test("SubagentStart/Stop henter agenttypen fra MOTOREN, ikke fra args", () => {
		// Dette er hele grunnen til at hendelsene er verdt en hook-prosess.
		// Task-veien utleder typen av `args.subagent_type` og rapporterer
		// `unknown` på OpenCode av årsaker ingen har funnet; her kommer den
		// fra motoren og KAN ikke bli `unknown`.
		const [start] = tilKjernehendelser(SUBAGENT_START) as [
			{ type: string; agentId: string; agentType: string },
		];
		expect(start.type).toBe("agent.start");
		expect(start.agentId).toBe("agent_01HZX");
		expect(start.agentType).toBe("Explore");
		expect(start.agentType).not.toBe("unknown");

		const [stopp] = tilKjernehendelser(SUBAGENT_STOP) as [
			{ type: string; agentType: string; output: string; transcriptPath?: string },
		];
		expect(stopp.type).toBe("agent.stop");
		expect(stopp.agentType).toBe("Explore");
		// Teksten kommer ferdig, ikke parset ut av et verktøyresultat.
		expect(stopp.output).toBe(SUBAGENT_STOP.last_assistant_message);
		expect(stopp.transcriptPath).toBe(SUBAGENT_STOP.agent_transcript_path);
	});

	test("SubagentStop leser IKKE `subagent_type` — det feltet finnes ikke her", () => {
		const medFeilNavn = { ...SUBAGENT_STOP, subagent_type: "feil" } as Record<string, unknown>;
		delete medFeilNavn.agent_type;
		const [hendelse] = tilKjernehendelser(medFeilNavn) as [{ agentType: string }];
		expect(hendelse.agentType).toBe("");
		expect(hendelse.agentType).not.toBe("feil");
	});

	test("PostCompact bærer trigger og sammendrag", () => {
		const [hendelse] = tilKjernehendelser(POST_COMPACT) as [
			{ type: string; trigger?: string; summary?: string },
		];
		expect(hendelse.type).toBe("session.compacted");
		expect(hendelse.trigger).toBe("auto");
		expect(hendelse.summary).toBe(POST_COMPACT.compact_summary);
	});

	test("en trigger utenfor enumen blir undefined, ikke videresendt rå", () => {
		const [hendelse] = tilKjernehendelser({ ...POST_COMPACT, trigger: "noe-nytt" }) as [
			{ trigger?: string },
		];
		expect(hendelse.trigger).toBeUndefined();
	});

	test("Stop bærer `stop_hook_active` videre som løkkevakt", () => {
		const [vanlig] = tilKjernehendelser(STOP) as [{ continuedAfterBlock?: boolean }];
		expect(vanlig.continuedAfterBlock).toBe(false);

		const [fortsettelse] = tilKjernehendelser({ ...STOP, stop_hook_active: true }) as [
			{ continuedAfterBlock?: boolean },
		];
		expect(fortsettelse.continuedAfterBlock).toBe(true);

		// Mangler feltet, er `undefined` riktigere enn `false`: kjernen leser
		// begge som «ikke en fortsettelse», men skillet holder «motoren sa
		// ikke fra» adskilt fra «motoren sa nei».
		const utenFelt = { ...STOP } as Record<string, unknown>;
		delete utenFelt.stop_hook_active;
		const [uten] = tilKjernehendelser(utenFelt) as [{ continuedAfterBlock?: boolean }];
		expect(uten.continuedAfterBlock).toBeUndefined();
	});
});

describe("observasjonshendelsene gir logglinje og INGEN kjernehendelse", () => {
	test("PermissionDenied, PermissionRequest og PreCompact oversettes til tom liste", () => {
		// Sikkerhetsvakten har allerede sagt sitt i PreToolUse, med de samme
		// mønstrene og de samme argumentene. En ny runde ville gitt samme svar
		// til prisen av nok en kjernelasting.
		for (const payload of [
			PERMISSION_DENIED,
			{ ...PERMISSION_DENIED, hook_event_name: "PermissionRequest" },
			{ session_id: "x", hook_event_name: "PreCompact", trigger: "manual" },
		]) {
			expect(tilKjernehendelser(payload)).toHaveLength(0);
		}
	});

	test("men de slipper gjennom hurtigutgangen, ellers hadde loggen forsvunnet", () => {
		for (const navn of ["PermissionRequest", "PermissionDenied", "PreCompact"]) {
			expect(hurtigutgang({ hook_event_name: navn })).toBeNull();
		}
	});
});

describe("PostToolUse is never short-circuited: the core masks every tool's output (#367)", () => {
	test("Read, Grep, Glob and WebFetch reach the core, like Bash and Write", () => {
		for (const tool of ["Read", "Grep", "Glob", "WebFetch", "Bash", "Write", "mcp__plugin_pai_pai__x"]) {
			expect(hurtigutgang({ hook_event_name: "PostToolUse", tool_name: tool }), tool).toBeNull();
		}
	});

	test("Claude Codes subagent-verktøy heter Agent, og kjernen kjenner navnet", () => {
		// MÅLT 2026-09-22 ende-til-ende: verktøyet i en Claude-økt heter
		// `Agent`. Både planen og koden antok `Task`, og konsekvensen var
		// stille — `algorithm-tracker` talte null spawns og
		// `agent-execution-guard` kjørte aldri.
		expect(hurtigutgang({ hook_event_name: "PostToolUse", tool_name: "Agent" })).toBeNull();
		expect(isSubagentTool("Agent")).toBe(true);
		expect(isSubagentTool("mcp_task")).toBe(true);
		// Og speilvendingen: et eksakt navn, ikke substring. Ellers ville
		// `AgentOutput` og enhver annen «agent»-i-navnet blitt fanget som en
		// subagent som ikke finnes.
		expect(isSubagentTool("AgentOutput")).toBe(false);
	});

	test("hvert skrivende verktøy kommer gjennom hurtigutgangen til PRD-synken (K58)", () => {
		// Kjernen etterbehandler `SKRIVEVERKTØY` i tillegg til substring-testen.
		// Et navn som mangler i rutetabellen, forkastes her, og synken og
		// plan-fangsten slutter stille å se det.
		for (const navn of SKRIVEVERKTØY) {
			expect(hurtigutgang({ hook_event_name: "PostToolUse", tool_name: navn }), navn).toBeNull();
		}
		expect(hurtigutgang({ hook_event_name: "PostToolUse", tool_name: "NotebookEdit" })).toBeNull();
	});

	test("SubagentStop hoppes ALDRI over på tomt svar — statusen ville løyet", () => {
		// Motsatt av `Stop`. En subagent som svarte tomt er fortsatt FERDIG, og
		// uten hendelsen ville oppføringen stått som `running` for alltid.
		expect(
			hurtigutgang({ hook_event_name: "SubagentStop", last_assistant_message: "" })
		).toBeNull();
	});

	test("et avbrutt verktøykall koster ingen modullasting", () => {
		expect(hurtigutgang({ ...POST_TOOL_USE_FAILURE, is_interrupt: true })).toBe(
			"avbrutt-av-bruker"
		);
		expect(hurtigutgang(POST_TOOL_USE_FAILURE)).toBeNull();
	});
});

describe("subagent-fangsten går ÉN vei, ikke to", () => {
	// Begge testene under kaller `dispatch` med `tool.after`, og agent-capture
	// SKREV da til disk. Uten en temp-PAI_HOME havner fangsten i brukerens
	// EKTE MEMORY-tre — målt 2026-09-23: `STATE/algorithm-state-dobbel-test.json`
	// ble skrevet på nytt ved hver `bun test`. Fila er gitignorert, så den nådde
	// aldri historikken, men den forsøplet STATE. `getPaiHome()` leser
	// variabelen ved HVERT kall, så det holder å sette den rundt blokka.
	let tidligere: string | undefined;
	beforeAll(() => {
		tidligere = process.env.PAI_HOME;
		process.env.PAI_HOME = mkdtempSync(join(tmpdir(), "pai-dobbel-"));
	});
	afterAll(() => {
		if (tidligere === undefined) delete process.env.PAI_HOME;
		else process.env.PAI_HOME = tidligere;
	});

	const felles = {
		sessionId: "dobbel-test",
		sessionKey: sessionKeyFor("claude", "dobbel-test"),
		at: Date.now(),
		cwd: "/tmp",
		tool: "Task",
		args: { subagent_type: "Explore", description: "søk" },
		result: "ferdig",
	} as const;

	test("under Claude hopper Task-grenen i tool.after over", async () => {
		// Claude Code fyrer BÅDE PostToolUse på Task OG SubagentStart/Stop.
		// Uten porten fanges hver subagent to ganger, i to hook-prosesser som
		// ikke deler minne og derfor ikke kan dedupe hverandre.
		const resultat = await dispatch({ ...felles, harness: "claude", type: "tool.after" });
		expect(resultat.notes).toContain("agent-capture:egen-hendelse");
		expect(resultat.notes).not.toContain("agent-captured");
	});

	test("under v2 hopper den også over — `agent.*` eier fangsten der også", async () => {
		// v1s Task-vei var den eneste som fanget fra verktøyresultatet, og den
		// er slettet. Kommer den tilbake, fanges hver v2-subagent to ganger.
		const resultat = await dispatch({
			...felles,
			harness: "opencode2",
			sessionKey: sessionKeyFor("opencode2", "dobbel-test"),
			tool: "subagent",
			type: "tool.after",
		});
		expect(resultat.notes).toContain("agent-capture:egen-hendelse");
		expect(resultat.notes).not.toContain("agent-captured");
	});
});

describe("turblokkering: en ANNEN utdataform enn verktøyblokkering", () => {
	test("Stop bruker toppnivå decision/reason, ikke hookSpecificOutput", () => {
		// Binæren (2.1.278) tester `decision === "block"` på TOPPNIVÅ og leser
		// `permissionDecisionReason ?? reason ?? ""`. Legges blokkeringen i
		// hookSpecificOutput, skjer ingenting i det hele tatt.
		const ut = JSON.parse(
			tilHookUtdata("Stop", { block: { message: "[PAI ISC] Refleksjonen mangler." } })
		);
		expect(ut.decision).toBe("block");
		expect(ut.reason).toContain("Refleksjonen mangler");
		expect(ut.hookSpecificOutput).toBeUndefined();
	});

	test("uten block er Stop fortsatt ren observasjon", () => {
		expect(tilHookUtdata("Stop", { notes: ["tab-state"] })).toBe("{}");
	});

	test("block er ET ANNET FELT enn permission — ikke gjenbrukt", () => {
		// `permission` gjelder et verktøykall som ikke har kjørt ennå, `block`
		// en tur som er ferdig. De har ulik utdataform i motoren, og ett felt
		// for begge ville tvunget adapteren til å gjette ut fra hendelsesnavnet.
		expect(tilHookUtdata("Stop", { permission: "deny", reason: "x" })).toBe("{}");
		const preToolUse = JSON.parse(
			tilHookUtdata("PreToolUse", { block: { message: "hører ikke hjemme her" } })
		);
		expect(preToolUse.decision).toBeUndefined();
	});

	test("slåSammen mister ikke en blokkering", () => {
		const samlet = slåSammen([{}, { block: { message: "mangler" } }, {}]);
		expect(samlet.block?.message).toBe("mangler");
	});

	test("alt batch 7 produserer er gyldig JSON", () => {
		const tilfeller: Array<[string, Parameters<typeof tilHookUtdata>[1]]> = [
			["Stop", { block: { message: 'med "hermetegn" og \n linjeskift' } }],
			["PostToolUse", { notes: ["a"] }],
			["PostToolUseFailure", {}],
			["SubagentStart", {}],
			["SubagentStop", { notes: ["agent-captured"] }],
			["SessionEnd", { notes: ["work-completed"] }],
			["PostCompact", { notes: ["trigger:auto"] }],
		];
		for (const [navn, res] of tilfeller) {
			expect(() => JSON.parse(tilHookUtdata(navn, res))).not.toThrow();
		}
	});
});

describe("PAI_ISC_ENFORCE — kanalen finnes, men er av som default", () => {
	const opprinnelig = process.env.PAI_ISC_ENFORCE;

	afterEach(() => {
		if (opprinnelig === undefined) delete process.env.PAI_ISC_ENFORCE;
		else process.env.PAI_ISC_ENFORCE = opprinnelig;
	});

	test("kjernen leser flagget, og kun eksakt «block» slår det på", () => {
		// Kildevaktpost: en skrivefeil i miljøet skal ikke kunne slå på
		// håndhevelse, og en «truthy»-sjekk ville gjort nettopp det.
		const kilde = utenKommentarer(
			readFileSync(join(ROT, ".opencode/pai-core/dispatch/message.ts"), "utf-8")
		);
		expect(kilde).toContain("PAI_ISC_ENFORCE");
		expect(kilde).toContain('=== "block"');
		// Og løkkevakten må være en del av betingelsen, ikke en kommentar.
		expect(kilde).toContain("!event.continuedAfterBlock");
	});

	test("adapteren sender aldri en blokkering kjernen ikke ba om", () => {
		// `tilHookUtdata` skal ikke kunne finne på å blokkere selv — hele
		// avgjørelsen er tatt i kjernen, og adapteren oversetter.
		const kilde = utenKommentarer(
			readFileSync(join(ROT, "claude-plugin/src/adapter/out.ts"), "utf-8")
		);
		expect(kilde).not.toContain("PAI_ISC_ENFORCE");
		expect(kilde).toContain("result.block");
	});
});

describe("hver hendelse er FAKTISK koblet, ikke bare oversatt", () => {
	// Hullet i batch 6 var at reaperen aldri ble kalt, og at ingen test fanget
	// det — oversettelsen var riktig, kallet fantes ikke. Vaktpostene under
	// håndhever kjeden hele veien: hooks.json → rutetabell → in.ts → dispatch.
	const hooks = JSON.parse(readFileSync(join(ROT, "claude-plugin/hooks/hooks.json"), "utf-8"));
	const rutetabell = readFileSync(join(ROT, "claude-plugin/src/adapter/routes.ts"), "utf-8");
	const dispatcher = readFileSync(join(ROT, ".opencode/pai-core/index.ts"), "utf-8");

	const KJEDEN: Array<[string, Record<string, unknown>, string | null]> = [
		["SessionEnd", SESSION_END, "session.end"],
		["PostToolUse", POST_TOOL_USE, "tool.after"],
		["PostToolUseFailure", POST_TOOL_USE_FAILURE, "tool.failed"],
		["SubagentStart", SUBAGENT_START, "agent.start"],
		["SubagentStop", SUBAGENT_STOP, "agent.stop"],
		["PostCompact", POST_COMPACT, "session.compacted"],
		["PreCompact", { hook_event_name: "PreCompact", trigger: "auto" }, null],
		["PermissionRequest", { hook_event_name: "PermissionRequest", tool_name: "Bash" }, null],
		["PermissionDenied", PERMISSION_DENIED, null],
	];

	for (const [hook, payload, kjernetype] of KJEDEN) {
		test(`${hook}: registrert i hooks.json`, () => {
			expect(Object.keys(hooks.hooks)).toContain(hook);
		});

		test(`${hook}: slipper gjennom hurtigutgangen`, () => {
			expect(hurtigutgang(payload)).toBeNull();
		});

		test(`${hook}: nevnt i rutetabellens hendelsessett`, () => {
			expect(rutetabell).toContain(`"${hook}"`);
		});

		if (kjernetype) {
			test(`${hook} → ${kjernetype}, og dispatch har en gren for den`, () => {
				const typer = tilKjernehendelser(payload).map((h) => h.type);
				expect(typer).toContain(kjernetype);
				// Uten denne halvdelen kan oversettelsen være riktig mens
				// hendelsen faller rett i `default` og forsvinner i en note.
				expect(dispatcher).toContain(`case "${kjernetype}":`);
			});
		}
	}
});
