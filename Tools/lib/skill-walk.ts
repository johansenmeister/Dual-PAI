/**
 * Skill-treet — én traversering, to konsumenter
 *
 * Trukket ut av `PAI/Tools/GenerateSkillIndex.ts`, som allerede håndterte
 * det som er vanskelig her: `.opencode/skills/` inneholder symlinker, og en
 * av dem (`skills/PAI` → `.opencode/PAI`) peker inn i et tre som peker
 * tilbake. Uten syklusvakten går traverseringen i ring.
 *
 * Grunnen til at den er felles og ikke kopiert: `BuildClaudePlugin.ts` og
 * `GenerateSkillIndex.ts` må se NØYAKTIG det samme settet. Ser generatoren
 * en skill indeksen ikke kjenner, får Claude-siden en skill ingen kan slå
 * opp; ser indeksen en generatoren ikke kjenner, mangler den på Claude-siden
 * uten at noe sier fra. To traverseringer er to steder å glemme en katalog.
 *
 * @module Tools/lib/skill-walk
 */

import { type Dirent, existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Én skill, slik den ligger i kilden. */
export interface KildeSkill {
	/** Absolutt sti til `SKILL.md`. */
	skillMd: string;
	/** Absolutt sti til katalogen som eier `SKILL.md`. */
	dir: string;
	/** Kataloger fra `skills/` og ned, f.eks. `["Infrastructure", "Proxmox"]`. */
	segmenter: string[];
}

/**
 * Kataloger som aldri er en skill.
 *
 * `PAI` er ikke en utelatelse av latskap: den er en symlink til
 * `.opencode/PAI`, altså hele PAI-systemet, og den går inn i Claude-sesjonen
 * via `SessionStart → additionalContext` i stedet — eksakt slik den går inn
 * i OpenCode via `system.push`. Speiles den OGSÅ som skill, ville de ~26 KB
 * ligget i konteksten to ganger.
 */
export const IKKE_SKILLS = new Set(["PAI", "node_modules"]);

/**
 * Finn alle `SKILL.md` under `skillsDir`.
 *
 * Følger symlinkede kataloger (oppstrøms 1d2fcb5), men besøker hver
 * kanoniske sti kun én gang.
 *
 * @param skillsDir Absolutt sti til `skills/`.
 * @returns Sortert på `segmenter`, så utdata er stabilt mellom kjøringer —
 *   en generator som emitterer i katalogrekkefølge gir ellers diff-støy
 *   avhengig av filsystemet.
 */
export async function finnSkills(skillsDir: string): Promise<KildeSkill[]> {
	const funnet: KildeSkill[] = [];
	await gå(skillsDir, [], new Set(), funnet);
	funnet.sort((a, b) => a.segmenter.join("/").localeCompare(b.segmenter.join("/")));
	return funnet;
}

async function gå(
	dir: string,
	segmenter: string[],
	besøkt: Set<string>,
	ut: KildeSkill[]
): Promise<void> {
	let kanonisk: string;
	try {
		kanonisk = await realpath(dir);
	} catch {
		// Brutt symlink. Ikke en feil verdt å stoppe for — den finnes i treet
		// allerede, og GenerateSkillIndex har hoppet over den i månedsvis.
		return;
	}
	if (besøkt.has(kanonisk)) return;
	besøkt.add(kanonisk);

	// Eksplisitt `Dirent[]`, ikke `Awaited<ReturnType<typeof readdir>>`: `readdir` er
	// overlastet, og ReturnType plukker den SISTE overlasten — Buffer-varianten.
	// Kallet under gir `Dirent<string>[]`, som da ikke lot seg tilordne.
	let innhold: Dirent[];
	try {
		innhold = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const oppføring of innhold) {
		if (oppføring.name.startsWith(".")) continue;
		if (IKKE_SKILLS.has(oppføring.name)) continue;

		const full = join(dir, oppføring.name);
		let erKatalog = oppføring.isDirectory();
		if (oppføring.isSymbolicLink()) {
			try {
				erKatalog = (await stat(full)).isDirectory();
			} catch {
				continue;
			}
		}
		if (!erKatalog) continue;

		const nyeSegmenter = [...segmenter, oppføring.name];
		const skillMd = join(full, "SKILL.md");
		if (existsSync(skillMd)) {
			ut.push({ skillMd, dir: full, segmenter: nyeSegmenter });
		}

		await gå(full, nyeSegmenter, besøkt, ut);
	}
}

/**
 * `PascalCase` → `kebab-case`, med akronymer intakt.
 *
 * De to erstatningene gjør hver sin jobb, og begge trengs:
 * `TrueNAS` → `true-nas` krever den første (liten→stor), `SECUpdates` →
 * `sec-updates` krever den andre (stor+stor→stor+liten). Med bare den ene
 * blir `SECUpdates` til `secupdates`, som er et navn ingen ville gjettet.
 */
export function tilKebab(navn: string): string {
	return navn
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.toLowerCase();
}

/** Skill-navnet Claude Code adresserer speilet med (uten `pai:`-prefiks). */
export function flattNavn(segmenter: string[]): string {
	return segmenter.map(tilKebab).join("-");
}

export { basename, dirname };
