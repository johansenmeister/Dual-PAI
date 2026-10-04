#!/usr/bin/env bun
/**
 * identity.ts — skriv navnene og tidssonen fra identitetsintervjuet (#162)
 *
 * Kjøreplanen (`SETUP.md`) spør brukeren, og dette verktøyet skriver svarene,
 * så det som må være riktig ikke avhenger av at en gratismodell redigerer tre
 * filer likt. Navnet står tre steder, og alle leses:
 *
 * - `.opencode/settings.json`: `daidentity.name`, `principal.name`,
 *   `principal.timezone` (hookene og varslene, `pai-core/lib/identity.ts`).
 * - `.opencode/PAI/USER/DAIDENTITY.md`: identiteten modellen får i konteksten.
 *   Installeren skriver bare `settings.json`, og `install-fresh.md` kaller det
 *   en «kritisk felle»: modellen svarte med det gamle navnet.
 * - `opencode.json`: `username`, navnet TUI-en viser.
 *
 * Det gamle navnet leses fra `**Name:**`-linja (samme regel som røyktestene) og
 * byttes overalt i `DAIDENTITY.md`. Personligheten og tonen skriver modellen
 * inn selv etterpå, med brukerens ord; det er ikke et felt med ett riktig svar.
 *
 * `--from-repo` er maskin nummer to (#221): repoet er allerede satt opp, så
 * navnene leses fra `DAIDENTITY.md` (`**Name:**` og `**Principal:**`), og bare
 * den maskinlokale `settings.json` skrives. De sporede filene står urørt, så
 * neste `pai-push` sprer ingen tilbakestilling. Tidssonen er maskinens, eller
 * `--timezone`.
 *
 * `--first-run` er den første maskinen, før intervjuet: `install.sh` lager
 * `settings.json` med navnet fra identiteten som følger med (malens «Juno»)
 * og «User» som prinsipal, til kjøreplanen spør etter de ekte navnene. Som
 * `--from-repo` rører den ingen sporet fil; mangler `DAIDENTITY.md`, leses malen.
 * Før fase 4 av #162 gjorde `PAI-Install/install.sh --headless --fresh` dette.
 *
 * Bruk:
 *   bun PAI-Install/cli/identity.ts --ai-name <navn> --user-name <navn> --timezone <IANA-sone>
 *   bun PAI-Install/cli/identity.ts --from-repo [--timezone <IANA-sone>]
 *   bun PAI-Install/cli/identity.ts --first-run [--timezone <IANA-sone>]
 *   bun PAI-Install/cli/identity.ts --show
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `pai.version` i `settings.json`; `BuildAGENTS`, `BuildOpenCode` og `Banner` leser den. */
export const PAI_VERSION = "4.0.3";

/** Prinsipalen før intervjuet, når identiteten ikke har noen. */
export const FORELØPIG_PRINSIPAL = "User";

const REPO = join(import.meta.dir, "..", "..");

export interface Identitet {
	aiNavn: string;
	brukernavn: string;
	tidssone: string;
}

/** `**Name:**`-linja, med og uten listestrek. Samme regel som `lesDaNavn` i V2Smoke. */
export function navnILinja(tekst: string): string {
	return /^\s*(?:[-*]\s+)?\*\*Name:\*\*\s*(.+?)\s*$/m.exec(tekst)?.[1] ?? "";
}

/** Feilmeldingen for et navn som ikke kan stå i en markdown-linje, eller null. */
export function ugyldigNavn(navn: string): string | null {
	if (navn.trim().length === 0) return "the name is empty";
	if (navn.length > 40) return "the name is longer than 40 characters";
	if (/[\n\r*`|<>]/.test(navn)) return "the name cannot contain line breaks or * ` | < >";
	return null;
}

export function gyldigTidssone(sone: string): boolean {
	try {
		new Intl.DateTimeFormat("en", { timeZone: sone });
		return sone.includes("/") || sone === "UTC";
	} catch {
		return false;
	}
}

/** Bytt det gamle navnet med det nye overalt i identitetsfila, som hele ord. */
export function medNyttNavn(tekst: string, nytt: string): string {
	const gammelt = navnILinja(tekst);
	if (!gammelt) throw new Error("DAIDENTITY.md has no **Name:** line");
	const mønster = new RegExp(`(?<![\\p{L}\\p{N}])${gammelt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");
	return tekst.replace(mønster, nytt);
}

/** `**Principal:**`-linja får brukerens navn; malen har «the user». Uten linja står teksten. */
export function medPrinsipal(tekst: string, navn: string): string {
	return tekst.replace(/^(\s*(?:[-*]\s+)?\*\*Principal:\*\*\s*).*$/m, (_, start: string) => `${start}${navn}`);
}

/** `**Principal:**`-linja, eller "" (malen har «the user», som ikke er et navn). */
export function prinsipalILinja(tekst: string): string {
	const navn = /^\s*(?:[-*]\s+)?\*\*Principal:\*\*\s*(.+?)\s*$/m.exec(tekst)?.[1] ?? "";
	return navn === "the user" ? "" : navn;
}

/** Maskinens tidssone, eller UTC. */
export function maskinensTidssone(): string {
	const sone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return sone && gyldigTidssone(sone) ? sone : "UTC";
}

/** Flett inn i `settings.json`; alt annet står. */
export function medInnstillinger(s: Record<string, unknown>, id: Identitet): Record<string, unknown> {
	const principal = { ...((s.principal as object) ?? {}), name: id.brukernavn, timezone: id.tidssone };
	const daidentity = { ...((s.daidentity as object) ?? {}), name: id.aiNavn };
	return { ...s, principal, daidentity };
}

function lesJson(fil: string): Record<string, unknown> {
	return existsSync(fil) ? JSON.parse(readFileSync(fil, "utf-8")) : {};
}

function verdi(args: string[], flagg: string): string | undefined {
	const i = args.indexOf(flagg);
	return i >= 0 ? args[i + 1] : undefined;
}

function main(): number {
	const args = process.argv.slice(2);
	const innstillinger = join(REPO, ".opencode", "settings.json");
	const daFil = join(REPO, ".opencode", "PAI", "USER", "DAIDENTITY.md");
	const mal = join(REPO, ".opencode", "PAI", "DAIDENTITY.template.md");
	const konfig = realpathSync(join(REPO, "opencode.json"));

	if (args.includes("--show")) {
		const s = lesJson(innstillinger) as { principal?: { name?: string; timezone?: string }; daidentity?: { name?: string } };
		const da = existsSync(daFil) ? navnILinja(readFileSync(daFil, "utf-8")) : "(missing)";
		console.log(`assistant name: ${da} (DAIDENTITY.md), ${s.daidentity?.name ?? "(not set)"} (settings.json)`);
		console.log(`your name:      ${s.principal?.name ?? "(not set)"}`);
		console.log(`time zone:      ${s.principal?.timezone ?? "(not set)"}`);
		return 0;
	}

	const førstegang = args.includes("--first-run");
	if (førstegang || args.includes("--from-repo")) {
		const flagg = førstegang ? "--first-run" : "--from-repo";
		const kilde = existsSync(daFil) ? daFil : førstegang ? mal : "";
		if (!kilde) {
			console.error(`--from-repo: ${daFil} is missing`);
			return 1;
		}
		const da = readFileSync(kilde, "utf-8");
		const id: Identitet = {
			aiNavn: navnILinja(da),
			brukernavn: prinsipalILinja(da) || String(lesJson(konfig).username ?? "").trim() || (førstegang ? FORELØPIG_PRINSIPAL : ""),
			tidssone: (verdi(args, "--timezone") ?? "").trim() || maskinensTidssone(),
		};
		const feil = ugyldigNavn(id.aiNavn) ?? ugyldigNavn(id.brukernavn);
		if (feil || !gyldigTidssone(id.tidssone)) {
			console.error(`${flagg}: could not read the names from ${kilde === mal ? "DAIDENTITY.template.md" : "DAIDENTITY.md"} (${feil ?? `time zone ${id.tidssone}`})`);
			return 1;
		}
		const s = lesJson(innstillinger);
		writeFileSync(innstillinger, `${JSON.stringify(medInnstillinger({ pai: { version: PAI_VERSION }, ...s }, id), null, 2)}\n`);
		console.log(`✓ ${id.aiNavn}, with ${id.brukernavn} as principal (${id.tidssone}), in settings.json`);
		return 0;
	}

	const id: Identitet = {
		aiNavn: (verdi(args, "--ai-name") ?? "").trim(),
		brukernavn: (verdi(args, "--user-name") ?? "").trim(),
		tidssone: (verdi(args, "--timezone") ?? "").trim(),
	};
	for (const [flagg, navn] of [["--ai-name", id.aiNavn], ["--user-name", id.brukernavn]] as const) {
		const feil = ugyldigNavn(navn);
		if (feil) {
			console.error(`${flagg}: ${feil}`);
			return 1;
		}
	}
	if (!gyldigTidssone(id.tidssone)) {
		console.error(`--timezone: "${id.tidssone}" is not an IANA time zone such as Europe/Oslo or America/New_York`);
		return 1;
	}

	const kilde = existsSync(daFil) ? daFil : mal;
	writeFileSync(daFil, medPrinsipal(medNyttNavn(readFileSync(kilde, "utf-8"), id.aiNavn), id.brukernavn));
	writeFileSync(innstillinger, `${JSON.stringify(medInnstillinger(lesJson(innstillinger), id), null, 2)}\n`);
	writeFileSync(konfig, `${JSON.stringify({ ...lesJson(konfig), username: id.brukernavn }, null, 2)}\n`);

	console.log(`✓ ${id.aiNavn}, with ${id.brukernavn} as principal, in DAIDENTITY.md; ${id.aiNavn} in settings.json`);
	console.log(`✓ ${id.brukernavn}, ${id.tidssone} in settings.json; ${id.brukernavn} as username in opencode.json`);
	console.log("The new name is used from the next session (restart PAI).");
	return 0;
}

if (import.meta.main) process.exit(main());
