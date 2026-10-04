#!/usr/bin/env bun
/**
 * Bygg den kompilerte hook-binæren
 *
 * `bun build --compile --bytecode` av `claude-plugin/bin/pai-hook.ts` til
 * `claude-plugin/bin/pai-hook.bin`. Binæren er gitignorert — den er et
 * byggeartefakt på 81 MB, ikke kildekode — og bygges av `pai claude sync` og
 * av `pai --claude` når den er stale.
 *
 * HVORFOR `--bytecode` OG IKKE BARE `--compile`: målt 2026-09-22, 20 kall per
 * sti, at `--compile` alene ikke gir noe som helst (74 → 74 ms på
 * hurtigutgangen, 89 → 90 ms på full sti). Gevinsten kommer utelukkende fra
 * `--bytecode`: 74 → 30 ms og 89 → 36 ms. Planens anslag om «~10–20 ms fra
 * --compile» var altså feil i begge retninger — mekanismen var feil, og
 * tallet var for lavt.
 *
 * SKRIVINGEN ER ATOMISK. Vi bygger til `.tmp` og gjør `rename` til slutt.
 * Uten det ville en hook som fyrer midt i et bygg kunne `exec`-e en
 * halvskrevet binær, og feilen ville sett ut som en korrupt motor framfor et
 * kappløp. Samme disiplin som `STATE/`-skrivingene i kjernen.
 *
 * @module Tools/BuildClaudeHook
 */

import { renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { BINÆRNAVN, binærSti, sjekkFerskhet } from "../claude-plugin/src/binaer";

export { sjekkFerskhet, binærSti, BINÆRNAVN };

export interface Byggeresultat {
	sti: string;
	bytes: number;
	ms: number;
}

/**
 * Bygg binæren. Kaster ved feil — kallstedet avgjør om det er fatalt.
 *
 * @param repoRot Roten av repoet, altså katalogen som inneholder både
 *   `claude-plugin/` og `.opencode/`.
 */
export async function byggHookBinær(repoRot: string): Promise<Byggeresultat> {
	const pluginRot = join(repoRot, "claude-plugin");
	const inn = join(pluginRot, "bin", "pai-hook.ts");
	const ut = binærSti(pluginRot);
	const midlertidig = `${ut}.tmp`;

	const start = Date.now();

	const proc = Bun.spawn(
		["bun", "build", "--compile", "--bytecode", inn, "--outfile", midlertidig],
		{ cwd: repoRot, stdout: "pipe", stderr: "pipe" }
	);
	const [utdata, feil, kode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (kode !== 0) {
		// Rydd bort halvfabrikatet. Lot vi det ligge, ville neste
		// ferskhetssjekk sett en fil som er nyere enn kilden og meldt «fersk»
		// om et bygg som feilet.
		try {
			rmSync(midlertidig, { force: true });
		} catch {
			/* ignorer */
		}
		throw new Error(`bun build failed (code ${kode}):\n${feil || utdata}`);
	}

	renameSync(midlertidig, ut);

	return { sti: ut, bytes: statSync(ut).size, ms: Date.now() - start };
}

/**
 * Bygg bare hvis binæren mangler eller er stale.
 *
 * @returns `null` når ingenting trengte å gjøres.
 */
export async function byggHvisStale(repoRot: string): Promise<Byggeresultat | null> {
	const f = sjekkFerskhet(repoRot);
	if (f.finnes && f.fersk) return null;
	return await byggHookBinær(repoRot);
}

if (import.meta.main) {
	const rot = join(import.meta.dir, "..");
	const r = await byggHookBinær(rot);
	console.log(`✅ ${r.sti} — ${(r.bytes / 1024 / 1024).toFixed(1)} MB på ${r.ms} ms`);
}
