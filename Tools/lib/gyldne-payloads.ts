/**
 * Gyldne payloads fra motorene (K25)
 *
 * Fire stumme defekter har hatt samme rot: en kjernehandler leste et felt
 * motoren aldri sender. Sensitiv-sti-vakten leste `filePath`, og Claude
 * sender `file_path` (K-09). PRD-synken leste `file_path`, og OpenCode
 * sender `filePath` (M-32). Skill-vakten leste `args.name`, og ingen av
 * motorene sender det (M-40). Subagent-verktøyet het `Agent`, ikke `Task`
 * (M-17). Kontrakttestene så ingenting, fordi de brukte args skrevet for
 * hånd, og de hadde feltet vakten ventet.
 *
 * Her er kallene tatt fra motoren selv. Røyktestene (`ClaudeSmoke` og
 * `V2Smoke`, steg G) ber modellen gjøre ett kall per verktøyklasse en
 * kjernehandler leser, og en probe-plugin logger den RÅ payloaden, slik
 * motoren leverte den til hooken. Med `--fixtures` lagres de i
 * `tests/fixtures/motor-payloads/<motor>.json`, og `tests/gyldne-payloads.test.ts`
 * kjører dem gjennom adapteren og kjernens lesere. Uten flagget sammenligner
 * røyktesten formen med den lagrede, så en motor som bytter feltnavn, blir
 * rød ved neste bump, ikke i drift. Rødt er bare et felt handlerne leser som
 * er borte; et nytt eller utelatt valgfritt felt er en merknad (K54).
 *
 * Plukkingen bruker en MARKØR i verdien, aldri feltnavnet: det er feltnavnet
 * som måles, og en plukking som leste `file_path` ville bare funnet det den
 * allerede trodde.
 *
 * @module Tools/lib/gyldne-payloads
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type Motor = "claude" | "opencode2";

/** Verktøyklassene en kjernehandler leser args fra. */
export type Klasse = "shell" | "write" | "edit" | "skill" | "subagent";
export const KLASSER: readonly Klasse[] = ["shell", "write", "edit", "skill", "subagent"];

/**
 * Det modellen ble bedt om, med kjernens begreper. Testen krever at kjernens
 * leser for klassen gir nøyaktig dette, ikke en standardverdi.
 */
export interface Forventet {
	kommando?: string;
	sti?: string;
	innhold?: string;
	gammel?: string;
	ny?: string;
	navn?: string;
	type?: string;
	prompt?: string;
}

export interface GyldentKall {
	klasse: Klasse;
	forventet: Forventet;
	/** Den rå hook-payloaden, med temp-stiene byttet ut (`anonymiser`). */
	payload: Record<string, unknown>;
}

export interface Fixturefil {
	motor: Motor;
	versjon: string;
	målt: string;
	kilde: string;
	kall: GyldentKall[];
}

/** Stien temp-katalogen byttes ut med, så fixturen er lik fra kjøring til kjøring. */
export const PLASSHOLDER = "/tmp/pai-gylden";
const HJEM_PLASSHOLDER = "/home/bruker";

export const FIXTURE_KATALOG = join(import.meta.dir, "..", "..", "tests", "fixtures", "motor-payloads");

export function fixtureSti(motor: Motor, katalog = FIXTURE_KATALOG): string {
	return join(katalog, `${motor}.json`);
}

/** Verktøyet modellen skal bruke for hver klasse, med motorens eget navn (MÅLT). */
const VERKTØY: Record<Motor, Record<Klasse, string>> = {
	claude: { shell: "Bash", write: "Write", edit: "Edit", skill: "Skill", subagent: "Agent" },
	opencode2: { shell: "shell", write: "write", edit: "edit", skill: "skill", subagent: "subagent" },
};

/** Skillen kalles under motorens navneform: speilnavnet med prefiks, eller kildenavnet (M-40). */
const SKILL: Record<Motor, string> = { claude: "pai:infrastructure-proxmox", opencode2: "Proxmox" };

export const SUBAGENT_SVAR = "GYLDEN-SVAR";
const SKALL_MARKØR = "pai-gylden-skall";
const FIL = "gylden.txt";
const FØR = "gylden-for";
const ETTER = "gylden-etter";

interface Bestilling {
	forventet: Forventet;
	/** Står i den serialiserte args-verdien til riktig kall. Verktøynavnet skiller write fra edit. */
	markør: string;
}

/** Det røyktesten ber om, per klasse. `proj` er katalogen modellen jobber i. */
export function bestilling(motor: Motor, proj: string): Record<Klasse, Bestilling> {
	const sti = join(proj, FIL);
	return {
		shell: { forventet: { kommando: `echo ${SKALL_MARKØR}` }, markør: SKALL_MARKØR },
		write: { forventet: { sti, innhold: FØR }, markør: FØR },
		edit: { forventet: { sti, gammel: FØR, ny: ETTER }, markør: ETTER },
		skill: { forventet: { navn: SKILL[motor] }, markør: SKILL[motor] },
		subagent: { forventet: { type: "Intern", prompt: SUBAGENT_SVAR }, markør: SUBAGENT_SVAR },
	};
}

/** Prompten for steg G. Ett kall per klasse, i en rekkefølge der edit har en fil å endre. */
export function gyldenPrompt(motor: Motor, proj: string): string {
	const v = VERKTØY[motor];
	const sti = join(proj, FIL);
	const agentFelt = motor === "claude" ? "subagent_type" : "agent";
	return [
		`This is an automated smoke test that records tool-call payloads, in a throwaway temporary directory (${proj}).`,
		"Do these five steps in order, each exactly once, with exactly these values. Do not read, list or explore anything else.",
		`1. Use the ${v.shell} tool to run exactly: echo ${SKALL_MARKØR}`,
		`2. Use the ${v.write} tool to write the text ${FØR} to the file ${sti}`,
		`3. Use the ${v.edit} tool on ${sti} to replace ${FØR} with ${ETTER}`,
		`4. Use the ${v.skill} tool to load the skill ${SKILL[motor]}. Only load it; do not follow its instructions.`,
		// «Uten prefiks»: Haiku valgte én gang `pai:Intern` selv, og da prøver
		// fixturen ikke agent-aliaset (M-44), som skriver om det bare navnet.
		`5. Use the ${v.subagent} tool with ${agentFelt} exactly Intern (the bare name, without any prefix), description "gylden", and prompt: "Reply with exactly the text ${SUBAGENT_SVAR} and nothing else."`,
		"Finally, reply with the single word: ferdig.",
	].join("\n");
}

/** Verktøynavn og args i en rå payload, med motorens egne toppnivåfelt (MÅLT). */
export function verktøyOgArgs(motor: Motor, payload: Record<string, unknown>): { tool: string; args: unknown } {
	return motor === "claude"
		? { tool: String(payload.tool_name ?? ""), args: payload.tool_input }
		: { tool: String(payload.tool ?? ""), args: payload.input };
}

/**
 * Plukk ett kall per klasse fra probens linjer: det første med riktig
 * verktøynavn og markøren i args.
 */
export function plukk(
	motor: Motor,
	linjer: Record<string, unknown>[],
	proj: string
): { kall: GyldentKall[]; mangler: Klasse[] } {
	const b = bestilling(motor, proj);
	const kall: GyldentKall[] = [];
	const mangler: Klasse[] = [];
	for (const klasse of KLASSER) {
		const treff = linjer.find((p) => {
			const { tool, args } = verktøyOgArgs(motor, p);
			return tool === VERKTØY[motor][klasse] && JSON.stringify(args ?? null).includes(b[klasse].markør);
		});
		if (treff) kall.push({ klasse, forventet: b[klasse].forventet, payload: treff });
		else mangler.push(klasse);
	}
	return { kall, mangler };
}

/**
 * Bytt temp-katalogen og hjemmekatalogen ut, overalt i verdien. Katalognavnet
 * byttes også alene: Claude Code legger det i transkriptstien som en slug
 * (`-tmp-pai-claudesmoke-XXXX-proj`).
 */
export function anonymiser<T>(verdi: T, tempKatalog: string, hjem: string): T {
	let tekst = JSON.stringify(verdi);
	for (const [fra, til] of [
		[tempKatalog, PLASSHOLDER],
		[basename(tempKatalog), basename(PLASSHOLDER)],
		[hjem, HJEM_PLASSHOLDER],
	]) {
		if (fra) tekst = tekst.split(fra).join(til);
	}
	return JSON.parse(tekst) as T;
}

/** Formen per klasse: verktøynavnet og de sorterte arg-nøklene. Det er dette handlerne leser. */
export function form(motor: Motor, kall: GyldentKall[]): Record<string, string> {
	const ut: Record<string, string> = {};
	for (const k of kall) {
		const { tool, args } = verktøyOgArgs(motor, k.payload);
		const nøkler = args && typeof args === "object" ? Object.keys(args).sort().join(",") : typeof args;
		ut[k.klasse] = `${tool}(${nøkler})`;
	}
	return ut;
}

function argsAv(motor: Motor, kall: GyldentKall): Record<string, unknown> {
	const { args } = verktøyOgArgs(motor, kall.payload);
	return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

/**
 * Nøklene i kallet som bærer en verdi fra `forventet`: det er dem handlerne
 * leser. Funnet på verdien, som `plukk`, aldri på navnet. En eksakt lik verdi
 * vinner, ellers en som inneholder den (subagentens prompt), så Claudes
 * `description` («Run echo …») ikke regnes med for skallets kommando.
 */
export function lesteNøkler(motor: Motor, kall: GyldentKall): string[] {
	const strenger = Object.entries(argsAv(motor, kall)).filter((e): e is [string, string] => typeof e[1] === "string");
	const lest = new Set<string>();
	for (const v of Object.values(kall.forventet)) {
		if (!v) continue;
		const eksakt = strenger.filter(([, a]) => a === v);
		for (const [n] of eksakt.length > 0 ? eksakt : strenger.filter(([, a]) => a.includes(v))) lest.add(n);
	}
	return [...lest].sort();
}

/**
 * Formen målt mot fixturen (K54). Rødt (`avvik`) når verktøynavnet er et
 * annet, eller en nøkkel handlerne leser i fixturen mangler i det målte
 * kallet: det er en omdøping som `file_path` → `path`. En ny nøkkel, eller en
 * valgfri som modellen lot være, er en `merknad`: Haiku sendte én gang
 * `run_in_background: false` i `Agent` mot samme motorversjon, og det var
 * modellens valg, ikke motoren.
 */
export function formAvvik(
	motor: Motor,
	lagret: GyldentKall[],
	målt: GyldentKall[]
): { avvik: string[]; merknader: string[] } {
	const før = form(motor, lagret);
	const nå = form(motor, målt);
	const avvik: string[] = [];
	const merknader: string[] = [];
	for (const klasse of KLASSER) {
		const l = lagret.find((k) => k.klasse === klasse);
		const m = målt.find((k) => k.klasse === klasse);
		if (!l || !m || verktøyOgArgs(motor, l.payload).tool !== verktøyOgArgs(motor, m.payload).tool) {
			if (før[klasse] !== nå[klasse]) avvik.push(`${klasse}: ${før[klasse] ?? "mangler"} → ${nå[klasse] ?? "mangler"}`);
			continue;
		}
		const lNøkler = Object.keys(argsAv(motor, l));
		const mNøkler = Object.keys(argsAv(motor, m));
		const borte = lesteNøkler(motor, l).filter((n) => !mNøkler.includes(n));
		if (borte.length > 0) {
			avvik.push(`${klasse}: ${før[klasse]} → ${nå[klasse]} (handlerne leser ${borte.join(",")})`);
			continue;
		}
		const nye = mNøkler.filter((n) => !lNøkler.includes(n)).sort();
		const utelatt = lNøkler.filter((n) => !mNøkler.includes(n)).sort();
		if (nye.length > 0) merknader.push(`${klasse}: ny nøkkel ${nye.join(",")}`);
		if (utelatt.length > 0) merknader.push(`${klasse}: uten ${utelatt.join(",")}`);
	}
	return { avvik, merknader };
}

export function lesFixture(motor: Motor, katalog = FIXTURE_KATALOG): Fixturefil | null {
	const sti = fixtureSti(motor, katalog);
	if (!existsSync(sti)) return null;
	try {
		return JSON.parse(readFileSync(sti, "utf-8")) as Fixturefil;
	} catch {
		return null;
	}
}

export function skrivFixture(fil: Fixturefil, katalog = FIXTURE_KATALOG): string {
	mkdirSync(katalog, { recursive: true });
	const sti = fixtureSti(fil.motor, katalog);
	writeFileSync(sti, `${JSON.stringify(fil, null, "\t")}\n`);
	return sti;
}

/**
 * Sjekkene steg G gir røyktesten, og fixturen som skal skrives, når alle
 * klassene er fanget og `--fixtures` er gitt.
 */
export function gyldenSjekker(
	motor: Motor,
	målt: { kall: GyldentKall[]; mangler: Klasse[] },
	lagre: boolean,
	katalog = FIXTURE_KATALOG
): { navn: string; ok: boolean; detalj?: string; merknad?: string }[] {
	const lagret = lesFixture(motor, katalog);
	const alle = målt.mangler.length === 0;
	const sjekker: { navn: string; ok: boolean; detalj?: string; merknad?: string }[] = [
		{
			navn: `gyldne payloads: modellen gjorde ett kall per klasse (${KLASSER.join(", ")})`,
			ok: alle,
			detalj: alle ? undefined : `mangler ${målt.mangler.join(", ")}`,
		},
	];
	if (lagre) return sjekker;
	const { avvik, merknader } = lagret ? formAvvik(motor, lagret.kall, målt.kall) : { avvik: [], merknader: [] };
	sjekker.push({
		navn: "gyldne payloads: feltene handlerne leser er de samme som i fixturen (K25, K54)",
		ok: lagret !== null && alle && avvik.length === 0,
		detalj: !lagret
			? `${fixtureSti(motor, katalog)} mangler: kjør med --fixtures`
			: `${avvik.join("; ")}. Motoren har endret feltene: kjør med --fixtures, og så bun test`,
		merknad:
			merknader.length > 0 ? `${merknader.join("; ")} (ikke rødt: valgfrie felt; --fixtures tar dem med)` : undefined,
	});
	return sjekker;
}
