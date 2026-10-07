#!/usr/bin/env bun
/**
 * Røyktest av v2-adapteren mot den EKTE OpenCode v2-binæren
 *
 * v2 validerer ikke hooknavn: et navn motoren ikke kjenner, registreres uten
 * feil og fyrer aldri (MÅLT på 2.0.15 og 2.0.16). Denne røyktesten er vakten
 * mot det. Den kjører binæren med adapteren, og FEILER for hvert navn i
 * `V2_HOOKS` som ikke har skrevet sin `[v2-fyrt]`-linje.
 *
 * Påkrevd før hver PR i v2-prosjektet og ved hver versjonsbump av
 * `@opencode/cli` (B3). Kjøres IKKE i `bun test`, fordi den koster modellkall.
 *
 *   bun Tools/V2Smoke.ts [--modell <fireworks-ruter>] [--behold] [--fixtures] [--rød]
 *
 * I TILLEGG sjekkes sikkerhetsvakten ende til ende (fase 2): et farlig
 * skallmønster og en Write til `.ssh/` blokkeres med begrunnelsen til
 * modellen, et indre Code Mode-kall når vakten, og kjernens `ask` blir en
 * forespørsel i `permission.evaluate`. Revisjonslinjene skal ha
 * `harness: "opencode2"`.
 *
 * STEGENE, alle med `--standalone` og ingen `--auto` (B6):
 *
 *   1. `run` med `PAI_ENABLED=1`: «hva heter du?», et skallkall som skriver
 *      `$PAI_SESSION_ID`, en lesing som feiler, og et svar langt nok til at
 *      kjernen behandler det. Fyrer verktøy-, skall-, tillatelses- og
 *      sesjonshookene, bussen og cleanup, og beviser fase 3: konteksten når
 *      modellen (DA-navnet står i svaret), arbeidsøkten får `harness:
 *      opencode2` og både bruker- og assistentlinje i THREAD, skallet får
 *      PAI-miljøet, og en feilet lesing blir `tool.failed`. Konteksten er
 *      repoets egen `.opencode/PAI/`, lest, aldri skrevet; alt som skrives,
 *      havner under temp-`PAI_HOME`.
 *   a. `run` med `git reset --hard`, et advarselsmønster, altså kjernens
 *      `ask`. `run` uten `--auto` skriver «permission requested: shell (git
 *      reset --hard); auto-rejecting», og kallet feiler med en melding til
 *      modellen, som fortsetter (fra 2.0.20, #153; til 2.0.19 avsluttet `run`
 *      hele kjøringen med exit 1, MÅLT 2026-09-25). Exitkoden sier derfor
 *      ingenting her: beviset er linja og det avviste kallet (`askAvslått`).
 *      Katalogen er ikke et git-repo, så kommandoen er harmløs.
 *   v. `run` i en NY økt med bare kall som skal blokkeres, pluss ett indre
 *      Code Mode-kall. Siden ingenting slipper gjennom, skal
 *      `shell.create.before` ikke fyre i dette steget i det hele tatt.
 *   2. `api session.compact` på økten. MÅLT 2026-09-25: med `--standalone`
 *      legger dette bare kompakteringen i innboksen — den private serveren
 *      stenger før noe kjøres, og pluginen lastes ikke engang.
 *   3. `run --session` på samme økt. Da tas kompakteringen fra innboksen, og
 *      `session.compaction` fyrer. `/compact` i en prompt går til modellen som
 *      tekst og utløser ingenting (M9).
 *   s. `run` med en PAI-agent (`Intern`) spawnet via `subagent`, og så PAIs
 *      egne verktøy via Code Mode (fase 5). Beviser at agentene kan spawnes
 *      (`mode: all`, MÅLT 2026-09-26: uten den gir v2 «cannot run as a
 *      subagent»), at registeret får barnet fra bussen og svaret fra
 *      `execute.after`, og at `session_results` gir det FANGEDE svaret.
 *   p. `run --agent plan`: plan-agenten skriver planen til en fil i
 *      `$HOME/.opencode/plan/` når den blir BEDT om det (prompten gjør det),
 *      og planen skal havne i `Plans/` under temp-`PAI_HOME`. Filnavnet velger
 *      modellen (MÅLT 2026-09-26: `hello-plan.md`).
 *   g. `run` med en probe-plugin ved siden av adapteren, som logger den rå
 *      `execute.before`-hendelsen: ett kall per verktøyklasse kjernen leser
 *      args fra (skall, write, edit, skill, subagent). Formen sammenlignes med
 *      `tests/fixtures/motor-payloads/opencode2.json`, og `--fixtures` skriver
 *      fila på nytt (K25, `Tools/lib/gyldne-payloads.ts`).
 *   L. Livssyklusen (fase 4), fire `run` med et `sleep`-kall de blir
 *      avbrutt i: SIGKILL av den private serveren (ingen cleanup, økten står
 *      ACTIVE), et nytt `run` der reaperen skal ta den og la en LEVENDE økt
 *      stå, SIGINT og SIGKILL av CLI-en (cleanup fullfører). At steg 1s økt
 *      er fullført når `run` har avsluttet, er beviset for normal slutt.
 *      MÅLT 2026-09-25: v2 venter på en async cleanup. Uten `await` på
 *      teardown sto alle tre øktene ACTIVE.
 *
 * SELVTESTEN (K6) sjekkes i steg 1: en agent med `mode: primary` i
 * prosjektet skal meldes fra motorens agentliste, og `Intern` skal ikke.
 *
 * KVITTERINGEN. Når hver hook har fyrt og hver sjekk holdt, skrives
 * `.opencode/v2smoke-kvittering.json` med versjonen binæren oppga. Launcheren
 * sier fra ved oppstart når den ikke stemmer med pinningen (K4), og
 * `tests/selvtest.test.ts` feiler. Commit den sammen med bumpen.
 *
 * Hvert steg er sin egen prosess med sin egen logg: adapteren tømmer loggen i
 * `setup`, så én felles fil ville beholdt bare siste stegs linjer.
 *
 * NYTT FORSØK (K7). Steg 1, a, v, s, p og g kjøres én gang til når modellen
 * ikke gjorde et kall steget måler (`KALLKRAV`), aldri når kallet ble gjort og
 * utfallet var feil. Rapporten sier hvilke steg det gjaldt. Første forsøks logg
 * står igjen som `<steg>.forsøk1.log` (`Tools/lib/roeyktest.ts`).
 *
 * RAPPORTEN (K43). Rød skriver den alt den skrev i terminalen, og hele stderr
 * fra et steg som feilet, til `rapport.txt` i arbeidskatalogen, med nøkkelen
 * byttet ut. Siste linje peker på fila. Et steg er rødt ved exit ≠ 0, og ved
 * en `error`-hendelse i strømmen også når exitkoden er 0 (K46, `stegFeil`).
 *
 * DEN RØDE VEIEN (K46). `--rød` kjører steg 1 med en ruter som ikke finnes
 * (`provider.no-route` før API-kallet, ingen tokens) og sjekker at steget ble
 * kjørt på nytt, ga exit ≠ 0 og skrev rapporten uten nøkkelen. Grønn når den
 * røde veien holdt; aldri en kvittering. Kjør den etter endringer i
 * røyktesten eller launcheren.
 *
 * ISOLASJON, som proben (`docs/opencode-v2/probe/README.md`): `env -i` med
 * ÉN nøkkel inn, aldri hele `.env`; egen `HOME`, `XDG_CONFIG_HOME` og
 * `PAI_HOME` under en temp-katalog; stdin fra `/dev/null`, ellers henger
 * `run` av og til rett etter «cli starting». Etterpå sjekkes det at nøkkelen
 * står i null filer der, før katalogen slettes.
 *
 * @module Tools/V2Smoke
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterHash, skrivKvittering, v2AdapterFiler } from "../.opencode/PAI/Tools/selvtest";
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
import { BLOKK_PREFIKS, FYR_MARKØR, V2_HOOKS } from "../.opencode/pai-adapters/opencode-v2";

/** Det røyktesten krever å se fyre. Er `V2_HOOKS`, låst av en test. */
export const FYR_KRAV: readonly string[] = V2_HOOKS;

const REPO = join(import.meta.dir, "..");
const ADAPTER = join(REPO, ".opencode", "pai-adapters", "opencode-v2");
const BINÆR = join(REPO, ".opencode", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
const STANDARDMODELL = "deepseek-flash-latest";
/**
 * Assistentens navn fra `DAIDENTITY.md` («**Name:** …», med eller uten
 * listestrek). Står det i svaret, nådde konteksten modellen. Leses fra fila,
 * ikke fra en konstant: et harness med en annen identitet ville ellers fått to
 * røde sjekker uten at noe var galt.
 */
export function lesDaNavn(tekst: string): string {
	return /^\s*(?:[-*]\s+)?\*\*Name:\*\*\s*(.+?)\s*$/m.exec(tekst)?.[1] ?? "";
}

/** Tom streng når fila mangler eller ikke har navnet; sjekkene faller da. */
function daNavn(): string {
	try {
		return lesDaNavn(readFileSync(join(REPO, ".opencode", "PAI", "USER", "DAIDENTITY.md"), "utf-8"));
	} catch {
		return "";
	}
}
const TIDSAVBRUDD_MS = 180_000;
/** Agenten selvtesten skal melde (K6). Bare ASCII, så id-en ikke kan normaliseres bort. */
const PRIMÆR_AGENT = "Selvtestprimaer";

/** Alt røyktesten skriver, så en rød kjøring kan skrive det til `rapport.txt` (K43). */
const ut = new Utskrift();

/** Fyr-linjene i en adapterlogg, som hooknavn. Tom liste når fila mangler. */
export function lesFyrLinjer(logg: string): string[] {
	let tekst: string;
	try {
		tekst = readFileSync(logg, "utf-8");
	} catch {
		return [];
	}
	return tekst
		.split("\n")
		.filter((l) => l.includes(FYR_MARKØR))
		.map((l) => l.slice(l.indexOf(FYR_MARKØR) + FYR_MARKØR.length).trim());
}

/** Hvilke krav mangler en fyr-linje i noen av loggene? */
export function manglende(krav: readonly string[], sett: Iterable<string>): string[] {
	const funnet = new Set(sett);
	return krav.filter((k) => !funnet.has(k));
}

/** Les ÉN nøkkel fra `.opencode/.env`. Resten av fila skal aldri inn i testen. */
function lesNøkkel(navn: string): string {
	const env = readFileSync(join(REPO, ".opencode", ".env"), "utf-8");
	const linje = env.split("\n").find((l) => l.startsWith(`${navn}=`));
	const verdi = linje
		?.slice(navn.length + 1)
		.trim()
		.replace(/^"(.*)"$/, "$1");
	if (!verdi) throw new Error(`${navn} mangler i .opencode/.env`);
	return verdi;
}

interface Kjøring {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	tidsavbrudd: boolean;
}

interface Oppsett {
	w: string;
	nøkkel: string;
	modell: string;
}

/** Et steg som kjører i bakgrunnen, så røyktesten kan sende det signaler. */
interface Bakgrunn {
	proc: ReturnType<typeof Bun.spawn>;
	ferdig: Promise<Kjøring>;
}

/** Start binæren isolert, uten å vente på den. */
function startSteg(
	o: Oppsett,
	steg: string,
	args: string[],
	ekstraEnv: Record<string, string> = {}
): Bakgrunn {
	const proc = Bun.spawn([BINÆR, ...args], {
		cwd: join(o.w, "proj"),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: join(o.w, "home"),
			XDG_CONFIG_HOME: join(o.w, "config"),
			FIREWORKS_API_KEY: o.nøkkel,
			PAI_HOME: join(o.w, "pai-home"),
			PAI_LOG_PATH: join(o.w, `${steg}.log`),
			// Adapteren registreres slik launcheren skal gjøre det (B2),
			// aldri via den delte `plugin`-nøkkelen.
			OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [ADAPTER] }),
			...ekstraEnv,
		},
	});
	const ferdig = (async (): Promise<Kjøring> => {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout as ReadableStream).text(),
			new Response(proc.stderr as ReadableStream).text(),
		]);
		await proc.exited;
		return { exitCode: proc.exitCode, stdout, stderr, tidsavbrudd: false };
	})();
	return { proc, ferdig };
}

/**
 * Kjør binæren isolert. Ett nytt forsøk ved tidsavbrudd: `run` henger av og
 * til før den har gjort noe (proben: 11 av ~24 uten `/dev/null`, 0 av 7 med),
 * og et heng skal ikke se ut som en hook som ikke fyrte.
 */
async function kjør(
	o: Oppsett,
	steg: string,
	args: string[],
	ekstraEnv: Record<string, string> = {}
): Promise<Kjøring> {
	for (let forsøk = 1; forsøk <= 2; forsøk++) {
		const b = startSteg(o, steg, args, ekstraEnv);
		let tidsavbrudd = false;
		const vakt = setTimeout(() => {
			tidsavbrudd = true;
			b.proc.kill("SIGKILL");
		}, TIDSAVBRUDD_MS);
		const k = await b.ferdig;
		clearTimeout(vakt);
		if (!tidsavbrudd || forsøk === 2) return { ...k, tidsavbrudd };
		ut.log(`  ${steg}: tidsavbrudd etter ${TIDSAVBRUDD_MS / 1000} s, prøver én gang til`);
	}
	throw new Error("utilgjengelig");
}

/** Sesjons-ID-en fra `run --format json`: hver linje er en hendelse med `sessionID`. */
function sesjonsId(stdout: string): string | undefined {
	for (const linje of stdout.split("\n")) {
		try {
			const id = (JSON.parse(linje) as { sessionID?: unknown }).sessionID;
			if (typeof id === "string" && id.startsWith("ses_")) return id;
		} catch {}
	}
	return undefined;
}

/**
 * Den første `error`-hendelsen i `run --format json`, som `type: melding`
 * (K46). En ukjent ruter gir `provider.no-route`, en ugyldig nøkkel
 * `provider.auth` (MÅLT 2.0.18, begge med exit 1).
 */
export function strømfeil(stdout: string): string | undefined {
	for (const linje of stdout.split("\n")) {
		try {
			const j = JSON.parse(linje) as { type?: unknown; error?: { type?: unknown; message?: unknown } };
			if (j.type === "error") return `${String(j.error?.type ?? "error")}: ${String(j.error?.message ?? "")}`;
		} catch {}
	}
	return undefined;
}

/** Filer under `dir` som inneholder `nål`. For lekkasjesjekken etterpå. */
function filerMed(dir: string, nål: string): string[] {
	const treff: string[] = [];
	for (const navn of readdirSync(dir)) {
		const full = join(dir, navn);
		const st = statSync(full, { throwIfNoEntry: false });
		if (!st) continue;
		if (st.isDirectory()) treff.push(...filerMed(full, nål));
		else if (st.isFile() && readFileSync(full).includes(nål)) treff.push(full);
	}
	return treff;
}

/** Verktøykallene i `run --format json`-utdataen: navn, status, input og resultat/feil. */
export function verktøykall(
	stdout: string
): { tool: string; status: string; input: string; utfall: string }[] {
	const ut: { tool: string; status: string; input: string; utfall: string }[] = [];
	for (const linje of stdout.split("\n")) {
		try {
			const j = JSON.parse(linje) as {
				type?: string;
				part?: { tool?: string; state?: { status?: string; input?: unknown; output?: unknown; error?: unknown } };
			};
			if (j.type !== "tool_use" || !j.part?.state) continue;
			const st = j.part.state;
			ut.push({
				tool: String(j.part.tool ?? ""),
				status: String(st.status ?? ""),
				input: JSON.stringify(st.input ?? ""),
				utfall: typeof st.error === "string" ? st.error : JSON.stringify(st.error ?? st.output ?? ""),
			});
		} catch {}
	}
	return ut;
}

/** Et kall et steg måler: verktøyet, og en tekst inputen skal inneholde. */
export interface Kallkrav {
	tool: string;
	inneholder?: string;
	/** Slik kallet heter i rapporten. */
	navn: string;
}

/**
 * Kallene hvert modellsteg måler, de samme sjekkene leter etter. Mangler ett,
 * kjøres steget på nytt én gang (K7).
 */
export const KALLKRAV = {
	steg1: [
		{ tool: "shell", inneholder: "PAI_SESSION_ID", navn: "shell med PAI_SESSION_ID" },
		{ tool: "read", navn: "read" },
	],
	ask: [{ tool: "shell", inneholder: "git reset", navn: "shell med git reset" }],
	vakt: [
		{ tool: "shell", inneholder: "rm -rf", navn: "shell med rm -rf" },
		{ tool: "write", inneholder: ".ssh/authorized_keys", navn: "write mot .ssh/" },
		{ tool: "execute", navn: "execute" },
	],
	subagent: [
		{ tool: "subagent", inneholder: "Intern", navn: "subagent med Intern" },
		{ tool: "execute", inneholder: "session_registry", navn: "execute med verktøykoden" },
	],
	plan: [{ tool: "write", navn: "write" }],
	secret: [
		{ tool: "read", inneholder: "remote.txt", navn: "read remote.txt" },
		{ tool: "shell", inneholder: "remote.txt", navn: "shell cat remote.txt" },
	],
} satisfies Record<string, Kallkrav[]>;

/** Kravene modellen ikke gjorde et kall for, i `run --format json`-utdataen. */
export function uprøvdeKall(stdout: string, krav: readonly Kallkrav[]): string[] {
	const kall = verktøykall(stdout);
	return krav
		.filter((k) => !kall.some((v) => v.tool === k.tool && (!k.inneholder || v.input.includes(k.inneholder))))
		.map((k) => k.navn);
}

/**
 * Steg a: motorens egen linje om forespørselen beviser kallet, også om
 * `tool_use` mangler i utdataen (til 2.0.19 avsluttet `run` før den kom).
 */
export function uprøvdAsk(stdout: string, stderr: string): string[] {
	return /permission requested: shell \(git reset/.test(stderr) ? [] : uprøvdeKall(stdout, KALLKRAV.ask);
}

/**
 * Steg a: `run` avslo forespørselen. Linja i stderr sier at den ble avslått,
 * og `git reset`-kallet i strømmen endte i `error`, altså at det aldri ble
 * kjørt. Exitkoden er ikke med: fra 2.0.20 fortsetter modellen etter
 * avslaget, og `run` gir exit 0 (#153).
 */
export function askAvslått(stdout: string, stderr: string): { ok: boolean; detalj?: string } {
	const linje = /permission requested: shell \(git reset --hard\); auto-rejecting/.test(stderr);
	const kall = verktøykall(stdout).filter((k) => k.tool === "shell" && k.input.includes("git reset"));
	const avvist = kall.length > 0 && kall.every((k) => k.status === "error");
	if (linje && avvist) return { ok: true };
	return {
		ok: false,
		detalj: !linje
			? "ingen «auto-rejecting»-linje i stderr"
			: kall.length === 0
				? "ingen tool_use for git reset i strømmen"
				: `git reset-kallet endte ${kall.map((k) => k.status).join(", ")}, ikke error`,
	};
}

interface Revisjonslinje {
	tool?: string;
	action?: string;
	harness?: string;
	commandPreview?: string;
}

function lesRevisjon(w: string): Revisjonslinje[] {
	try {
		return readFileSync(join(w, "pai-home", "MEMORY", "STATE", "security-audit.jsonl"), "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Revisjonslinje);
	} catch {
		return [];
	}
}

export interface Sjekk {
	navn: string;
	ok: boolean;
	detalj?: string;
	/** Skrives også når sjekken er grønn: noe verdt å vite, ikke rødt (K54). */
	merknad?: string;
}

/**
 * Startet det blokkerte skallkallet et skall? `shell.create.before` fyrer bare
 * når kommandoen faktisk startes, så i vakt-steget skal den fyre én gang per
 * skallkall vakten slapp gjennom, og aldri for et blokkert. Ikke «aldri i
 * steget»: modellen kan legge til en ufarlig `ls` for å se hva som skjedde, og
 * da er en rød sjekk ikke et funn (MÅLT 2026-09-29, `ls -la` etter blokkene).
 */
export function skallBareForSluppne(
	kall: { tool: string; status: string; utfall: string }[],
	fyr: string[]
): Sjekk {
	const sluppet = kall.filter((k) => k.tool === "shell" && !(k.status === "error" && k.utfall.includes(BLOKK_PREFIKS))).length;
	const startet = fyr.filter((f) => f === "shell.create.before").length;
	return {
		navn: "shell.create.before fyrte bare for skallkall vakten slapp gjennom",
		ok: startet === sluppet,
		detalj: `${startet} skall startet, ${sluppet} skallkall sluppet gjennom`,
	};
}

/**
 * Sikkerhetsvaktens sjekker, ende til ende. Hver sjekk krever at modellen
 * faktisk gjorde kallet: et kall som aldri ble gjort, er ikke et bevis på at
 * vakten virker, og skal feile framfor å bestå stille.
 */
/** Fake credentials for step h, built at runtime so no token-shaped literal is in the repo. */
const SMOKE_KNOWN = `${"5".repeat(20)}${"c".repeat(20)}`;
const SMOKE_URL_SECRET = `smokesecret${"x".repeat(10)}`;

/** Step h (#367): neither fake value reached the model, and the masking was audited. */
function secretChecks(o: Oppsett, rh: Kjøring): Sjekk[] {
	const calls = verktøykall(rh.stdout);
	const leaks = (t: string) => t.includes(SMOKE_KNOWN) || t.includes(SMOKE_URL_SECRET);
	const read = calls.find((k) => k.tool === "read" && k.input.includes("remote.txt"));
	const shell = calls.find((k) => k.tool === "shell" && k.input.includes("remote.txt"));
	const texts = rh.stdout
		.split("\n")
		.map((l) => {
			try {
				const j = JSON.parse(l) as { type?: string; part?: { text?: unknown } };
				return j.type === "text" && typeof j.part?.text === "string" ? j.part.text : "";
			} catch {
				return "";
			}
		})
		.filter(Boolean);
	const audit = lesRevisjon(o.w).filter((l) => l.harness === "opencode2" && l.action === "masked");
	return [
		{
			navn: "secrets: read output masked before the model saw it",
			ok: !!read && !leaks(read.utfall) && read.utfall.includes("[MASKED:"),
			detalj: read ? read.utfall.slice(0, 120) : "the model did not read remote.txt",
		},
		{
			navn: "secrets: shell output masked before the model saw it",
			ok: !!shell && !leaks(shell.utfall) && shell.utfall.includes("[MASKED:"),
			detalj: shell ? shell.utfall.slice(0, 120) : "the model did not cat remote.txt",
		},
		{
			navn: "secrets: nothing the model wrote contains a value",
			ok: texts.length > 0 && !texts.some(leaks),
			detalj: sisteTekst(rh.stdout).slice(0, 120),
		},
		{
			navn: "secrets: the masking is in the audit log, without the value",
			ok: audit.length > 0 && !audit.some((l) => leaks(JSON.stringify(l))),
			detalj: `${audit.length} masked lines`,
		},
	];
}

function vaktSjekker(o: Oppsett, ra: Kjøring, rv: Kjøring): Sjekk[] {
	const kall = verktøykall(rv.stdout);
	const revisjon = lesRevisjon(o.w).filter((l) => l.harness === "opencode2");
	const skall = kall.find((k) => k.tool === "shell" && k.input.includes("rm -rf"));
	const skriv = kall.find((k) => k.tool === "write" && k.input.includes(".ssh/authorized_keys"));
	const vaktLogg = lesFyrLinjer(join(o.w, "vakt.log"));
	const askLogg = (() => {
		try {
			return readFileSync(join(o.w, "ask.log"), "utf-8");
		} catch {
			return "";
		}
	})();
	return [
		{
			navn: "farlig skall: blokkert, begrunnelsen nådde modellen",
			ok: skall?.status === "error" && skall.utfall.includes(BLOKK_PREFIKS),
			detalj: skall ? `${skall.status}: ${skall.utfall.slice(0, 80)}` : "modellen kalte ikke shell med rm -rf",
		},
		{
			navn: "farlig skall: kommandoen kjørte ikke",
			ok: existsSync(join(o.w, "proj", "offer", "fil.txt")),
		},
		skallBareForSluppne(kall, vaktLogg),
		{
			navn: "Write til .ssh/ med path: blokkert, begrunnelsen nådde modellen",
			ok: skriv?.status === "error" && skriv.utfall.includes(BLOKK_PREFIKS),
			detalj: skriv ? `${skriv.status}: ${skriv.utfall.slice(0, 80)}` : "modellen kalte ikke write mot .ssh/",
		},
		{
			navn: "Write til .ssh/: fila finnes ikke",
			ok: !existsSync(join(o.w, "proj", ".ssh", "authorized_keys")),
		},
		{
			navn: "revisjon: blokkert shell med harness opencode2",
			ok: revisjon.some((l) => l.action === "blocked" && l.tool === "shell"),
		},
		{
			navn: "revisjon: blokkert write med harness opencode2",
			ok: revisjon.some((l) => l.action === "blocked" && l.tool === "write"),
		},
		{
			navn: "Code Mode: det indre kallet nådde vakten",
			ok: revisjon.some((l) => l.tool === "opencode_models"),
			detalj: kall.some((k) => k.tool === "execute") ? undefined : "modellen kalte ikke execute",
		},
		{
			navn: "ask: kjernens forespørsel satt i permission.evaluate",
			ok: askLogg.includes("[v2] ask → permission.evaluate"),
			detalj: verktøykall(ra.stdout).some((k) => k.tool === "shell" && k.input.includes("git reset"))
				? "kallet ble gjort, men ingen forespørsel kom"
				: "modellen kalte ikke shell med git reset",
		},
		{
			navn: "ask: motoren ba om tillatelse, og run avslo",
			...askAvslått(ra.stdout, ra.stderr),
		},
		{
			navn: "revisjon: ask (confirmed) med harness opencode2",
			ok: revisjon.some((l) => l.action === "confirmed" && l.tool === "shell"),
		},
	];
}

/**
 * `META.yaml` og `THREAD.md` for den NYESTE arbeidsøkten hvis katalognavn
 * inneholder `slug`, eller undefined.
 *
 * Katalognavnet er tidsstempelet og tittelen fra første brukermelding, så et
 * nytt forsøk av steget (K7) gir en økt til med samme slug, og den gjelder.
 * `session_id` i META er arbeidsøktens EGEN ID, ikke motorens, så den kan ikke
 * brukes til oppslaget.
 */
function arbeidsøkt(w: string, slug: string): { meta: string; thread: string } | undefined {
	const rot = join(w, "pai-home", "MEMORY", "WORK");
	let måneder: string[];
	try {
		måneder = readdirSync(rot).sort().reverse();
	} catch {
		return undefined;
	}
	for (const m of måneder) {
		for (const ø of readdirSync(join(rot, m)).sort().reverse()) {
			if (!ø.includes(slug)) continue;
			const katalog = join(rot, m, ø);
			try {
				const meta = readFileSync(join(katalog, "META.yaml"), "utf-8");
				let thread = "";
				try {
					thread = readFileSync(join(katalog, "THREAD.md"), "utf-8");
				} catch {}
				return { meta, thread };
			} catch {}
		}
	}
	return undefined;
}

/** Siste tekst modellen skrev i `run --format json`-utdataen. */
function sisteTekst(stdout: string): string {
	let siste = "";
	for (const linje of stdout.split("\n")) {
		try {
			const j = JSON.parse(linje) as { type?: string; part?: { text?: unknown } };
			if (j.type === "text" && typeof j.part?.text === "string") siste = j.part.text;
		} catch {}
	}
	return siste;
}

/** Svaret subagenten skal gi i steg s. Står det i det fangede svaret, gikk hele kjeden. */
const SUBAGENT_SVAR = "FASE5-SVAR";

/** Code Mode-koden i steg s. Verktøyene heter `tools.<navn>` der (MÅLT, fase 0). */
const VERKTØY_KODE = [
	"const reg = String(await tools.session_registry({}));",
	"const id = (reg.match(/ses_[0-9A-Za-z]{26}/g) ?? [])[0];",
	'const res = id ? String(await tools.session_results({ session_id: id })) : "INGEN-ID";',
	'const cr = String(await tools.code_review({ mode: "dirty" }));',
	'return reg + "\n=====\n" + res + "\n=====\n" + cr.slice(0, 80);',
].join(" ");

interface Registeroppføring {
	sessionId?: string;
	agentType?: string;
	description?: string;
	status?: string;
	outputPath?: string;
}

function lesRegisteret(w: string, sid: string): Registeroppføring[] {
	try {
		const r = JSON.parse(
			readFileSync(join(w, "pai-home", "MEMORY", "STATE", `subagent-registry-${sid}.json`), "utf-8")
		) as { entries?: Registeroppføring[] };
		return r.entries ?? [];
	} catch {
		return [];
	}
}

/** Fase 5-sjekkene: subagenter, verktøy, kompaktering og planer. */
function fase5Sjekker(o: Oppsett, rs: Kjøring, sidS: string | undefined, rp: Kjøring): Sjekk[] {
	const kall = verktøykall(rs.stdout);
	const sub = kall.find((k) => k.tool === "subagent");
	const kode = kall.find((k) => k.tool === "execute" && k.input.includes("session_registry"));
	const barn = lesRegisteret(o.w, sidS ?? "").find((e) => e.agentType === "Intern");
	const fanget = barn?.outputPath ? lesTekst(barn.outputPath) : "";
	const sLogg = lesTekst(join(o.w, "subagent.log"));
	const kompLogg = lesTekst(join(o.w, "steg3.log"));
	const plansDir = join(o.w, "pai-home", "Plans");
	const planer = existsSync(plansDir) ? readdirSync(plansDir).filter((f) => f.startsWith("opencode-")) : [];
	const plan = planer[0] ? lesTekst(join(plansDir, planer[0])) : "";
	return [
		{
			navn: "subagent: PAI-agenten Intern ble spawnet og fullførte",
			ok: sub?.status === "completed" && sub.input.includes("Intern"),
			detalj: sub ? `${sub.status}: ${sub.utfall.slice(0, 80)}` : "modellen kalte ikke subagent",
		},
		{
			navn: "agent.start: registeret har barnet som Intern, med beskrivelse",
			ok: barn !== undefined && !!barn.description && barn.description !== "subagent",
			detalj: barn ? `beskrivelse: ${barn.description}` : `ingen Intern i registeret for ${sidS}`,
		},
		{
			navn: "agent.stop: completed, og svaret er fanget med stien på oppføringen",
			ok: barn?.status === "completed" && fanget.includes(SUBAGENT_SVAR),
			detalj: barn ? `${barn.status}, ${barn.outputPath ?? "ingen outputPath"}` : undefined,
		},
		{
			navn: "verktøy: session_registry, session_results og code_review kjørte",
			ok: ["session_registry", "session_results", "code_review"].every((n) =>
				sLogg.includes(`[v2-verktøy] ${n} for ${sidS}`)
			),
			detalj: kode ? undefined : "modellen kalte ikke execute med verktøykoden",
		},
		{
			navn: "verktøy: session_results ga det FANGEDE svaret",
			ok: kode?.utfall.includes("Subagent Session") === true && kode.utfall.includes(SUBAGENT_SVAR),
			detalj: kode ? kode.utfall.slice(0, 120) : undefined,
		},
		{
			navn: "kompaktering: PAIs seksjoner pushet i session.compaction",
			ok: /\[Compaction:Pre\] Context injection triggered/.test(kompLogg) &&
				/\[CompactionIntelligence\] Bygget \d+ kontekstseksjoner/.test(kompLogg),
		},
		{
			navn: "kompaktering: session.compacted fra bussen, med utløser",
			ok: /\[Compaction:Post\] Context compaction detected \(manual/.test(kompLogg),
		},
		{
			navn: "plan: plan-agentens planfil havnet i Plans/",
			ok: plan.includes("harness: opencode2") && plan.includes("/.opencode/plan/"),
			detalj:
				planer.length > 0
					? undefined
					: uprøvdeKall(rp.stdout, KALLKRAV.plan).length > 0
						? "modellen kalte ikke write"
						: `ingen opencode-* i Plans/ (exit ${rp.exitCode})`,
		},
	];
}

/**
 * Selvtesten i adapteren (K6), mot steg 1: `ctx.agent.list()` ved første
 * prompt. Begge retninger: den primære agenten meldes, og `Intern` (`mode:
 * all`) gjør det ikke.
 */
function selvtestSjekker(o: Oppsett): Sjekk[] {
	const linje = lesTekst(join(o.w, "steg1.log"))
		.split("\n")
		.find((l) => l.includes("[selvtest]"));
	return [
		{
			navn: `K6: ${PRIMÆR_AGENT} (mode: primary) meldes fra motorens agentliste`,
			ok: linje?.includes(PRIMÆR_AGENT) === true,
			detalj: linje ? linje.slice(0, 120) : "ingen [selvtest]-linje i steg 1",
		},
		{
			navn: "K6: Intern (mode: all) meldes ikke",
			ok: linje !== undefined && !linje.includes("Intern"),
		},
	];
}

/** Fase 3-sjekkene: kontekst, meldinger, verktøyutfall og skallmiljø, mot steg 1. */
function meldingsSjekker(o: Oppsett, r1: Kjøring, sid: string): Sjekk[] {
	const logg = (() => {
		try {
			return readFileSync(join(o.w, "steg1.log"), "utf-8");
		} catch {
			return "";
		}
	})();
	const svar = sisteTekst(r1.stdout);
	const da = daNavn();
	const økt = arbeidsøkt(o.w, "gj-r-dette-i-rekkef");
	const skall = verktøykall(r1.stdout).find((k) => k.tool === "shell" && k.input.includes("PAI_SESSION_ID"));
	const lesing = verktøykall(r1.stdout).find((k) => k.tool === "read");
	return [
		{
			navn: "kontekst: injisert i session.context",
			ok: /Context injected successfully \(\d+ chars\)/.test(logg),
		},
		{
			navn: "kontekst: nådde modellen (DA-navnet står i svaret)",
			ok: da !== "" && svar.includes(da),
			detalj:
				da === ""
					? "fant ikke «**Name:**» i DAIDENTITY.md"
					: svar
						? `svar: ${svar.slice(0, 80)}`
						: "modellen skrev ikke noe svar",
		},
		{
			navn: "user.message: arbeidsøkt med harness opencode2",
			ok: økt?.meta.includes("harness: opencode2") === true,
			detalj: økt ? undefined : "ingen arbeidsøkt for steg 1",
		},
		{
			navn: "user.message: brukerlinja står i THREAD",
			// `run` sender prompten med anførselstegn rundt (MÅLT 2026-09-25).
			ok: /\*\*User:\*\* "?Gjør dette i rekkefølge/.test(økt?.thread ?? ""),
		},
		{
			navn: "assistant.message: sluttsvaret står i THREAD",
			ok: da !== "" && økt?.thread.includes("**Assistant:**") === true && økt.thread.includes(da),
		},
		{
			navn: "shell.env: skallet fikk PAI_SESSION_ID",
			ok: skall?.utfall.includes(`sesjon=${sid}`) === true,
			detalj: skall ? skall.utfall.slice(0, 80) : "modellen kalte ikke shell med PAI_SESSION_ID",
		},
		{
			navn: "tool.failed: en feilet lesing kom fram som feil",
			ok: /Tool failed: read — /.test(logg),
			detalj: lesing ? `${lesing.status}` : "modellen kalte ikke read",
		},
	];
}

// ─── Livssyklusen (fase 4) ────────────────────────────────────────────────

/** Vent til `pred` er sann, eller til fristen går ut. */
async function vent(pred: () => boolean, ms: number): Promise<boolean> {
	const slutt = Date.now() + ms;
	while (Date.now() < slutt) {
		if (pred()) return true;
		await Bun.sleep(250);
	}
	return pred();
}

/** Lever prosessen? En zombie teller som død: den kjører ingenting. */
function lever(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
	} catch {
		return false;
	}
}

/**
 * Den private serveren under en CLI: etterkommeren med `serve` i
 * kommandolinja (M3). Funnet via `/proc`, ALDRI med `pgrep -f`, som treffer
 * ditt eget skall (fase 0).
 */
function serverPid(cliPid: number): number | undefined {
	const barn = new Map<number, number[]>();
	for (const navn of readdirSync("/proc")) {
		if (!/^\d+$/.test(navn)) continue;
		try {
			const stat = readFileSync(`/proc/${navn}/stat`, "utf-8");
			const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
			barn.set(ppid, [...(barn.get(ppid) ?? []), Number(navn)]);
		} catch {}
	}
	const kø = [...(barn.get(cliPid) ?? [])];
	while (kø.length > 0) {
		const pid = kø.shift() as number;
		try {
			if (readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").includes("serve")) return pid;
		} catch {}
		kø.push(...(barn.get(pid) ?? []));
	}
	return undefined;
}

interface Tilstand {
	fil: string;
	work_dir: string;
	pid?: number;
}

function tilstandsfiler(w: string): Map<string, Tilstand> {
	const dir = join(w, "pai-home", "MEMORY", "STATE");
	const ut = new Map<string, Tilstand>();
	let navn: string[];
	try {
		navn = readdirSync(dir);
	} catch {
		return ut;
	}
	for (const fil of navn.filter((n) => /^current-work-.+\.json$/.test(n))) {
		try {
			const s = JSON.parse(readFileSync(join(dir, fil), "utf-8")) as { work_dir?: string; pid?: number };
			if (s.work_dir) ut.set(fil, { fil, work_dir: s.work_dir, pid: s.pid });
		} catch {}
	}
	return ut;
}

function status(w: string, økt: Tilstand | undefined): string {
	if (!økt) return "ingen økt";
	try {
		const meta = readFileSync(join(w, "pai-home", "MEMORY", "WORK", økt.work_dir, "META.yaml"), "utf-8");
		return /^status:\s*(\S+)/m.exec(meta)?.[1] ?? "uten status";
	} catch {
		return "META mangler";
	}
}

interface LangtSteg {
	b: Bakgrunn;
	økt?: Tilstand;
	server?: number;
}

/**
 * Start et `run` som blir hengende i et `sleep`-kall, og vent til
 * arbeidsøkten finnes og skallet kjører. Da har økten en eier, og et signal
 * treffer den midt i arbeidet.
 */
async function langtSteg(o: Oppsett, steg: string, merke: string): Promise<LangtSteg> {
	const før = new Set(tilstandsfiler(o.w).keys());
	const b = startSteg(o, steg, [
		"run",
		"--standalone",
		"--format",
		"json",
		"-m",
		o.modell,
		`Livssyklus ${merke}: bruk shell-verktøyet til å kjøre nøyaktig sleep 90, og svar deretter bare ordet ferdig.`,
	]);
	const ny = () => [...tilstandsfiler(o.w).values()].find((t) => !før.has(t.fil));
	await vent(
		() => ny() !== undefined && lesFyrLinjer(join(o.w, `${steg}.log`)).includes("shell.create.before"),
		120_000
	);
	// Skallet er startet; gi det et øyeblikk, så signalet treffer mens det kjører.
	await Bun.sleep(1000);
	return { b, økt: ny(), server: serverPid(b.proc.pid) };
}

/** Vent på et bakgrunnssteg. Rekker det ikke å avslutte, drepes det. */
async function avslutt(b: Bakgrunn, ms: number): Promise<Kjøring> {
	const ferdig = await Promise.race([b.ferdig.then(() => true), Bun.sleep(ms).then(() => false)]);
	if (!ferdig) b.proc.kill("SIGKILL");
	return b.ferdig;
}

/**
 * Livssyklusen mot binæren: hver vei en økt kan ende på, og reaperen i
 * begge retninger.
 *
 *   lang    blir stående og sove, og er den LEVENDE økten reaperen skal la være
 *   drept   serveren får SIGKILL: ingen cleanup kan kjøre
 *   rydd    et nytt `run`, der reaperen skal ta «drept» og la «lang» stå.
 *           Etterpå får «lang» SIGINT av CLI-en

 *   kuttet  CLI-en får SIGKILL
 *
 * Rekkefølgen er bindende: «rydd» må være den FØRSTE prosessen som starter
 * etter at «drept» ble drept, ellers har en annen reaper tatt den.
 */
async function livssyklus(o: Oppsett, steg1Status: string): Promise<Sjekk[]> {
	const lang = await langtSteg(o, "lang", "lang");
	const drept = await langtSteg(o, "drept", "drept");

	if (drept.server) process.kill(drept.server, "SIGKILL");
	await vent(() => !lever(drept.server), 10_000);
	await avslutt(drept.b, 15_000);
	const dreptEtterDrap = status(o.w, drept.økt);

	await kjør(o, "rydd", ["run", "--standalone", "--format", "json", "-m", o.modell, "Svar bare: ok."]);
	const dreptEtterRydd = status(o.w, drept.økt);
	const langEtterRydd = status(o.w, lang.økt);
	const langLevde = lang.b.proc.exitCode === null;

	lang.b.proc.kill("SIGINT");
	await avslutt(lang.b, 30_000);
	await vent(() => !lever(lang.server), 15_000);
	const langEtterSigint = status(o.w, lang.økt);

	const kuttet = await langtSteg(o, "kuttet", "kuttet");
	kuttet.b.proc.kill("SIGKILL");
	await kuttet.b.ferdig;
	// Serveren overlever CLI-en et øyeblikk og kjører cleanup (M4).
	await vent(() => !lever(kuttet.server), 20_000);
	const kuttetEtter = status(o.w, kuttet.økt);

	return [
		{
			navn: "normal slutt: cleanup fullførte steg 1s økt",
			ok: steg1Status === "COMPLETED",
			detalj: steg1Status,
		},
		{
			navn: "eieren er den private serveren, ikke CLI-en",
			ok: lang.økt?.pid !== undefined && lang.økt.pid === lang.server && lang.server !== lang.b.proc.pid,
			detalj: `tilstand pid ${lang.økt?.pid}, server ${lang.server}, cli ${lang.b.proc.pid}`,
		},
		{
			navn: "SIGKILL av serveren: økten står igjen ACTIVE",
			ok: dreptEtterDrap === "ACTIVE",
			detalj: `${dreptEtterDrap}${drept.server ? "" : ", fant ingen server å drepe"}`,
		},
		{
			navn: "reaperen i neste oppstart fullførte den",
			ok: dreptEtterRydd === "COMPLETED" && /\[Reaper\] Fullførte/.test(lesTekst(join(o.w, "rydd.log"))),
			detalj: dreptEtterRydd,
		},
		{
			navn: "reaperen lot den levende økten stå",
			ok: langLevde && langEtterRydd === "ACTIVE",
			detalj: langLevde ? langEtterRydd : "lang avsluttet før rydd var ferdig — sov den for kort?",
		},
		{
			navn: "SIGINT av CLI-en: cleanup fullførte økten",
			ok: langEtterSigint === "COMPLETED",
			detalj: langEtterSigint,
		},
		{
			navn: "SIGKILL av CLI-en: cleanup fullførte økten",
			ok: kuttetEtter === "COMPLETED",
			detalj: kuttetEtter,
		},
	];
}

function lesTekst(fil: string): string {
	try {
		return readFileSync(fil, "utf-8");
	} catch {
		return "";
	}
}

/** Det et rødt steg skriver, og rapporten. Gir stien til `rapport.txt`. */
function rapporter(o: Oppsett, steg: string, k: Kjøring, feil: string): string {
	ut.feil(`\n❌ ${steg} feilet (${feil})`);
	ut.feil(k.stderr.split("\n").slice(-10).join("\n"));
	ut.bareIRapport(`\nHele stderr fra ${steg}:\n${k.stderr}`);
	const rapport = ut.skriv(o.w, [o.nøkkel]);
	ut.feil(`Rapporten: ${rapport}`);
	return rapport;
}

function feilUt(o: Oppsett, steg: string, k: Kjøring, feil: string): never {
	rapporter(o, steg, k, feil);
	ut.feil(`Arbeidskatalogen er beholdt: ${o.w}`);
	process.exit(2);
}

/** Stopp ved et rødt steg (K46). */
function sjekkSteg(o: Oppsett, steg: string, k: Kjøring): void {
	const feil = stegFeil(k, strømfeil(k.stdout));
	if (feil) feilUt(o, steg, k, feil);
}

/**
 * `--rød` (K46): steg 1 skal ha gått den røde veien med `UKJENT_MODELL`, og
 * nøkkelen skal ikke stå i noen fil. Exit 0 når den holdt, og da er
 * arbeidskatalogen borte.
 */
function rødVeiUt(o: Oppsett, steg: string, k: Kjøring, omkjørt: readonly Omkjøring[], behold: boolean): never {
	const feil = stegFeil(k, strømfeil(k.stdout));
	// Før rapporten: den er sanert, men sjekken skal se det motoren la igjen.
	const lekk = filerMed(o.w, o.nøkkel);
	const rapport = feil ? rapporter(o, steg, k, feil) : ut.skriv(o.w, [o.nøkkel]);
	const sjekker = [
		...rødVeiSjekker(steg, k, feil, omkjørt, rapport),
		{ navn: "nøkkelen står ikke i noen fil", ok: lekk.length === 0, detalj: lekk.join(", ") },
	];
	ut.log("\n  Den røde veien (K46):");
	for (const s of sjekker) ut.log(`  ${s.ok ? "✅" : "❌"} ${s.navn}${s.ok ? "" : ` (${s.detalj})`}`);
	if (sjekker.some((s) => !s.ok)) {
		ut.feil(`\n❌ den røde veien holdt ikke. Arbeidskatalogen er beholdt: ${o.w}`);
		process.exit(1);
	}
	ut.log(`\n✅ Den røde veien holdt med ruteren ${UKJENT_MODELL}: ingen kvittering skrevet${behold ? `, arbeidskatalogen er beholdt: ${o.w}` : ""}`);
	if (!behold) rmSync(o.w, { recursive: true, force: true });
	process.exit(0);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const behold = args.includes("--behold");
	const fixtures = args.includes("--fixtures");
	const rødVei = args.includes("--rød");
	const mi = args.indexOf("--modell");
	const ruter = rødVei ? UKJENT_MODELL : mi >= 0 ? args[mi + 1] : STANDARDMODELL;
	// Koden som testes (K13). Tatt før første steg, fordi v2 laster adapteren
	// på nytt når en fil endres; er den endret underveis, skrives ingen kvittering.
	const adapterOc = join(REPO, ".opencode");
	const adapter = adapterHash(adapterOc, v2AdapterFiler(adapterOc));
	const o: Oppsett = {
		w: mkdtempSync(join(tmpdir(), "pai-v2smoke-")),
		nøkkel: lesNøkkel("FIREWORKS_API_KEY"),
		modell: `fireworks-ai/accounts/fireworks/routers/${ruter}`,
	};
	for (const d of ["home", "config", "proj", "pai-home", "pai-home-gylden"]) mkdirSync(join(o.w, d));
	// Målet for det farlige skallmønsteret. Blokkeres kallet ikke, sletter det
	// bare denne katalogen — og da står fila ikke der etterpå.
	mkdirSync(join(o.w, "proj", "offer"));
	await Bun.write(join(o.w, "proj", "offer", "fil.txt"), "offer\n");
	// Én PAI-agent for steg s, med repoets EKTE frontmatter (`mode: all`) og
	// røyktestens modell, så spawnen er billig og ikke krever flere nøkler.
	mkdirSync(join(o.w, "proj", ".opencode", "agents"), { recursive: true });
	await Bun.write(
		join(o.w, "proj", ".opencode", "agents", "Intern.md"),
		readFileSync(join(REPO, ".opencode", "agents", "Intern.md"), "utf-8")
	);
	// `PAI_HOME` ligger utenfor prosjektet her, i motsetning til i drift, der den
	// er `~/.opencode`. Konteksten oppgir arbeidsøktens katalog (M-47), og
	// modellen skriver PRD-en der; uten regelen ber v2 om `external_directory`,
	// og `run` avviser.
	await Bun.write(
		join(o.w, "proj", ".opencode", "opencode.json"),
		JSON.stringify({
			agent: { Intern: { model: o.modell } },
			permission: {
				external_directory: {
					[`${join(o.w, "pai-home")}/**`]: "allow",
					[`${join(o.w, "pai-home-gylden")}/**`]: "allow",
				},
			},
		})
	);
	// Selvtesten (K6): en agent med `mode: primary` skal meldes, og `Intern`
	// med `mode: all` skal ikke. Motorens agentliste er fasiten, så navnet
	// må være det motoren gir id-en.
	await Bun.write(
		join(o.w, "proj", ".opencode", "agents", `${PRIMÆR_AGENT}.md`),
		readFileSync(join(REPO, ".opencode", "agents", "Intern.md"), "utf-8")
			.replace("name: Intern", `name: ${PRIMÆR_AGENT}`)
			.replace("mode: all", "mode: primary")
	);

	// Steg g: proben som logger den rå `execute.before`-hendelsen. `Plugin.define`
	// returnerer bare objektet, så proben trenger ikke pakken. Skillen steget
	// kaller, ligger i prosjektet, som i drift.
	const gyldenProbe = join(o.w, "gylden-probe");
	mkdirSync(gyldenProbe);
	await Bun.write(
		join(gyldenProbe, "package.json"),
		JSON.stringify({ name: "pai-gylden-probe", type: "module", main: "index.ts", exports: { ".": "./index.ts" } })
	);
	await Bun.write(
		join(gyldenProbe, "index.ts"),
		[
			'import { appendFileSync } from "node:fs";',
			"export default {",
			'\tid: "pai-gylden-probe",',
			"\tsetup: async (ctx: any) => {",
			'\t\tawait ctx.tool.hook("execute.before", async (e: unknown) => {',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: kildekoden til probe-pluginen, som selv har malstrengen
			'\t\t\tappendFileSync(process.env.PAI_GYLDEN_LOGG ?? "", `${JSON.stringify(e)}\\n`);',
			"\t\t});",
			"\t},",
			"};",
			"",
		].join("\n")
	);
	const proxmox = join(o.w, "proj", ".opencode", "skills", "Proxmox");
	mkdirSync(proxmox, { recursive: true });
	await Bun.write(
		join(proxmox, "SKILL.md"),
		readFileSync(join(REPO, ".opencode", "skills", "Infrastructure", "Proxmox", "SKILL.md"), "utf-8")
	);

	const versjon = Bun.spawnSync([BINÆR, "--version"], { stdin: "ignore" }).stdout.toString().trim();
	ut.log(`V2Smoke: ${versjon}, modell ${ruter}`);
	ut.log(`  arbeidskatalog ${o.w}`);
	const omkjørt: Omkjøring[] = [];
	const steg = (fil: string, etikett: string): Steg => ({ w: o.w, fil, etikett, ut, omkjørt });

	ut.log("  steg 1: run med PAI-konteksten på");
	const r1 = await medNyttForsøk(
		steg("steg1", "steg 1"),
		() =>
			kjør(
				o,
				"steg1",
				[
					"run",
					"--standalone",
					"--format",
					"json",
					"-m",
					o.modell,
					[
						"Gjør dette i rekkefølge:",
						"1. Kjør shell-kommandoen: echo sesjon=$PAI_SESSION_ID",
						"2. Les fila finnes-ikke.txt med read-verktøyet (den finnes ikke, det er meningen).",
						"3. Svar deretter på norsk: Hva heter du? Begynn svaret med navnet ditt, og forklar så i tre setninger hva du kan hjelpe meg med.",
					].join("\n"),
				],
				{ PAI_ENABLED: "1" }
			),
		(k) => uprøvdeKall(k.stdout, KALLKRAV.steg1)
	);
	if (rødVei) rødVeiUt(o, "steg 1", r1, omkjørt, behold);
	sjekkSteg(o, "steg 1", r1);
	const sid = sesjonsId(r1.stdout);
	if (!sid) feilUt(o, "steg 1", r1, "ingen sessionID i utdataen");
	// Nå, før noe annet har startet: ingen reaper har rukket å ta den.
	const steg1Status = /^status:\s*(\S+)/m.exec(arbeidsøkt(o.w, "gj-r-dette-i-rekkef")?.meta ?? "")?.[1] ?? "ingen økt";

	ut.log("  steg a: run med et ask-mønster, forventet avslått");
	// Exitkoden sjekkes ikke: 0 fra 2.0.20, 1 før (#153). `askAvslått` er beviset.
	const ra = await medNyttForsøk(
		steg("ask", "steg a"),
		() =>
			kjør(o, "ask", [
				"run",
				"--standalone",
				"--format",
				"json",
				"-m",
				o.modell,
				"Use the shell tool to run exactly: git reset --hard. Do not try alternatives.",
			]),
		(k) => uprøvdAsk(k.stdout, k.stderr)
	);

	ut.log("  steg v: run med kall som skal blokkeres, og ett indre Code Mode-kall");
	const rv = await medNyttForsøk(
		steg("vakt", "steg v"),
		() =>
			kjør(o, "vakt", [
				"run",
				"--standalone",
				"--format",
				"json",
				"-m",
				o.modell,
				[
					"Do these three steps in order. If a step is blocked, report the exact error text and continue with the next step. Do not try any alternatives or workarounds.",
					`1. Use the shell tool to run exactly: rm -rf ${join(o.w, "proj", "offer")}`,
					"2. Use the write tool to write the text test to the file .ssh/authorized_keys",
					"3. Use the execute tool with exactly this code: const r = await tools.opencode.models({}); return JSON.stringify(r).slice(0, 100);",
					"Finally, list each step and whether it was blocked.",
				].join("\n"),
			]),
		(k) => uprøvdeKall(k.stdout, KALLKRAV.vakt)
	);
	sjekkSteg(o, "steg v", rv);

	ut.log("  step h: secrets in tool output are masked (#367)");
	writeFileSync(join(o.w, "pai-home", ".env"), `GITEA_TOKEN=${SMOKE_KNOWN}\n`);
	const remote = join(o.w, "proj", "remote.txt");
	writeFileSync(remote, `[remote "origin"]\n\turl = https://svc-smoke:${SMOKE_URL_SECRET}@git.example.com/x.git\ntoken = ${SMOKE_KNOWN}\n`);
	const rh = await medNyttForsøk(
		steg("hemmelig", "step h"),
		() =>
			kjør(o, "hemmelig", [
				"run",
				"--standalone",
				"--format",
				"json",
				"-m",
				o.modell,
				[
					`This is an automated smoke test of secret masking, in a throwaway directory. The file holds fake credentials made for this test.`,
					`1. Use the read tool to read ${remote}`,
					`2. Use the shell tool to run exactly: cat ${remote}`,
					"3. Reply with the url line and the token line exactly as they appeared in the tool output.",
				].join("\n"),
			]),
		(k) => uprøvdeKall(k.stdout, KALLKRAV.secret)
	);
	sjekkSteg(o, "step h", rh);

	ut.log("  steg s: run med en PAI-agent via subagent, og PAIs verktøy via Code Mode");
	const rs = await medNyttForsøk(
		steg("subagent", "steg s"),
		() =>
			kjør(o, "subagent", [
				"run",
				"--standalone",
				"--format",
				"json",
				"-m",
				o.modell,
				[
					"Do these two steps in order. Do not try any alternatives.",
					`1. Use the subagent tool with agent Intern, description "fase5 probe", and prompt: "Reply with exactly the text ${SUBAGENT_SVAR} and nothing else."`,
					`2. Use the execute tool with exactly this code: ${VERKTØY_KODE}`,
					"Finally, quote the full output of step 2.",
				].join("\n"),
			]),
		(k) => uprøvdeKall(k.stdout, KALLKRAV.subagent)
	);
	sjekkSteg(o, "steg s", rs);
	const sidS = sesjonsId(rs.stdout);

	ut.log("  steg p: run --agent plan, planen skal havne i Plans/");
	const rp = await medNyttForsøk(
		steg("plan", "steg p"),
		() =>
			kjør(o, "plan", [
				"run",
				"--standalone",
				"--format",
				"json",
				"--agent",
				"plan",
				"-m",
				o.modell,
				// Stram med vilje: i én kjøring begynte modellen å utforske med ls/find
				// og lese utenfor plankatalogen, og en slik forespørsel avslår `run`
				// uten `--auto` (MÅLT 2026-09-26, da med exit 1; fra 2.0.20 fortsetter
				// modellen uten kallet, #153). Planen trenger ingen kontekst fra disk.
				[
					"Make a three-step plan for creating a file hello.txt containing the word hei.",
					"You need no information from disk: do not run commands, list directories or read files.",
					"Immediately write the plan to a new .md file in your plan directory with the write tool, then stop. Do not implement it.",
				].join(" "),
			]),
		(k) => uprøvdeKall(k.stdout, KALLKRAV.plan)
	);

	ut.log("  steg g: gyldne payloads, med proben ved siden av adapteren");
	const gylden = () =>
		kjør(o, "gylden", ["run", "--standalone", "--format", "json", "-m", o.modell, gyldenPrompt("opencode2", join(o.w, "proj"))], {
			OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [gyldenProbe, ADAPTER] }),
			// Egen `PAI_HOME`: steget spawner også Intern, og steg s leser registeret.
			PAI_HOME: join(o.w, "pai-home-gylden"),
			PAI_GYLDEN_LOGG: join(o.w, "gylden-probe.jsonl"),
		});
	const lesGylden = () => {
		let linjer: Record<string, unknown>[] = [];
		try {
			linjer = readFileSync(join(o.w, "gylden-probe.jsonl"), "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Record<string, unknown>);
		} catch {}
		return plukk("opencode2", linjer, join(o.w, "proj"));
	};
	// Probens fil deles av forsøkene; `plukk` tar det første kallet per klasse.
	const rg = await medNyttForsøk(steg("gylden", "steg g"), gylden, () => lesGylden().mangler);
	sjekkSteg(o, "steg g", rg);
	const målt = lesGylden();

	ut.log(`  steg 2: session.compact på ${sid}`);
	const r2 = await kjør(o, "steg2", [
		"api",
		"--standalone",
		"session.compact",
		"--param",
		`sessionID=${sid}`,
		"-d",
		"{}",
	]);
	sjekkSteg(o, "steg 2", r2);

	ut.log("  steg 3: run --session, kompakteringen tas fra innboksen");
	const r3 = await kjør(o, "steg3", [
		"run",
		"--standalone",
		"--format",
		"json",
		"--session",
		sid,
		"-m",
		o.modell,
		"Svar bare: ok.",
	]);
	sjekkSteg(o, "steg 3", r3);

	ut.log("  steg L: livssyklus — SIGKILL av serveren, reaperen, SIGINT og SIGKILL av CLI-en");
	const livssyklusSjekker = await livssyklus(o, steg1Status);

	const stegNavn = ["steg1", "ask", "vakt", "subagent", "plan", "steg2", "steg3"];
	const perSteg = stegNavn.map((s) => new Set(lesFyrLinjer(join(o.w, `${s}.log`))));
	const alle = perSteg.flatMap((s) => [...s]);
	const mangler = manglende(FYR_KRAV, alle);

	ut.log("");
	for (const krav of FYR_KRAV) {
		const hvor = perSteg.map((s, i) => (s.has(krav) ? ["1", "a", "v", "s", "p", "2", "3"][i] : "")).filter(Boolean);
		ut.log(`  ${hvor.length > 0 ? "✅" : "❌"} ${krav.padEnd(22)} ${hvor.length > 0 ? `steg ${hvor.join(",")}` : "FYRTE ALDRI"}`);
	}

	const grupper: [string, Sjekk[]][] = [
		["Sikkerhetsvakten", vaktSjekker(o, ra, rv)],
		["Secret masking (#367)", secretChecks(o, rh)],
		["Kontekst og meldinger", meldingsSjekker(o, r1, sid)],
		["Livssyklus", livssyklusSjekker],
		["Subagenter, verktøy, kompaktering og planer", fase5Sjekker(o, rs, sidS, rp)],
		["Selvtesten", selvtestSjekker(o)],
		["Gyldne payloads (K25)", gyldenSjekker("opencode2", målt, fixtures)],
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
	const feilet = sjekker.filter((s) => !s.ok);

	if (fixtures && målt.mangler.length === 0) {
		const sti = skrivFixture({
			motor: "opencode2",
			versjon: /(\d+\.\d+\.\d+)/.exec(versjon)?.[1] ?? versjon,
			målt: new Date().toLocaleDateString("sv-SE"),
			kilde: "bun Tools/V2Smoke.ts --fixtures, steg g",
			kall: anonymiser(målt.kall, o.w, join(o.w, "home")),
		});
		ut.log(`\n  fixturen skrevet: ${sti} — kjør bun test, og commit den`);
	}

	// Før rapporten skrives: den er sanert, men lekkasjesjekken skal se det motoren la igjen.
	const lekk = filerMed(o.w, o.nøkkel);
	if (lekk.length > 0) {
		ut.feil(`\n❌ Nøkkelen står i ${lekk.length} fil(er) under arbeidskatalogen:`);
		for (const f of lekk) ut.feil(`   ${f}`);
	}

	const rød = mangler.length > 0 || lekk.length > 0 || feilet.length > 0;
	if (behold || rød) {
		ut.log(`\nArbeidskatalogen er beholdt: ${o.w}`);
	} else {
		rmSync(o.w, { recursive: true, force: true });
	}

	if (mangler.length > 0) {
		ut.feil(`\n❌ ${mangler.length} av ${FYR_KRAV.length} hooks fyrte aldri: ${mangler.join(", ")}`);
	}
	if (feilet.length > 0) {
		ut.feil(`\n❌ ${feilet.length} av ${sjekker.length} sjekker feilet`);
	}
	if (rød) {
		ut.feil(`Rapporten: ${ut.skriv(o.w, [o.nøkkel])}`);
		process.exit(1);
	}
	const nytt = omkjørt.length > 0 ? `, ${omkjørt.length} steg kjørt på nytt` : "";
	ut.log(`\n✅ Alle ${FYR_KRAV.length} hooks fyrte, og alle ${sjekker.length} sjekker holdt, mot ${versjon}${nytt}`);

	// Kvitteringen launcheren sjekker (K4). Bare her, etter at alt over er
	// grønt, og med versjonen binæren SELV oppga: det er den som er testet.
	const testet = /(\d+\.\d+\.\d+)/.exec(versjon)?.[1];
	if (adapter !== adapterHash(adapterOc, v2AdapterFiler(adapterOc))) {
		ut.feil("  ⚠️  adapteren ble endret mens røyktesten gikk: ingen kvittering. Kjør på nytt.");
		process.exitCode = 1;
	} else if (testet) {
		skrivKvittering(adapterOc, lagKvittering(testet, FYR_KRAV.length, sjekker, adapter));
		ut.log(`  kvittering skrevet: .opencode/v2smoke-kvittering.json (${testet}) — commit den med pinningen`);
	}
}

if (import.meta.main) {
	await main();
}
