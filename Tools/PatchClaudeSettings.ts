#!/usr/bin/env bun
/**
 * PatchClaudeSettings — idempotent fletting av PAIs nøkler inn i
 * `~/.claude/settings.json`.
 *
 * REGLER, i prioritert rekkefølge:
 *
 *  1. **Rør aldri noe utenfor `env`.** `model`, `theme`, `tui` og
 *     `permissions` er brukerens domene. Permission-policy håndheves av
 *     PreToolUse-vakten, ikke herfra — se `runbooks/hooksystemet.md`.
 *  2. **Overskriv aldri en verdi brukeren allerede har satt.** Står nøkkelen
 *     der med en ANNEN verdi, rapporteres avviket og fila står urørt.
 *     `CLAUDE_CODE_ENABLE_TODO_TOOLS=false` er et gyldig valg, og en patcher
 *     som overstyrer det er en patcher man slår av.
 *  3. **Idempotent.** Andre kjøring gir null endringer.
 *
 * MÅLT 2026-09-22, og derfor IKKE her:
 *   - `enabledMcpjsonServers` gjelder PROSJEKTETS `.mcp.json`, ikke en
 *     plugins. Binærens eget skjema: «List of approved MCP servers from
 *     .mcp.json». Verifisert ende-til-ende: `claude --plugin-dir
 *     <claude-plugin> -p` ga `mcp__plugin_pai_pai__session_registry` og
 *     `…__session_results` med en `settings.json` som kun inneholdt
 *     `tui`/`theme`/`model`. Planens krav om å merge nøkkelen faller bort.
 *   - `PAI_ENABLED` hører hjemme i launcherens spawn-env, ikke her. Satt i
 *     `settings.json` ville den slått PAI på for HVER Claude Code-økt på
 *     maskinen, også de som ikke er PAI-økter.
 *   - Hemmeligheter. `.opencode/.env` har tretti nøkler; ingen av dem trengs
 *     av kjernen, og å kopiere dem inn i en fil som leses av hver økt er en
 *     sikkerhetsflate, ikke en tjeneste.
 *   - `PAI_HOME`. `getPaiHome()` faller tilbake på `~/.opencode`, som er en
 *     symlink til repoet. Nøkkelen ville bare låst en maskinspesifikk sti.
 *
 * @module Tools/PatchClaudeSettings
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Nøklene PAI trenger i `settings.json.env`. */
export const PAI_ENV: Readonly<Record<string, string>> = Object.freeze({
	/**
	 * Tasksystemet er gatet bak en modell-allowlist i binæren som Claude
	 * 5-familien ikke står i. Uten denne har modellen ingen TaskCreate.
	 * A/B-målt 2026-09-22 — se handover, «Tasksystemet er gatet».
	 */
	CLAUDE_CODE_ENABLE_TODO_TOOLS: "true",
	/**
	 * C1: Claude Code er pinnet (`pai.claudeCode` i `.opencode/package.json`),
	 * og selvoppdateringen ville flyttet den forbi pinningen. MÅLT mot 2.1.282:
	 * med nøkkelen i `env` kjører den native oppdatereren aldri, og
	 * `claude install <versjon>` virker fortsatt (bump og tilbakeføring).
	 * Gjelder hver Claude Code-økt på maskinen, med vilje: en ren `claude` som
	 * oppdaterer seg, flytter den samme symlenken som `pai --claude` bruker.
	 * `DISABLE_UPDATES` er IKKE valgt: den stenger også `claude install`.
	 */
	DISABLE_AUTOUPDATER: "1",
	/** Paritet med `shell.env` på OpenCode-siden: markerer PAI-kontekst. */
	PAI_CONTEXT: "1",
	PAI_VERSION: "3.0",
});

export type Utfall = "lagt-til" | "uendret" | "avvik";

export interface Endring {
	nøkkel: string;
	utfall: Utfall;
	ønsket: string;
	nåværende?: string;
}

export interface Flettresultat {
	resultat: Record<string, unknown>;
	endringer: Endring[];
}

/**
 * Ren fletting — rører aldri disk.
 *
 * Skilt ut fra IO slik at reglene over kan testes uten å skrive i brukerens
 * `~/.claude/settings.json`.
 */
export function flett(
	eksisterende: Record<string, unknown>,
	ønsket: Readonly<Record<string, string>> = PAI_ENV
): Flettresultat {
	const endringer: Endring[] = [];

	const gammelEnv = eksisterende.env;
	const env: Record<string, string> =
		gammelEnv && typeof gammelEnv === "object" && !Array.isArray(gammelEnv)
			? { ...(gammelEnv as Record<string, string>) }
			: {};

	for (const [nøkkel, verdi] of Object.entries(ønsket)) {
		const nåværende = env[nøkkel];
		if (nåværende === undefined) {
			env[nøkkel] = verdi;
			endringer.push({ nøkkel, utfall: "lagt-til", ønsket: verdi });
		} else if (nåværende === verdi) {
			endringer.push({ nøkkel, utfall: "uendret", ønsket: verdi, nåværende });
		} else {
			// Regel 2: brukerens verdi vinner. Rapporter, ikke overstyr.
			endringer.push({ nøkkel, utfall: "avvik", ønsket: verdi, nåværende });
		}
	}

	// Regel 1: alt annet kopieres uendret. Vi bygger et nytt objekt framfor å
	// mutere, så en innkommende referanse aldri endres under føttene på kalleren.
	return { resultat: { ...eksisterende, env }, endringer };
}

/** Leser settings.json. Manglende eller ugyldig fil gir tomt objekt. */
export function lesInnstillinger(sti: string): Record<string, unknown> {
	if (!existsSync(sti)) return {};
	try {
		const parsed = JSON.parse(readFileSync(sti, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		// En ødelagt settings.json skal ikke overskrives i stillhet.
		throw new Error(`Could not parse ${sti} as JSON — fix it first.`);
	}
}

/** Skriver atomisk: temp + rename, som resten av STATE-skrivingene. */
export function skrivInnstillinger(sti: string, innhold: Record<string, unknown>): void {
	mkdirSync(dirname(sti), { recursive: true });
	const tmp = `${sti}.tmp.${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(innhold, null, 2)}\n`, "utf-8");
	renameSync(tmp, sti);
}

export function standardSti(): string {
	return join(homedir(), ".claude", "settings.json");
}

/**
 * Flett og skriv. Returnerer endringene, og skriver kun når noe faktisk
 * mangler — en kjøring uten endringer rører ikke fila.
 */
export function patch(sti: string = standardSti(), tørrkjøring = false): Endring[] {
	const { resultat, endringer } = flett(lesInnstillinger(sti));
	const mangler = endringer.some((e) => e.utfall === "lagt-til");
	if (mangler && !tørrkjøring) skrivInnstillinger(sti, resultat);
	return endringer;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const tørrkjøring = process.argv.includes("--sjekk");
	const sti = standardSti();
	const endringer = patch(sti, tørrkjøring);

	const lagtTil = endringer.filter((e) => e.utfall === "lagt-til");
	const avvik = endringer.filter((e) => e.utfall === "avvik");

	for (const e of avvik) {
		console.error(`⚠ ${e.nøkkel}: står som «${e.nåværende}», PAI ønsker «${e.ønsket}» — rører den ikke`);
	}

	if (tørrkjøring) {
		for (const e of lagtTil) console.error(`✗ mangler: ${e.nøkkel}=${e.ønsket}`);
		if (lagtTil.length === 0 && avvik.length === 0) {
			console.log(`✓ ${sti} har alle PAI-nøklene`);
			process.exit(0);
		}
		console.error(`\nKjør: bun Tools/PatchClaudeSettings.ts`);
		process.exit(1);
	}

	if (lagtTil.length === 0) {
		console.log(`✓ ${sti} var allerede oppdatert`);
	} else {
		for (const e of lagtTil) console.log(`+ ${e.nøkkel}=${e.ønsket}`);
		console.log(`✓ Skrev ${lagtTil.length} nøkkel(er) til ${sti}`);
	}
	process.exit(avvik.length > 0 ? 1 : 0);
}
