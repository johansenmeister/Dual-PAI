/**
 * K57 i `pai doctor`: de skrivebeskyttede speilene er rene
 *
 * Sikkerhetsvakten nekter `write`/`edit` under stiene i
 * `PAI/USER/SKRIVEBESKYTTET.json`, men ikke Bash-omveien (`sed -i`, `>`, `cp`,
 * `tee`), og en regex-vakt for Bash er et ikke-mål. Her sjekkes resultatet i
 * stedet: `git status --porcelain` og `git stash list` i hvert repo under
 * stiene. En lokal endring blir en autostash-konflikt ved neste synk; en
 * stash-oppføring er en autostash som ikke gikk inn igjen.
 *
 * Bare rapport (regel 2): å forkaste endringer i et repo er brukerens valg,
 * så doctoren skriver kommandoen og kjører den ikke. Regel 1: en sti som ikke
 * finnes på denne maskinen, er taus.
 *
 * @module PAI/Tools/speil-helse
 */

import { spawnSync } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lesSkrivebeskyttet } from "../../pai-core/lib/skrivebeskyttet";

export interface SpeilHelse {
	/** Én linje per repo med lokale endringer eller stash-oppføringer. */
	problemer: string[];
	/** Det sjekken ikke fikk gjort. */
	varsler: string[];
	/** Stiene i konfigen, og repoene som ble sjekket. */
	stier: number;
	repoer: number;
}

/** Roten selv hvis den er et repo, ellers repoene rett under (`example-work-docs/infra-docs`). */
export function reposUnder(rot: string): string[] {
	if (existsSync(join(rot, ".git"))) return [rot];
	try {
		return readdirSync(rot, { withFileTypes: true })
			.filter((d) => d.isDirectory() && existsSync(join(rot, d.name, ".git")))
			.map((d) => join(rot, d.name))
			.sort();
	} catch {
		return [];
	}
}

function git(repo: string, ...args: string[]): string[] | null {
	const r = spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) return null;
	return r.stdout
		.toString()
		.split("\n")
		.filter((l) => l.trim() !== "");
}

export function speilHelse(paiDir: string): SpeilHelse {
	const { stier } = lesSkrivebeskyttet(paiDir);
	const h: SpeilHelse = { problemer: [], varsler: [], stier: stier.length, repoer: 0 };
	for (const rot of stier) {
		if (!existsSync(rot)) continue;
		const repoer = reposUnder(rot);
		if (repoer.length === 0) {
			h.varsler.push(`${rot} is read-only, but has no git repo to check`);
			continue;
		}
		for (const repo of repoer) {
			h.repoer++;
			const status = git(repo, "status", "--porcelain");
			const stash = git(repo, "stash", "list");
			if (status === null || stash === null) {
				h.varsler.push(`could not run git in ${repo}`);
				continue;
			}
			if (status.length > 0)
				h.problemer.push(
					`${repo}: ${status.length} local change(s) in a read-only mirror. Make the change in the source, and discard it here: git -C ${repo} reset --hard && git -C ${repo} clean -fd`
				);
			if (stash.length > 0)
				h.problemer.push(
					`${repo}: ${stash.length} stash entry(ies), probably an autostash that did not apply. Inspect with git -C ${repo} stash show -p, remove with git -C ${repo} stash clear`
				);
		}
	}
	return h;
}
