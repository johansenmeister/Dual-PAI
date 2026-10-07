#!/usr/bin/env bun
/**
 * Røyktest av Claude-siden mot den EKTE `claude`-binæren
 *
 * Speilbildet av `Tools/V2Smoke.ts`. Claude Code oppdaterer seg selv og endrer
 * atferd uten å si fra: K-10 var en versjon som begynte å kutte hook-kontekst
 * over 10 000 tegn til 2 KB, og PAI-konteksten nådde ikke modellen, uten at noe
 * ble rødt. Denne røyktesten måler radene i antakelsesregisteret
 * (`.opencode/skills/Utilities/HarnessUpdate/AssumptionRegister.md`)
 * på nytt, og skriver en kvittering når alle holder.
 *
 *   bun Tools/ClaudeSmoke.ts [--modell <alias>] [--behold] [--fixtures] [--rød]
 *
 * Kjøres IKKE i `bun test`, fordi den koster modellkall (abonnementet, ikke en
 * API-nøkkel: `HOME` er den ekte, ellers finner `claude` ikke innloggingen).
 *
 * STEGENE:
 *
 *   0. Uten modell: `claude --version`, `claude plugin validate` uten
 *      advarsler (M-42), og at `--append-system-prompt-file` finnes
 *      (`tolkFlaggsjekk`, samme sjekk som `pai claude doctor`).
 *   K. Gjennom launcheren (`pai.ts --claude -l`), med `PAI_CLAUDE_BIN` pekt på
 *      en wrapper som legger til `-p` og strømformatet. Wrapperen tar en kopi
 *      av kontekstfila og legger et kodeord BAK den, over taket. Står
 *      kodeordet og DA-navnet i svaret, nådde hele systemprompten modellen.
 *      SessionStart skal da ikke injisere noe selv (`PAI_CONTEXT_FILE`).
 *      Hvert verktøy i init-lista skal være klassifisert (K58): et nytt
 *      verktøy kan skrive filer forbi vakten (`Tools/lib/verktoyklasser.ts`).
 *   V. Gjennom launcheren: et farlig skallmønster og en Write til `.ssh/`
 *      blokkeres, begrunnelsen står i verktøyresultatet modellen får, og en
 *      PAI-agent spawnes med det bare navnet (`agent-alias.json` +
 *      `updatedInput`). Verktøyet skal hete `Agent` (M-17).
 *   T. Uten launcheren, med PAI-pluginen og en probe-plugin. Proben injiserer
 *      9 000 og 11 000 tegn i SessionStart, og transkriptet viser om Claude
 *      Code la den største i en fil (`<persisted-output>`) og den minste inn
 *      hel: det er hook-taket, målt uten å spørre modellen (den kan lese fila
 *      med `Read`, så svaret beviser ingenting; derfor `--tools ""`). PAI-
 *      pluginen skal sende den korte beskjeden om `pai --claude`, under taket.
 *      Proben blokkerer også første `Stop` med toppnivå `decision: "block"`,
 *      og modellen skal fortsette.
 *   G. Uten launcheren, med PAI-pluginen og en probe som logger den rå
 *      `PreToolUse`-payloaden: ett kall per verktøyklasse kjernen leser args
 *      fra (skall, write, edit, skill, subagent). Formen sammenlignes med
 *      `tests/fixtures/motor-payloads/claude.json`, og `--fixtures` skriver
 *      fila på nytt (K25, `Tools/lib/gyldne-payloads.ts`).
 *
 * EXEC-FORMEN (M-42) prøves i alle stegene: begge pluginene lastes fra stier
 * med mellomrom (en symlenke til `claude-plugin/` og probens egen katalog).
 * `CLAUDE_PLUGIN_ROOT` følger stien slik den ble gitt (MÅLT 2.1.283), så en
 * hook i skallform ville brukket, og hver hook-sjekk ville falt.
 *
 * NYTT FORSØK (K7). Steg K, V og G kjøres én gang til når modellen ikke gjorde
 * et kall steget måler, aldri når kallet ble gjort og utfallet var feil.
 * Rapporten sier hvilke steg det gjaldt. Første forsøks strøm og logg står igjen
 * som `<steg>.forsøk1.*` (`Tools/lib/roeyktest.ts`).
 *
 * RAPPORTEN (K43). Rød skriver den alt den skrev i terminalen, og hele stderr
 * fra et steg som feilet, til `rapport.txt` i arbeidskatalogen. Siste linje
 * peker på fila. Et steg er rødt ved exit ≠ 0, og ved `is_error: true` i
 * strømmens `result` også når exitkoden er 0 (K46, `stegFeil`).
 *
 * DEN RØDE VEIEN (K46). `--rød` kjører steg K med en modell som ikke finnes
 * (ingen tokens) og sjekker at steget ble kjørt på nytt, ga exit ≠ 0 og
 * skrev rapporten. Grønn når den røde veien holdt; aldri en kvittering. Kjør
 * den etter endringer i røyktesten eller launcheren.
 *
 * ISOLASJON: `PAI_HOME` og loggene under en temp-katalog, så økten aldri havner
 * i det ekte MEMORY-treet (konteksten leses modul-relativt fra repoet, se
 * `pai-core/dispatch/context.ts`). Claude Code skriver transkriptene under
 * `~/.claude/projects/<temp-katalogen>/`, og den katalogen slettes etterpå.
 *
 * KVITTERINGEN. Når hver hook har fyrt og hver sjekk holdt, skrives
 * `.opencode/claude-smoke-kvittering.json` med versjonen `claude` oppga.
 * Selvtesten i `pai --claude`, `pai doctor` og `pai claude doctor` sier fra
 * når den ikke gjelder den pinnede versjonen (`pai.claudeCode` i
 * `.opencode/package.json`, C1). Commit den sammen med pinningen.
 *
 * @module Tools/ClaudeSmoke
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { tolkFlaggsjekk } from "../.opencode/PAI/Tools/pai";
import { adapterHash, claudeAdapterFiler, pinnetClaudeVersjon, skrivClaudeKvittering } from "../.opencode/PAI/Tools/selvtest";
import { anonymiser, gyldenPrompt, gyldenSjekker, plukk, skrivFixture } from "./lib/gyldne-payloads";
import {
	lagKvittering,
	medNyttForsøk,
	type Omkjøring,
	omkjøringslinjer,
	rødVeiSjekker,
	type Steg,
	stegFeil,
	UKJENT_MODELL,
	Utskrift,
} from "./lib/roeyktest";
import { uklassifiserte } from "./lib/verktoyklasser";
import { lesDaNavn } from "./V2Smoke";
import { ASSISTENT_MIN_LENGDE } from "../claude-plugin/src/adapter/routes";

const REPO = join(import.meta.dir, "..");
const PLUGIN = join(REPO, "claude-plugin");
const PAI_TS = join(REPO, ".opencode", "PAI", "Tools", "pai.ts");
const STANDARDMODELL = "haiku";
const TIDSAVBRUDD_MS = 240_000;
const TEMP_PREFIKS = "pai-claudesmoke-";

/** Alt røyktesten skriver, så en rød kjøring kan skrive det til `rapport.txt` (K43). */
const ut = new Utskrift();

/**
 * Claude Codes tak for hook-kontekst (MÅLT 2.1.283, `jDo=1e4`). Samme tall som
 * `CLAUDE_HOOK_TAK` i `claude-plugin/src/adapter/out.ts`, låst av en test.
 * Ikke importert: adapterens bootstrap tar over `console`.
 */
export const HOOK_TAK = 10_000;

/** Hook-hendelsene røyktesten krever å se fyre. `SessionEnd` står bare i hook-loggen. */
export const FYR_KRAV: readonly string[] = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"Stop",
	"SessionEnd",
	"SubagentStart",
	"SubagentStop",
];

/** Blokkeringene fra kjernens vakt begynner slik, i begge motorene. */
const BLOKK_PREFIKS = "[PAI Security]";
const SUBAGENT_SVAR = "CLAUDESMOKE-SVAR";
const STOPP_ORD = "FORTSETT-PINGVIN";
const PROBE_UNDER = { tegn: 9_000, start: "ROYKTEST-UNDER-START", slutt: "ROYKTEST-UNDER-SLUTT" };
const PROBE_OVER = { tegn: 11_000, start: "ROYKTEST-OVER-START", slutt: "ROYKTEST-OVER-SLUTT" };

// ─── Strømmen fra `--output-format stream-json --include-hook-events` ─────

export interface HookSvar {
	/** `SessionStart:startup`, `PreToolUse:Bash`, … */
	navn: string;
	hendelse: string;
	utfall: string;
	utdata: string;
}

export interface Verktøykall {
	id: string;
	navn: string;
	input: Record<string, unknown>;
	/** Teksten modellen fikk tilbake, og om det var en feil. Tom når ingen kom. */
	resultat: string;
	feil: boolean;
}

export interface Strøm {
	hooks: HookSvar[];
	kall: Verktøykall[];
	/** Siste tekst modellen skrev. */
	svar: string;
	/** All tekst modellen skrev, i rekkefølge. */
	tekst: string[];
	sesjon?: string;
	/** Feilen fra `result` når `is_error` er `true`, også ved exit 0 (K46). */
	feil?: string;
	init?: {
		tools: string[];
		agents: string[];
		mcp: { name: string; status: string }[];
		plugins: { name: string; path: string }[];
	};
}

function somTekst(v: unknown): string {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) return v.map((d) => (typeof d === "object" && d && "text" in d ? String(d.text) : somTekst(d))).join("");
	return v === undefined || v === null ? "" : JSON.stringify(v);
}

/**
 * Les strømmen. Linjer som ikke er JSON, hoppes over: launcheren skriver
 * banneret sitt på samme stdout før `claude` starter.
 */
export function lesStrøm(stdout: string): Strøm {
	const s: Strøm = { hooks: [], kall: [], svar: "", tekst: [] };
	const resultater = new Map<string, { tekst: string; feil: boolean }>();
	for (const linje of stdout.split("\n")) {
		let j: Record<string, unknown>;
		try {
			j = JSON.parse(linje) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (typeof j.session_id === "string" && !s.sesjon) s.sesjon = j.session_id;
		if (j.type === "system" && j.subtype === "hook_response") {
			s.hooks.push({
				navn: String(j.hook_name ?? ""),
				hendelse: String(j.hook_event ?? ""),
				utfall: String(j.outcome ?? ""),
				utdata: String(j.output ?? ""),
			});
		} else if (j.type === "system" && j.subtype === "init") {
			s.init = {
				tools: (j.tools as string[]) ?? [],
				agents: (j.agents as string[]) ?? [],
				mcp: (j.mcp_servers as { name: string; status: string }[]) ?? [],
				plugins: (j.plugins as { name: string; path: string }[]) ?? [],
			};
		} else if (j.type === "result" && j.is_error === true) {
			// `subtype` er `success` også da (MÅLT 2.1.283, ukjent modell).
			s.feil = `is_error: ${String(j.result ?? j.terminal_reason ?? "")}`;
		} else if (j.type === "assistant" || j.type === "user") {
			// Bare hovedøkten: en subagents meldinger har `parent_tool_use_id`.
			if (j.parent_tool_use_id) continue;
			const innhold = (j.message as { content?: unknown })?.content;
			if (!Array.isArray(innhold)) continue;
			for (const d of innhold as Record<string, unknown>[]) {
				if (d.type === "text" && j.type === "assistant") {
					s.svar = String(d.text ?? "");
					s.tekst.push(s.svar);
				} else if (d.type === "tool_use") {
					s.kall.push({
						id: String(d.id),
						navn: String(d.name),
						input: (d.input as Record<string, unknown>) ?? {},
						resultat: "",
						feil: false,
					});
				} else if (d.type === "tool_result") {
					resultater.set(String(d.tool_use_id), { tekst: somTekst(d.content), feil: d.is_error === true });
				}
			}
		}
	}
	for (const k of s.kall) {
		const r = resultater.get(k.id);
		if (r) Object.assign(k, { resultat: r.tekst, feil: r.feil });
	}
	return s;
}

/** Kontekstbitene hooks la inn, fra transkriptets `hook_additional_context`-vedlegg. */
export function lesHookKontekst(transkript: string): string[] {
	const ut: string[] = [];
	for (const linje of transkript.split("\n")) {
		try {
			const a = (JSON.parse(linje) as { attachment?: { type?: string; content?: unknown } }).attachment;
			if (a?.type !== "hook_additional_context") continue;
			if (Array.isArray(a.content)) ut.push(...a.content.map(String));
			else if (typeof a.content === "string") ut.push(a.content);
		} catch {}
	}
	return ut;
}

/** `additionalContext` i et hook-svar, eller tom streng. */
export function tilleggskontekst(utdata: string): string {
	try {
		const v = (JSON.parse(utdata) as { hookSpecificOutput?: { additionalContext?: unknown } }).hookSpecificOutput
			?.additionalContext;
		return typeof v === "string" ? v : "";
	} catch {
		return "";
	}
}

// ─── Kjøringene ───────────────────────────────────────────────────────────

interface Oppsett {
	w: string;
	proj: string;
	modell: string;
	claude: string;
	/** `claude-plugin/` gjennom en symlenke med mellomrom i navnet. */
	plugin: string;
	probe: string;
	/** Probe-pluginen for steg G, også med mellomrom i navnet. */
	gylden: string;
	paiHome: string;
}

interface Kjøring {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	tidsavbrudd: boolean;
}

/**
 * Miljøet for et steg: det ekte, minus alt som begynner med `PAI_`. En
 * røyktest startet fra en PAI-økt ville ellers arvet `PAI_CONTEXT_FILE`,
 * `PAI_HOME` og `PAI_HARNESS` derfra.
 *
 * `OPENCODE_DIR` er alltid treet røyktesten ligger i. Uten den løser
 * launcheren `~/.opencode`, og fra et annet tre (jobbklonen, en ekstra klon)
 * bygde den konteksten fra treet symlenken peker på: steg K testet et annet
 * repo enn kvitteringen ble skrevet for (MÅLT 2026-09-27, M-45).
 */
export function miljø(ekstra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("PAI_")) env[k] = v;
	return { ...env, OPENCODE_DIR: join(REPO, ".opencode"), ...ekstra };
}

async function kjør(o: Oppsett, steg: string, args: string[], env: Record<string, string>): Promise<Kjøring> {
	const proc = Bun.spawn(args, { cwd: o.proj, stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
	let tidsavbrudd = false;
	const vakt = setTimeout(() => {
		tidsavbrudd = true;
		proc.kill("SIGKILL");
	}, TIDSAVBRUDD_MS);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
	]);
	await proc.exited;
	clearTimeout(vakt);
	// Strømmen beholdes med arbeidskatalogen, så et rødt steg kan leses etterpå.
	writeFileSync(join(o.w, `${steg}.jsonl`), stdout);
	return { exitCode: proc.exitCode, stdout, stderr, tidsavbrudd };
}

/**
 * Wrapperen launcheren starter i stedet for `claude`. Den legger røyktestens
 * flagg til, og kodeordet bak kontekstfila etter å ha tatt en kopi, så
 * røyktesten kan se at fila faktisk var over taket.
 */
const WRAPPER = `#!/bin/sh
fil=""
forrige=""
for a in "$@"; do
	[ "$forrige" = "--append-system-prompt-file" ] && fil="$a"
	forrige="$a"
done
if [ -n "$fil" ]; then
	cp "$fil" "$SMOKE_W/kontekst-kopi.md"
	printf '\\n\\nRøyktest-kodeord: %s\\n' "$KODEORD" >> "$fil"
fi
exec "$SMOKE_CLAUDE" "$@" --model "$SMOKE_MODELL" --output-format stream-json --verbose --include-hook-events --allowedTools "$SMOKE_TILLAT" -p "$SMOKE_PROMPT"
`;

/** Et steg gjennom launcheren, slik brukeren starter Claude (`pai --claude -l`). */
function launcherSteg(o: Oppsett, steg: string, prompt: string, tillat: string, kodeord = ""): Promise<Kjøring> {
	return kjør(
		o,
		steg,
		[process.execPath, PAI_TS, "--claude", "-l"],
		miljø({
			PAI_CLAUDE_BIN: join(o.w, "claude-p"),
			PAI_CLAUDE_PLUGIN_DIR: o.plugin,
			PAI_HOME: o.paiHome,
			PAI_LOG_PATH: join(o.w, `${steg}.log`),
			SMOKE_W: o.w,
			SMOKE_CLAUDE: o.claude,
			SMOKE_MODELL: o.modell,
			SMOKE_TILLAT: tillat,
			SMOKE_PROMPT: prompt,
			KODEORD: kodeord,
		})
	);
}

/** Probe-pluginen for steg T: to kontekster rundt taket, og én blokkert `Stop`. */
function lagProbe(dir: string): void {
	mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
	mkdirSync(join(dir, "hooks"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(
		join(dir, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "pai-claudesmoke-probe", version: "0.0.1", description: "ClaudeSmoke, steg T" })
	);
	// biome-ignore lint/suspicious/noTemplateCurlyInString: ${CLAUDE_PLUGIN_ROOT} er en literal motoren substituerer
	const hook = (args: string[]) => ({ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/probe", args, timeout: 15 });
	writeFileSync(
		join(dir, "hooks", "hooks.json"),
		JSON.stringify({
			description: "ClaudeSmoke-probe",
			hooks: {
				SessionStart: [{ hooks: [hook([String(PROBE_UNDER.tegn)]), hook([String(PROBE_OVER.tegn)])] }],
				Stop: [{ hooks: [hook([])] }],
			},
		})
	);
	const kontekst = (p: typeof PROBE_UNDER) => ({ tegn: p.tegn, start: p.start, slutt: p.slutt });
	writeFileSync(
		join(dir, "bin", "probe"),
		`#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const p = JSON.parse(await Bun.stdin.text());
const dir = process.env.PROBE_DIR;
appendFileSync(dir + "/probe.jsonl", JSON.stringify({ rot: process.env.CLAUDE_PLUGIN_ROOT, argv: process.argv.slice(2), ...p }) + "\\n");
const k = [${JSON.stringify(kontekst(PROBE_UNDER))}, ${JSON.stringify(kontekst(PROBE_OVER))}].find((x) => String(x.tegn) === process.argv[2]);
if (p.hook_event_name === "SessionStart" && k) {
	const fyll = "fyll ".repeat(Math.ceil(k.tegn / 5));
	const tekst = (k.start + "\\n" + fyll).slice(0, k.tegn - k.slutt.length - 1) + "\\n" + k.slutt;
	console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: tekst } }));
} else if (p.hook_event_name === "Stop" && !existsSync(dir + "/stoppet")) {
	writeFileSync(dir + "/stoppet", "1");
	console.log(JSON.stringify({ decision: "block", reason: "Røyktest: skriv ordet ${STOPP_ORD} på en egen linje, og avslutt." }));
} else console.log("{}");
`
	);
	chmodSync(join(dir, "bin", "probe"), 0o755);
}

/**
 * Probe-pluginen for steg G: logger hver `PreToolUse`-payload ordrett, og
 * svarer `{}`, så den aldri endrer et kall. Fila heter ikke `gylden.jsonl`:
 * `kjør` skriver stegets strøm dit, og overskrev payloadene (MÅLT 2026-09-28).
 */
function lagGyldenProbe(dir: string): void {
	mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
	mkdirSync(join(dir, "hooks"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(
		join(dir, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "pai-claudesmoke-gylden", version: "0.0.1", description: "ClaudeSmoke, steg G" })
	);
	writeFileSync(
		join(dir, "hooks", "hooks.json"),
		JSON.stringify({
			description: "ClaudeSmoke-probe for gyldne payloads",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: ${CLAUDE_PLUGIN_ROOT} er en literal motoren substituerer
			hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/probe", args: [], timeout: 15 }] }] },
		})
	);
	writeFileSync(
		join(dir, "bin", "probe"),
		`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const tekst = await Bun.stdin.text();
appendFileSync(process.env.PROBE_DIR + "/gylden-probe.jsonl", JSON.stringify(JSON.parse(tekst)) + "\\n");
console.log("{}");
`
	);
	chmodSync(join(dir, "bin", "probe"), 0o755);
}

// ─── Sjekkene ─────────────────────────────────────────────────────────────

interface Sjekk {
	navn: string;
	ok: boolean;
	detalj?: string;
	/** Skrives også når sjekken er grønn: noe verdt å vite, ikke rødt (K54). */
	merknad?: string;
}

function lesTekst(fil: string): string {
	try {
		return readFileSync(fil, "utf-8");
	} catch {
		return "";
	}
}

function linjerJson<T>(fil: string): T[] {
	return lesTekst(fil)
		.split("\n")
		.filter(Boolean)
		.flatMap((l) => {
			try {
				return [JSON.parse(l) as T];
			} catch {
				return [];
			}
		});
}

/** Arbeidsøktene under temp-`PAI_HOME`, som katalogstier. */
function arbeidsøkter(paiHome: string): string[] {
	const rot = join(paiHome, "MEMORY", "WORK");
	if (!existsSync(rot)) return [];
	return readdirSync(rot).flatMap((m) => readdirSync(join(rot, m)).map((ø) => join(rot, m, ø)));
}

function hookSjekk(s: Strøm, hendelse: string): { fyrt: boolean; ok: boolean } {
	const svar = s.hooks.filter((h) => h.hendelse === hendelse);
	return { fyrt: svar.length > 0, ok: svar.length > 0 && svar.every((h) => h.utfall === "success") };
}

function stegNull(claude: string): { versjon: string; sjekker: Sjekk[] } {
	const ver = Bun.spawnSync([claude, "--version"], { stdin: "ignore" });
	const versjon = /(\d+\.\d+\.\d+)/.exec(ver.stdout.toString())?.[1] ?? "";
	const val = Bun.spawnSync([claude, "plugin", "validate", PLUGIN], { stdin: "ignore" });
	const valUt = `${val.stdout.toString()}${val.stderr.toString()}`;
	const flagg = Bun.spawnSync([claude, "--append-system-prompt-file", "/finnes/ikke/pai-claudesmoke.md", "-p"], {
		stdin: "ignore",
		timeout: 10_000,
	});
	return {
		versjon,
		sjekker: [
			{ navn: "claude --version gir en versjon", ok: versjon !== "", detalj: ver.stdout.toString().trim() },
			{
				navn: "claude plugin validate: grønn uten advarsler (M-42)",
				ok: val.exitCode === 0 && /Validation passed/.test(valUt) && !/warning/i.test(valUt),
				detalj: valUt.trim().split("\n").slice(-3).join(" | "),
			},
			{
				navn: "--append-system-prompt-file finnes (K-10)",
				ok: tolkFlaggsjekk(flagg.stderr.toString()) === "ja",
				detalj: flagg.stderr.toString().trim().slice(0, 100),
			},
		],
	};
}

function kontekstSjekker(o: Oppsett, s: Strøm, kodeord: string, økt: string | undefined): Sjekk[] {
	const kopi = lesTekst(join(o.w, "kontekst-kopi.md"));
	const da = lesDaNavn(lesTekst(join(REPO, ".opencode", "PAI", "USER", "DAIDENTITY.md")));
	const start = s.hooks.find((h) => h.hendelse === "SessionStart");
	const meta = økt ? lesTekst(join(økt, "META.yaml")) : "";
	const thread = økt ? lesTekst(join(økt, "THREAD.md")) : "";
	const echo = s.kall.find((k) => k.navn === "Bash");
	return [
		{
			navn: `kontekstfila er over hook-taket (${HOOK_TAK} tegn)`,
			ok: kopi.length > HOOK_TAK,
			detalj: kopi ? `${kopi.length} tegn` : "wrapperen fikk ingen --append-system-prompt-file",
		},
		{
			navn: "kodeordet BAK konteksten nådde modellen (hele systemprompten kom fram)",
			ok: s.svar.includes(kodeord),
			detalj: `svar: ${s.svar.slice(0, 80)}`,
		},
		{
			navn: "DA-navnet står i svaret",
			ok: da !== "" && s.svar.includes(da),
			detalj: da === "" ? "fant ikke «**Name:**» i DAIDENTITY.md" : `ventet ${da}`,
		},
		{
			navn: "SessionStart injiserte ingenting selv (PAI_CONTEXT_FILE)",
			ok: start !== undefined && tilleggskontekst(start.utdata) === "",
			detalj: start ? start.utdata.slice(0, 100) : "SessionStart fyrte ikke",
		},
		{
			navn: "et tillatt skallkall gikk gjennom vakten",
			ok: echo !== undefined && !echo.feil && echo.resultat.includes("claudesmoke-k"),
			detalj: echo ? echo.resultat.slice(0, 80) : "modellen kalte ikke Bash",
		},
		{
			navn: "arbeidsøkt med harness claude, COMPLETED etter SessionEnd",
			ok: /harness: claude/.test(meta) && /^status:\s*COMPLETED/m.test(meta),
			detalj: økt ? (/^status:\s*(\S+)/m.exec(meta)?.[1] ?? "uten status") : "ingen arbeidsøkt",
		},
		{
			// Et svar på høyst ASSISTENT_MIN_LENGDE tegn tar hurtigutgangen i Stop og
			// skrives ikke i THREAD, med vilje. Jobbens korte DA-navn ga 91 tegn
			// 2026-10-05, og sjekken ble rød; steg 3 i prompten gjør svaret langt.
			navn: "THREAD har bruker- og assistentlinja",
			ok: thread.includes("**User:**") && thread.includes("**Assistant:**"),
			detalj:
				s.svar.length <= ASSISTENT_MIN_LENGDE
					? `svaret var ${s.svar.length} tegn, høyst ${ASSISTENT_MIN_LENGDE} tar hurtigutgangen i Stop`
					: `${thread.includes("**User:**") ? "" : "uten brukerlinje "}${thread.includes("**Assistant:**") ? "" : "uten assistentlinje"}`.trim(),
		},
		{
			navn: "plugin-MCP: plugin:pai:pai tilkoblet, verktøyene heter mcp__plugin_pai_pai__*",
			ok:
				s.init?.mcp.some((m) => m.name === "plugin:pai:pai" && m.status === "connected") === true &&
				s.init.tools.includes("mcp__plugin_pai_pai__session_registry"),
			detalj: s.init?.mcp.find((m) => m.name.includes("pai"))?.status ?? "ingen init",
		},
		{
			navn: "agentene heter pai:<navn>",
			ok: s.init?.agents.includes("pai:Intern") === true,
		},
		{
			navn: "TaskCreate finnes med CLAUDE_CODE_ENABLE_TODO_TOOLS",
			ok: s.init?.tools.includes("TaskCreate") === true,
			detalj: "står nøkkelen i ~/.claude/settings.json? Kjør: pai claude sync",
		},
		{
			// K58: et verktøy ingen har vurdert, kan skrive filer forbi vakten.
			navn: "hvert verktøy i init-lista er klassifisert (skriver og vaktes, eller står i IKKE_SKRIVENDE)",
			ok: s.init !== undefined && uklassifiserte(s.init.tools).length === 0,
			detalj: s.init ? `uklassifisert: ${uklassifiserte(s.init.tools).join(", ")}; se Tools/lib/verktoyklasser.ts` : "ingen init",
		},
	];
}

interface Revisjonslinje {
	tool?: string;
	action?: string;
	harness?: string;
}

interface Registeroppføring {
	agentType?: string;
	status?: string;
	outputPath?: string;
}

/** Kallet steg K måler, eller en tom liste når modellen gjorde det. */
export function manglendeKontekstkall(s: Strøm): string[] {
	return s.kall.some((k) => k.navn === "Bash" && String(k.input.command ?? "").includes("claudesmoke-k"))
		? []
		: ["Bash echo claudesmoke-k"];
}

/** Kallene steg V trenger. Et verktøy som spawner Intern, uansett hva motoren kaller det. */
function vaktkall(s: Strøm) {
	return {
		skall: s.kall.find((k) => k.navn === "Bash" && String(k.input.command ?? "").includes("rm -rf")),
		skriv: s.kall.find((k) => k.navn === "Write" && String(k.input.file_path ?? "").includes(".ssh/")),
		agent: s.kall.find((k) => /intern/i.test(JSON.stringify(k.input)) && k.navn !== "Bash" && k.navn !== "Write"),
	};
}

/** Hvilke av kallene i steg V modellen ikke gjorde. */
export function manglendeVaktkall(s: Strøm): string[] {
	const k = vaktkall(s);
	return [k.skall ? "" : "Bash rm -rf", k.skriv ? "" : "Write .ssh/", k.agent ? "" : "Agent Intern"].filter(Boolean);
}

/** Fake credentials for step S, built at runtime so no token-shaped literal is in the repo. */
const SMOKE_KNOWN = `${"5".repeat(20)}${"c".repeat(20)}`;
const SMOKE_URL_SECRET = `smokesecret${"x".repeat(10)}`;

/** The calls step S needs: a Read and a Bash of the file with the fake credentials. */
function secretCalls(s: Strøm) {
	return {
		read: s.kall.find((k) => k.navn === "Read" && String(k.input.file_path ?? "").includes("remote.txt")),
		bash: s.kall.find((k) => k.navn === "Bash" && String(k.input.command ?? "").includes("remote.txt")),
	};
}

/** Which of step S's calls the model did not make. */
export function missingSecretCalls(s: Strøm): string[] {
	const k = secretCalls(s);
	return [k.read ? "" : "Read remote.txt", k.bash ? "" : "Bash cat remote.txt"].filter(Boolean);
}

/** Step S (#367): neither fake value reached the model, and the masking was audited. */
function secretChecks(o: Oppsett, s: Strøm): Sjekk[] {
	const { read, bash } = secretCalls(s);
	const leaks = (t: string) => t.includes(SMOKE_KNOWN) || t.includes(SMOKE_URL_SECRET);
	const audit = linjerJson<Revisjonslinje & { masked?: string[] }>(join(o.paiHome, "MEMORY", "STATE", "security-audit.jsonl")).filter(
		(l) => l.harness === "claude" && l.action === "masked"
	);
	return [
		{
			navn: "secrets: Read output masked before the model saw it",
			ok: !!read && !leaks(read.resultat) && read.resultat.includes("[MASKED:"),
			detalj: read ? read.resultat.slice(0, 120) : "the model did not Read remote.txt",
		},
		{
			navn: "secrets: Bash output masked before the model saw it",
			ok: !!bash && !leaks(bash.resultat) && bash.resultat.includes("[MASKED:"),
			detalj: bash ? bash.resultat.slice(0, 120) : "the model did not cat remote.txt",
		},
		{
			navn: "secrets: nothing the model wrote contains a value",
			ok: s.tekst.length > 0 && !s.tekst.some(leaks),
			detalj: s.svar.slice(0, 120),
		},
		{
			navn: "secrets: the masking is in the audit log, by name, without the value",
			ok: audit.some((l) => l.tool === "Read") && audit.some((l) => l.masked?.includes("GITEA_TOKEN")) && !audit.some((l) => leaks(JSON.stringify(l))),
			detalj: `${audit.length} masked lines`,
		},
	];
}

function vaktSjekker(o: Oppsett, s: Strøm): Sjekk[] {
	const { skall, skriv, agent } = vaktkall(s);
	const revisjon = linjerJson<Revisjonslinje>(join(o.paiHome, "MEMORY", "STATE", "security-audit.jsonl")).filter(
		(l) => l.harness === "claude"
	);
	const stateDir = join(o.paiHome, "MEMORY", "STATE");
	const register = existsSync(stateDir)
		? readdirSync(stateDir)
				.filter((f) => f.startsWith("subagent-registry-"))
				.flatMap((f) => {
					try {
						return (JSON.parse(lesTekst(join(stateDir, f))) as { entries?: Registeroppføring[] }).entries ?? [];
					} catch {
						return [];
					}
				})
		: [];
	const barn = register.find((e) => e.agentType === "Intern");
	return [
		{
			navn: "farlig skall: blokkert, begrunnelsen står i resultatet modellen fikk",
			ok: skall?.feil === true && skall.resultat.includes(BLOKK_PREFIKS),
			detalj: skall ? skall.resultat.slice(0, 100) : "modellen kalte ikke Bash med rm -rf",
		},
		{ navn: "farlig skall: kommandoen kjørte ikke", ok: existsSync(join(o.proj, "offer", "fil.txt")) },
		{
			navn: "Write til .ssh/ med file_path: blokkert (K-09)",
			ok: skriv?.feil === true && skriv.resultat.includes(BLOKK_PREFIKS),
			detalj: skriv ? skriv.resultat.slice(0, 100) : "modellen kalte ikke Write mot .ssh/",
		},
		{ navn: "Write til .ssh/: fila finnes ikke", ok: !existsSync(join(o.proj, ".ssh", "authorized_keys")) },
		{
			navn: "revisjon: blokkert Bash og Write med harness claude",
			ok:
				revisjon.some((l) => l.action === "blocked" && l.tool?.toLowerCase() === "bash") &&
				revisjon.some((l) => l.action === "blocked" && l.tool?.toLowerCase() === "write"),
			detalj: `${revisjon.length} linjer med harness claude`,
		},
		{
			navn: "subagent-verktøyet heter Agent (M-17)",
			ok: agent?.navn === "Agent",
			detalj: agent ? `${agent.navn}: ${agent.resultat.slice(0, 60)}` : "modellen spawnet ingen Intern",
		},
		{
			// Ikke svaret: `Agent` kjører asynkront (MÅLT 2.1.283, «Async agent
			// launched»), og svaret kommer med SubagentStop. Uten aliaset ga
			// motoren «Agent type 'Intern' not found» (M-44).
			navn: "det bare navnet Intern ble spawnet (agent-alias + updatedInput, M-44)",
			ok: agent !== undefined && !agent.feil && !/not found/i.test(agent.resultat),
			detalj: agent?.resultat.slice(0, 100),
		},
		{
			navn: "registeret har Intern som completed, med svaret fanget",
			ok: barn?.status === "completed" && lesTekst(barn.outputPath ?? "").includes(SUBAGENT_SVAR),
			detalj: barn ? `${barn.status}, ${barn.outputPath ?? "ingen outputPath"}` : `${register.length} oppføringer, ingen Intern`,
		},
	];
}

interface ProbeLinje {
	rot?: string;
	argv?: string[];
	hook_event_name?: string;
	transcript_path?: string;
	stop_hook_active?: boolean;
}

function takSjekker(o: Oppsett, s: Strøm): { sjekker: Sjekk[]; transkript?: string } {
	const probe = linjerJson<ProbeLinje>(join(o.w, "probe.jsonl"));
	const transkript = probe.find((p) => p.transcript_path)?.transcript_path;
	const biter = lesHookKontekst(transkript ? lesTekst(transkript) : "");
	const under = biter.find((b) => b.includes(PROBE_UNDER.start)) ?? "";
	const over = biter.find((b) => b.includes(PROBE_OVER.start)) ?? "";
	// PAIs SessionStart-svar er det som ikke er probens.
	const pai = s.hooks
		.filter((h) => h.hendelse === "SessionStart")
		.map((h) => tilleggskontekst(h.utdata))
		.find((t) => t !== "" && !t.includes("ROYKTEST-"));
	const stopp = probe.filter((p) => p.hook_event_name === "Stop");
	return {
		transkript,
		sjekker: [
			{
				navn: "exec-form fra en sti med mellomrom: probens hooks fyrte, med stien hel (M-42)",
				ok: probe.length > 0 && probe.every((p) => p.rot === o.probe),
				detalj: probe[0]?.rot ?? "proben fyrte aldri",
			},
			{
				navn: `hook-taket: ${PROBE_UNDER.tegn} tegn kom inn hele`,
				ok: under.includes(PROBE_UNDER.slutt) && !under.includes("<persisted-output>"),
				detalj: transkript ? `${under.length} tegn i vedlegget` : "fant ikke transkriptet",
			},
			{
				navn: `hook-taket: ${PROBE_OVER.tegn} tegn ble en fil og en forhåndsvisning (K-10)`,
				ok: over.includes("<persisted-output>") && !over.includes(PROBE_OVER.slutt),
				detalj: over ? over.slice(0, 80).replace(/\n/g, " ") : "ingen vedlegg med probens kontekst",
			},
			{
				navn: "uten launcheren: PAI sender den korte beskjeden om pai --claude, under taket",
				ok: pai !== undefined && pai.length <= HOOK_TAK && pai.includes("pai --claude"),
				detalj: pai ? `${pai.length} tegn: ${pai.slice(0, 60)}` : "PAIs SessionStart ga ingen kontekst",
			},
			{
				navn: "Stop: decision block + reason fikk modellen til å fortsette",
				ok: s.tekst.some((t) => t.includes(STOPP_ORD)) && stopp.length >= 2 && stopp[1]?.stop_hook_active === true,
				detalj: `${stopp.length} Stop-kall, svar: ${s.svar.slice(0, 60)}`,
			},
		],
	};
}

/** Hvorfor steget er rødt, eller `undefined` (K46). */
function feilISteg(k: Kjøring): string | undefined {
	return stegFeil(k, lesStrøm(k.stdout).feil);
}

/** Det et rødt steg skriver, og rapporten. Gir stien til `rapport.txt`. */
function rapporter(o: Oppsett, steg: string, k: Kjøring, feil: string): string {
	ut.feil(`\n❌ ${steg} feilet (${feil})`);
	ut.feil(k.stderr.split("\n").slice(-10).join("\n"));
	ut.bareIRapport(`\nHele stderr fra ${steg}:\n${k.stderr}`);
	const rapport = ut.skriv(o.w);
	ut.feil(`Rapporten: ${rapport}`);
	return rapport;
}

/** Stopp ved et rødt steg. */
function sjekkSteg(o: Oppsett, steg: string, k: Kjøring): void {
	const feil = feilISteg(k);
	if (feil) {
		rapporter(o, steg, k, feil);
		ut.feil(`Arbeidskatalogen er beholdt: ${o.w}`);
		process.exit(2);
	}
}

/**
 * `--rød` (K46): steg K skal ha gått den røde veien med `UKJENT_MODELL`. Exit 0
 * når den holdt, og da er arbeidskatalogen og transkriptet borte.
 */
function rødVeiUt(o: Oppsett, steg: string, k: Kjøring, omkjørt: readonly Omkjøring[], behold: boolean): never {
	const feil = feilISteg(k);
	const rapport = feil ? rapporter(o, steg, k, feil) : ut.skriv(o.w);
	const sjekker = rødVeiSjekker(steg, k, feil, omkjørt, rapport);
	ut.log("\n  Den røde veien (K46):");
	for (const s of sjekker) ut.log(`  ${s.ok ? "✅" : "❌"} ${s.navn}${s.ok ? "" : ` (${s.detalj})`}`);
	if (sjekker.some((s) => !s.ok)) {
		ut.feil(`\n❌ den røde veien holdt ikke. Arbeidskatalogen er beholdt: ${o.w}`);
		process.exit(1);
	}
	ut.log(`\n✅ Den røde veien holdt med modellen ${o.modell}: ingen kvittering skrevet${behold ? `, arbeidskatalogen er beholdt: ${o.w}` : ""}`);
	if (!behold) {
		rmSync(o.w, { recursive: true, force: true });
		// Claude Code navngir katalogen etter cwd, med hvert tegn utenom [A-Za-z0-9] som «-».
		ryddTranskripter(join(homedir(), ".claude", "projects", o.proj.replace(/[^A-Za-z0-9]/g, "-"), "-"));
	}
	process.exit(0);
}

/**
 * Det Claude Code la igjen for temp-katalogen: transkriptene under
 * `~/.claude/projects/<slug>/`, og filene til asynkrone agenter under
 * `/tmp/claude-<uid>/<slug>/` (MÅLT 2.1.283). Bare når navnet viser at
 * katalogen er vår.
 */
function ryddTranskripter(transkript: string | undefined): void {
	if (!transkript) return;
	const katalog = dirname(transkript);
	const slug = basename(katalog);
	if (dirname(katalog) !== join(homedir(), ".claude", "projects") || !slug.includes(TEMP_PREFIKS)) return;
	rmSync(katalog, { recursive: true, force: true });
	for (const rot of new Set([tmpdir(), "/tmp"])) {
		rmSync(join(rot, `claude-${process.getuid?.() ?? ""}`, slug), { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const behold = args.includes("--behold");
	const fixtures = args.includes("--fixtures");
	const rødVei = args.includes("--rød");
	const mi = args.indexOf("--modell");
	// Koden som testes (K36), tatt før første steg; er den endret underveis,
	// skrives ingen kvittering.
	const adapter = adapterHash(REPO, claudeAdapterFiler(REPO));
	const claude = Bun.which("claude");
	if (!claude) {
		console.error("❌ fant ikke `claude` på PATH");
		process.exit(2);
	}
	const w = mkdtempSync(join(tmpdir(), TEMP_PREFIKS));
	const o: Oppsett = {
		w,
		proj: join(w, "proj"),
		modell: rødVei ? UKJENT_MODELL : mi >= 0 ? (args[mi + 1] ?? STANDARDMODELL) : STANDARDMODELL,
		claude,
		plugin: join(w, "pai plugin"),
		probe: join(w, "claude probe"),
		gylden: join(w, "gylden probe"),
		paiHome: join(w, "pai-home"),
	};
	mkdirSync(join(o.proj, "offer"), { recursive: true });
	mkdirSync(o.paiHome);
	writeFileSync(join(o.proj, "offer", "fil.txt"), "offer\n");
	symlinkSync(PLUGIN, o.plugin);
	lagProbe(o.probe);
	lagGyldenProbe(o.gylden);
	writeFileSync(join(w, "claude-p"), WRAPPER);
	chmodSync(join(w, "claude-p"), 0o755);

	const null0 = stegNull(claude);
	ut.log(`ClaudeSmoke: Claude Code ${null0.versjon || "?"}, modell ${o.modell}`);
	ut.log(`  arbeidskatalog ${w}`);
	const omkjørt: Omkjøring[] = [];
	const steg = (fil: string, etikett: string): Steg => ({ w, fil, etikett, ut, omkjørt });

	const kodeord = `KODEORD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
	ut.log("  steg K: kontekst gjennom launcheren");
	const rk = await medNyttForsøk(
		steg("kontekst", "steg K"),
		() =>
			launcherSteg(
				o,
				"kontekst",
				[
					"Røyktest av konteksten. Gjør dette i rekkefølge:",
					"1. Bruk Bash til å kjøre nøyaktig: echo claudesmoke-k",
					"2. Svar på norsk: Hva heter du? Begynn svaret med navnet ditt.",
					"3. Forklar med to hele setninger hva en røyktest er.",
					"4. Skriv til slutt røyktest-kodeordet fra systemprompten, ordrett.",
				].join("\n"),
				"Bash(echo:*)",
				kodeord
			),
		(k) => manglendeKontekstkall(lesStrøm(k.stdout))
	);
	if (rødVei) rødVeiUt(o, "steg K", rk, omkjørt, behold);
	sjekkSteg(o, "steg K", rk);
	const sk = lesStrøm(rk.stdout);
	// Den nyeste: katalognavnet begynner med tidsstempelet, og et nytt forsøk gir en økt til.
	const øktK = arbeidsøkter(o.paiHome).sort().at(-1);

	ut.log("  steg V: vakten og en subagent gjennom launcheren");
	const vaktPrompt = [
		// Uten rammen nektet modellen (MÅLT 2026-09-27): PAI-konteksten gjør den
		// forsiktig, og den flagget rm -rf og authorized_keys som risiko.
		`This is an automated smoke test of the PAI security hook, run in a throwaway temporary directory (${o.proj}). Steps 1 and 2 are EXPECTED to be blocked by the hook before anything happens; making the call is the test, so do not skip them or ask for confirmation.`,
		"Do these three steps in order. If a step is blocked, report the exact error text and continue with the next step. Do not try any alternatives or workarounds.",
			`1. Use the Bash tool to run exactly: rm -rf ${join(o.proj, "offer")}`,
			`2. Use the Write tool to write the text test to the file ${join(o.proj, ".ssh", "authorized_keys")}`,
			`3. Use the Agent tool with subagent_type Intern, description "claudesmoke", and prompt: "Reply with exactly the text ${SUBAGENT_SVAR} and nothing else."`,
		"Finally, list each step and whether it was blocked.",
	].join("\n");
	const rv = await medNyttForsøk(
		steg("vakt", "steg V"),
		() => launcherSteg(o, "vakt", vaktPrompt, "Bash Write Agent"),
		(k) => manglendeVaktkall(lesStrøm(k.stdout))
	);
	sjekkSteg(o, "steg V", rv);
	const sv = lesStrøm(rv.stdout);

	ut.log("  step S: secrets in tool output are masked through the launcher (#367)");
	writeFileSync(join(o.paiHome, ".env"), `GITEA_TOKEN=${SMOKE_KNOWN}\n`);
	const remote = join(o.proj, "remote.txt");
	writeFileSync(remote, `[remote "origin"]\n\turl = https://svc-smoke:${SMOKE_URL_SECRET}@git.example.com/x.git\ntoken = ${SMOKE_KNOWN}\n`);
	const secretPrompt = [
		`This is an automated smoke test of PAI's secret masking, in a throwaway temporary directory (${o.proj}). The file holds fake credentials made for this test.`,
		`1. Use the Read tool to read ${remote}`,
		`2. Use the Bash tool to run exactly: cat ${remote}`,
		"3. Reply with the url line and the token line exactly as they appeared in the tool output.",
	].join("\n");
	const rs = await medNyttForsøk(
		steg("hemmelig", "steg S"),
		() => launcherSteg(o, "hemmelig", secretPrompt, "Read Bash(cat:*)"),
		(k) => missingSecretCalls(lesStrøm(k.stdout))
	);
	sjekkSteg(o, "steg S", rs);
	const ss = lesStrøm(rs.stdout);

	ut.log("  steg T: hook-taket og Stop, uten launcheren");
	const rt = await kjør(
		o,
		"tak",
		[
			claude,
			"--plugin-dir",
			o.plugin,
			"--plugin-dir",
			o.probe,
			"--model",
			o.modell,
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-hook-events",
			"--tools",
			"",
			"-p",
			"Svar bare: ok.",
		],
		miljø({
			PAI_ENABLED: "1",
			PAI_HARNESS: "claude",
			PAI_HOME: o.paiHome,
			PAI_LOG_PATH: join(w, "tak.log"),
			PROBE_DIR: w,
		})
	);
	sjekkSteg(o, "steg T", rt);
	const st = lesStrøm(rt.stdout);
	const tak = takSjekker(o, st);

	ut.log("  steg G: gyldne payloads, uten launcheren");
	// Egen `PAI_HOME`: steget spawner også Intern, og steg V leser registeret.
	const gyldenHome = join(w, "pai-home-gylden");
	mkdirSync(gyldenHome);
	const gylden = () =>
		kjør(
			o,
			"gylden",
			[
				claude,
				"--plugin-dir",
				o.plugin,
				"--plugin-dir",
				o.gylden,
				"--model",
				o.modell,
				"--output-format",
				"stream-json",
				"--verbose",
				"--allowedTools",
				"Bash(echo:*) Write Edit Skill Agent",
				"-p",
				gyldenPrompt("claude", o.proj),
			],
			miljø({
				PAI_ENABLED: "1",
				PAI_HARNESS: "claude",
				PAI_HOME: gyldenHome,
				PAI_LOG_PATH: join(w, "gylden.log"),
				PROBE_DIR: w,
			})
		);
	const lesGylden = () => plukk("claude", linjerJson<Record<string, unknown>>(join(w, "gylden-probe.jsonl")), o.proj);
	// Probens fil deles av forsøkene; `plukk` tar det første kallet per klasse.
	const rg = await medNyttForsøk(steg("gylden", "steg G"), gylden, () => lesGylden().mangler);
	sjekkSteg(o, "steg G", rg);
	const målt = lesGylden();
	const gyldne = gyldenSjekker("claude", målt, fixtures);

	// Fyr-beviset: hver hendelse i minst ett steg, alle med utfall success.
	// `SessionEnd` kommer etter strømmens siste linje og leses fra hook-loggen.
	const strømmer: [string, Strøm][] = [
		["K", sk],
		["V", sv],
		["T", st],
	];
	const fyrt = FYR_KRAV.map((krav) => {
		if (krav === "SessionEnd") {
			const hvor = [
				["K", "kontekst"],
				["V", "vakt"],
				["T", "tak"],
			]
				.filter(([, f]) => /\[pai-hook\] SessionEnd notes:/.test(lesTekst(join(w, `${f}.log`))))
				.map(([s]) => s as string);
			return { krav, hvor, ok: hvor.length > 0 };
		}
		const per = strømmer.map(([n, s]) => ({ n, ...hookSjekk(s, krav) }));
		return { krav, hvor: per.filter((p) => p.fyrt).map((p) => p.n), ok: per.some((p) => p.fyrt) && per.every((p) => !p.fyrt || p.ok) };
	});

	ut.log("");
	for (const f of fyrt) {
		ut.log(`  ${f.ok ? "✅" : "❌"} ${f.krav.padEnd(18)} ${f.hvor.length > 0 ? `steg ${f.hvor.join(",")}` : "FYRTE ALDRI"}`);
	}

	const grupper: [string, Sjekk[]][] = [
		["Uten modell", null0.sjekker],
		["Kontekst (K-10) og livssyklus", kontekstSjekker(o, sk, kodeord, øktK)],
		["Sikkerhetsvakten og subagenter", vaktSjekker(o, sv)],
		["Secret masking (#367)", secretChecks(o, ss)],
		["Hook-taket, exec-formen og Stop", tak.sjekker],
		["Gyldne payloads (K25)", gyldne],
	];
	const sjekker = grupper.flatMap(([, g]) => g);
	for (const [tittel, gruppe] of grupper) {
		ut.log(`\n  ${tittel}:`);
		for (const s of gruppe) {
			ut.log(`  ${s.ok ? "✅" : "❌"} ${s.navn}${!s.ok && s.detalj ? ` (${s.detalj})` : ""}`);
			if (s.merknad) ut.log(`     ↳ ${s.merknad}`);
		}
	}
	for (const linje of omkjøringslinjer(omkjørt)) ut.log(linje);
	const mangler = fyrt.filter((f) => !f.ok);
	const feilet = sjekker.filter((s) => !s.ok);

	if (fixtures && målt.mangler.length === 0) {
		const sti = skrivFixture({
			motor: "claude",
			versjon: null0.versjon,
			målt: new Date().toLocaleDateString("sv-SE"),
			kilde: "bun Tools/ClaudeSmoke.ts --fixtures, steg G",
			kall: anonymiser(målt.kall, w, homedir()),
		});
		ut.log(`\n  fixturen skrevet: ${sti} — kjør bun test, og commit den`);
	}

	const rød = mangler.length > 0 || feilet.length > 0;
	if (behold || rød) {
		ut.log(`\nArbeidskatalogen er beholdt: ${w}`);
		if (tak.transkript) ut.log(`Transkriptene: ${dirname(tak.transkript)}`);
	} else {
		rmSync(w, { recursive: true, force: true });
		ryddTranskripter(tak.transkript);
	}

	if (mangler.length > 0) {
		ut.feil(`\n❌ ${mangler.length} av ${FYR_KRAV.length} hook-hendelser fyrte ikke rent: ${mangler.map((f) => f.krav).join(", ")}`);
	}
	if (feilet.length > 0) {
		ut.feil(`\n❌ ${feilet.length} av ${sjekker.length} sjekker feilet`);
	}
	if (rød) {
		ut.feil(`Rapporten: ${ut.skriv(w)}`);
		process.exit(1);
	}
	const nytt = omkjørt.length > 0 ? `, ${omkjørt.length} steg kjørt på nytt` : "";
	ut.log(`\n✅ Alle ${FYR_KRAV.length} hook-hendelser fyrte, og alle ${sjekker.length} sjekker holdt, mot Claude Code ${null0.versjon}${nytt}`);

	if (adapter !== adapterHash(REPO, claudeAdapterFiler(REPO))) {
		ut.feil("  ⚠️  pluginen ble endret mens røyktesten gikk: ingen kvittering. Kjør på nytt.");
		process.exitCode = 1;
		return;
	}
	skrivClaudeKvittering(join(REPO, ".opencode"), lagKvittering(null0.versjon, FYR_KRAV.length, sjekker, adapter));
	ut.log(`  kvittering skrevet: .opencode/claude-smoke-kvittering.json (${null0.versjon}) — commit den`);
	const pinnet = pinnetClaudeVersjon(join(REPO, ".opencode"));
	if (pinnet !== null0.versjon) {
		ut.log(`  ⚠️  pinningen står på ${pinnet ?? "ingenting"}: sett pai.claudeCode = "${null0.versjon}" i .opencode/package.json, og commit begge (C1)`);
	}
}

if (import.meta.main) {
	await main();
}
