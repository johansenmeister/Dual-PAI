/**
 * Kontrakt-test: speilet skal ikke være maskinavhengig (M-28)
 *
 * `claude-plugin/skills/` er GENERERT og SPORET i git. Symlenker generatoren
 * noe som bare finnes lokalt, blir lenka committet av `sync-end.sh`
 * (`git add -A`) — og de andre maskinene får en DINGLENDE symlink som peker
 * på noe de ikke har.
 *
 * Målt 2026-09-23: `MusicLibrary/Tools` er gitignorert og finnes kun på
 * pc-en. Speilet hadde 250 lenker der mot 249 på `pai` og testmaskinen, og
 * `git status` på pc-en viste `?? claude-plugin/skills/music-library/Tools`.
 *
 * Motsatt retning (K42): det generatoren skriver, må også være SPORET, ellers
 * mangler det i en fersk klone selv om disken her er komplett.
 *
 * Planen advarte mot nøyaktig dette: «Det ville gjort utdata maskinavhengig,
 * og friskhetstesten sammenligner generert utdata mot disk.»
 *
 * @module tests/speil-maskinuavhengig
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

/**
 * Stiene git faktisk sporer under `katalog`.
 *
 * `null` når treet ikke er et git-repo. Det er ikke en feil: harnesset skal
 * kunne distribueres som en tarball, og `byggPlan` er fail-open i nøyaktig
 * det tilfellet — den tar med alt når git ikke svarer. En test som PÅSTÅR
 * noe der ville feilet på en korrekt installasjon.
 */
async function sporede(katalog: string): Promise<Set<string> | null> {
	const proc = Bun.spawn(["git", "ls-files", "-z", "--", katalog], {
		cwd: REPO,
		stdout: "pipe",
		stderr: "ignore",
	});
	const ut = await new Response(proc.stdout).text();
	const kode = await proc.exited;
	if (kode !== 0) return null;
	return new Set(ut.split("\0").filter(Boolean));
}

function erSporet(sett: Set<string>, sti: string): boolean {
	if (sett.has(sti)) return true;
	for (const s of sett) if (s.startsWith(`${sti}/`)) return true;
	return false;
}

describe("generert speil er maskinuavhengig", () => {
	test("hver planlagt symlink peker på noe git FAKTISK sporer", async () => {
		// Den brede regelen, ikke «ikke gitignorert». Tre former faller
		// utenfor sporingen og er alle maskinlokale: en TOM katalog (som var
		// den ekte defekten — git kan ikke representere dem), en gitignorert
		// katalog, og en utracket lokal fil.
		const sett = await sporede(".opencode/skills");
		if (sett === null) return; // ikke et git-tre — se `sporede`

		const { byggPlan } = await import("../Tools/BuildClaudePlugin.ts");
		const plan = await byggPlan(REPO);

		const usporede = plan.lenker
			.map((l: { sti: string; mål: string }) =>
				join(REPO, l.sti, "..", l.mål).replace(`${REPO}/`, "")
			)
			.filter((kilde: string) => !erSporet(sett, kilde));

		expect(usporede).toEqual([]);
	}, 30_000);

	test("ingen symlink i det COMMITTEDE speilet er dinglende", async () => {
		// Den andre halvdelen: selv om planen er ren, kan en lenke ha blitt
		// committet fra en maskin som hadde kilden. Da er den død her.
		const proc = Bun.spawn(["git", "ls-files", "claude-plugin/skills"], {
			cwd: REPO,
			stdout: "pipe",
			stderr: "ignore",
		});
		const filer = (await new Response(proc.stdout).text()).split("\n").filter(Boolean);
		if ((await proc.exited) !== 0) return; // ikke et git-tre

		const døde: string[] = [];
		for (const f of filer) {
			const full = join(REPO, f);
			// Bun.file().exists() følger symlinker; en dinglende gir false.
			const lstat = await import("node:fs/promises").then((m) => m.lstat(full).catch(() => null));
			if (lstat?.isSymbolicLink() && !(await Bun.file(full).exists())) {
				// Kataloger gir også false fra Bun.file — sjekk med stat.
				const finnes = await import("node:fs/promises")
					.then((m) => m.stat(full))
					.then(() => true)
					.catch(() => false);
				if (!finnes) døde.push(f);
			}
		}
		expect(døde).toEqual([]);
	}, 30_000);

	test("hver sti generatoren skriver, er sporet av git (K42)", async () => {
		// Speilbildet av M-28. PR #94 lagde to lenker for HarnessUpdate, og
		// bare én ble lagt til. `claude-mirror.test.ts` sammenligner planen med
		// DISKEN, så den var grønn, og en fersk klone manglet lenka (rettet i
		// #96). Sporet betyr i indeksen: `git add` er nok, commit trengs ikke.
		const sett = await sporede("claude-plugin");
		if (sett === null) return; // ikke et git-tre — se `sporede`

		const { byggPlan } = await import("../Tools/BuildClaudePlugin.ts");
		const plan = await byggPlan(REPO);
		const stier: string[] = [...plan.filer, ...plan.lenker].map((x: { sti: string }) => x.sti);
		expect(stier.length).toBeGreaterThan(0);
		expect(stier.filter((sti) => !sett.has(sti))).toEqual([]);
	}, 30_000);
});

/**
 * #402 (jobb #16): a new skill that git does not track yet got `SKILL.md` in
 * the mirror but none of its links, and the freshness test agreed with that
 * plan, so it stayed green. Built in a temp repo so the real tree is never
 * touched.
 */
describe("a skill git does not track yet makes the mirror check fail (#402)", () => {
	const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
	const { tmpdir } = require("node:os");

	function lagRepo(): string {
		const rot = mkdtempSync(join(tmpdir(), "speil-402-"));
		const skriv = (sti: string, innhold = "x\n") => {
			mkdirSync(join(rot, sti, ".."), { recursive: true });
			writeFileSync(join(rot, sti), innhold);
		};
		const skill = (navn: string) => `---\nname: ${navn}\ndescription: ${navn}. USE WHEN ${navn}\n---\n# ${navn}\n`;
		skriv(".opencode/profiles/claude.yaml", "default_model: inherit\n");
		skriv(".opencode/agents/Tester.md", "---\nname: Tester\ndescription: Tester\n---\n# Tester\n");
		skriv(".opencode/skills/Infrastructure/SKILL.md", skill("Infrastructure"));
		skriv(".opencode/skills/Infrastructure/Gammel/SKILL.md", skill("Gammel"));
		skriv(".opencode/skills/Infrastructure/Gammel/Tools/x.sh");
		skriv(".gitignore", "Ignorert/\n");
		git(rot, "init", "-q");
		git(rot, "add", "-A");
		// The new skill, untracked. Next to it the two M-28 forms that must
		// stay out of the mirror without failing anything: an empty directory
		// and an ignored one.
		skriv(".opencode/skills/Infrastructure/Probe/SKILL.md", skill("Probe"));
		skriv(".opencode/skills/Infrastructure/Probe/Tools/x.sh");
		mkdirSync(join(rot, ".opencode/skills/Infrastructure/Gammel/Tom"), { recursive: true });
		skriv(".opencode/skills/Infrastructure/Gammel/Ignorert/lokal.txt");
		return rot;
	}

	function git(cwd: string, ...args: string[]): void {
		const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	}

	test("untracked skill: the check names it and the fix; tracked: the check is clean", async () => {
		const rot = lagRepo();
		try {
			const { byggPlan, skrivPlan, finnDrift } = await import("../Tools/BuildClaudePlugin.ts");

			const før = await byggPlan(rot);
			expect(før.venterPåGit.sort()).toEqual([
				".opencode/skills/Infrastructure/Probe",
				".opencode/skills/Infrastructure/Probe/Tools",
			]);
			await skrivPlan(rot, før);
			const avvik = await finnDrift(rot, await byggPlan(rot));
			expect(avvik).toEqual([
				"not tracked by git yet: .opencode/skills/Infrastructure/Probe (git add -N it, then regenerate)",
				"not tracked by git yet: .opencode/skills/Infrastructure/Probe/Tools (git add -N it, then regenerate)",
			]);

			git(rot, "add", "-N", ".opencode/skills/Infrastructure/Probe");
			const etter = await byggPlan(rot);
			expect(etter.venterPåGit).toEqual([]);
			const lenker = etter.lenker.map((l) => l.sti);
			expect(lenker).toContain("claude-plugin/skills/infrastructure/Probe");
			expect(lenker).toContain("claude-plugin/skills/infrastructure-probe/Tools");
			expect(lenker.filter((l) => /Tom|Ignorert/.test(l))).toEqual([]);
			await skrivPlan(rot, etter);
			expect(await finnDrift(rot, etter)).toEqual([]);
		} finally {
			rmSync(rot, { recursive: true, force: true });
		}
	}, 30_000);
});
