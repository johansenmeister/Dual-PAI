/**
 * Kontrakt-test: synkskriptene finner repoet de ligger i (K48)
 *
 * `aliases.sh`, `sync-start.sh` og `sync-end.sh` hadde `~/repos/pai-opencode`
 * fast. På testmaskinen heter klonen `~/repos/pai`, så `pai-push` og `pai-pull`
 * feilet der med «No such file» (MÅLT 2026-09-29). Nå regnes repoet ut fra
 * skriptets egen plassering, og `PAI_REPO` overstyrer fortsatt.
 *
 * Kopierer `scripts/` inn i en klone med et annet navn, under en falsk `HOME`
 * der `repos/pai-opencode` ikke finnes, og kjører aliasene slik `.bashrc` gjør.
 *
 * @module tests/sync-skript-sti
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKRIPTER = join(import.meta.dir, "..", "scripts");

let rot: string;
let remote: string;
let klone: string;

function miljø(ekstra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: rot,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
		LC_ALL: "C.UTF-8",
		...ekstra,
	};
}

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], { cwd, env: miljø(), stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

/** Kjører linjene som et bash-skript på stdin, fra `rot`, så aliasene ekspanderes linje for linje. */
function skall(linjer: string[], ekstra: Record<string, string> = {}): { kode: number; ut: string; feil: string } {
	const r = Bun.spawnSync(["bash", "-s"], {
		cwd: rot,
		env: miljø(ekstra),
		stdin: new TextEncoder().encode(`${["shopt -s expand_aliases", ...linjer].join("\n")}\n`),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { kode: r.exitCode, ut: r.stdout.toString(), feil: r.stderr.toString() };
}

/** Siste commit-melding på remotens `main`. */
function remoteTopp(): string {
	return git(remote, "log", "-1", "--format=%s", "main");
}

beforeEach(() => {
	rot = mkdtempSync(join(tmpdir(), "pai-sync-sti-"));
	remote = join(rot, "remote.git");
	klone = join(rot, "repos", "ikke-pai-opencode");
	git(rot, "init", "-q", "--bare", "-b", "main", remote);
	git(rot, "clone", "-q", remote, klone);
	git(klone, "checkout", "-q", "-b", "main");
	cpSync(SKRIPTER, join(klone, "scripts"), { recursive: true });
	git(klone, "add", "-A");
	git(klone, "commit", "-q", "-m", "start");
	git(klone, "push", "-q", "-u", "origin", "main");
});

afterEach(() => {
	rmSync(rot, { recursive: true, force: true });
});

describe("synkskriptene finner repoet sitt (K48)", () => {
	test("pai-push fra aliasene committer og pusher klonen de ligger i", () => {
		writeFileSync(join(klone, "notat.md"), "hei\n");
		const r = skall([`source "${klone}/scripts/aliases.sh"`, 'pai-push "fra aliasene"']);
		expect(r.feil).not.toContain("No such file");
		expect(r.kode).toBe(0);
		expect(remoteTopp()).toBe("fra aliasene");
	});

	test("pai-pull fra aliasene henter inn i klonen de ligger i", () => {
		const annen = join(rot, "annen");
		git(rot, "clone", "-q", remote, annen);
		writeFileSync(join(annen, "ny.md"), "ny\n");
		git(annen, "add", "-A");
		git(annen, "commit", "-q", "-m", "fra en annen maskin");
		git(annen, "push", "-q");

		const r = skall([`source "${klone}/scripts/aliases.sh"`, "pai-pull"]);
		expect(r.feil).not.toContain("No such file");
		expect(r.kode).toBe(0);
		expect(git(klone, "log", "-1", "--format=%s")).toBe("fra en annen maskin");
	});

	test("PAI_REPO overstyrer plasseringen", () => {
		const annen = join(rot, "annen");
		git(rot, "clone", "-q", remote, annen);
		writeFileSync(join(annen, "annet.md"), "x\n");
		const r = skall([`bash "${klone}/scripts/sync-end.sh" "via PAI_REPO"`], { PAI_REPO: annen });
		expect(r.kode).toBe(0);
		expect(remoteTopp()).toBe("via PAI_REPO");
		expect(git(annen, "log", "-1", "--format=%s")).toBe("via PAI_REPO");
		expect(git(klone, "log", "-1", "--format=%s")).toBe("start");
	});

});
