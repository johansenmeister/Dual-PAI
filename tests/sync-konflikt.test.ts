/**
 * Contract test: the sync scripts stop on a conflict instead of committing it (#496)
 *
 * Two machines changed the same lines in `MEMORY/AUTO/MEMORY.md`. On one, the
 * autostash did not apply after `git pull --rebase --autostash`; git still
 * exits 0 then, so `sync-start.sh` said "✓" and the next `sync-end.sh` pushed
 * the conflict markers to `main`. On the other, the rebase stopped, and
 * `sync-end.sh` ran `git add -A` and committed on the detached HEAD mid-rebase.
 *
 * Runs the real scripts against two clones of a bare remote. Both directions
 * are checked: they stop when the repo is mid-conflict, and they stay silent
 * and sync when it is not (rule 1 in «Vaktene: tre lag»).
 *
 * @module tests/sync-konflikt
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKRIPTER = join(import.meta.dir, "..", "scripts");

// Built at runtime, so no line in this file starts with a marker itself.
const VENSTRE = "<".repeat(7);
const HØYRE = ">".repeat(7);

let rot: string;
let remote: string;
let a: string;
let b: string;

function miljø(repo: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: rot,
		PAI_REPO: repo,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
		GIT_EDITOR: "true",
		LC_ALL: "C.UTF-8",
	};
}

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], { cwd, env: miljø(cwd), stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

function kjør(skript: "sync-start.sh" | "sync-end.sh", repo: string): { kode: number; ut: string; feil: string } {
	const r = Bun.spawnSync(["bash", join(SKRIPTER, skript)], { cwd: rot, env: miljø(repo), stdout: "pipe", stderr: "pipe" });
	return { kode: r.exitCode, ut: r.stdout.toString(), feil: r.stderr.toString() };
}

function skriv(repo: string, sti: string, innhold: string): void {
	writeFileSync(join(repo, sti), innhold);
}

/** A pushes its version of `MEMORY.md`; B has its own, uncommitted. */
function sammeLinjer(): void {
	skriv(a, "MEMORY.md", "# indeks\n- fra a\n");
	git(a, "commit", "-q", "-am", "a");
	git(a, "push", "-q");
	skriv(b, "MEMORY.md", "# indeks\n- fra b\n");
}

/** B's commit, then a pull whose rebase stops on `MEMORY.md`. */
function halvferdigRebase(): void {
	sammeLinjer();
	git(b, "commit", "-q", "-am", "b");
	const r = kjør("sync-start.sh", b);
	expect(r.kode).toBe(1);
}

const remoteHead = () => git(remote, "rev-parse", "main");
const remoteHarMarkører = () => git(remote, "show", "main:MEMORY.md").includes(VENSTRE);

beforeEach(() => {
	rot = mkdtempSync(join(tmpdir(), "pai-sync-konflikt-"));
	remote = join(rot, "remote.git");
	a = join(rot, "a");
	b = join(rot, "b");
	git(rot, "init", "-q", "--bare", "-b", "main", remote);
	git(rot, "clone", "-q", remote, a);
	git(a, "checkout", "-q", "-b", "main");
	skriv(a, "MEMORY.md", "# indeks\n");
	git(a, "add", "-A");
	git(a, "commit", "-q", "-m", "start");
	git(a, "push", "-q", "-u", "origin", "main");
	git(rot, "clone", "-q", remote, b);
});

afterEach(() => {
	rmSync(rot, { recursive: true, force: true });
});

describe("sync-start.sh stops on a conflict (#496)", () => {
	test("a clean pull is silent about conflicts and says it is updated", () => {
		skriv(a, "annet.md", "x\n");
		git(a, "add", "-A");
		git(a, "commit", "-q", "-m", "annet");
		git(a, "push", "-q");
		const r = kjør("sync-start.sh", b);
		expect(r.kode).toBe(0);
		expect(r.feil).not.toContain("✗");
		expect(r.ut).toContain("✓ Updated to");
	});

	test("an autostash that does not apply stops it with the file, although git exits 0", () => {
		sammeLinjer();
		const r = kjør("sync-start.sh", b);
		expect(r.kode).toBe(1);
		expect(r.ut).not.toContain("✓ Updated to");
		expect(r.feil).toContain("✗ Unresolved conflicts in:\n    MEMORY.md\n");
		expect(r.feil).toContain("(git stash list)");
	});

	test("a rebase that stops is named, with the file", () => {
		halvferdigRebase();
		const r = kjør("sync-start.sh", b);
		expect(r.kode).toBe(1);
		expect(r.feil).toContain("✗ A rebase is not finished");
		expect(r.feil).toContain("    MEMORY.md\n");
		// Stopped before pulling again.
		expect(r.ut).not.toContain("→ Pulling from Gitea");
	});
});

describe("sync-end.sh commits nothing mid-conflict (#496)", () => {
	test("mid-rebase: nothing is staged, committed or pushed", () => {
		halvferdigRebase();
		const før = remoteHead();
		const head = git(b, "rev-parse", "HEAD");
		const r = kjør("sync-end.sh", b);
		expect(r.kode).toBe(1);
		expect(r.feil).toContain("✗ A rebase is not finished");
		expect(r.feil).toContain("✗ Nothing was committed or pushed.");
		expect(git(b, "rev-parse", "HEAD")).toBe(head);
		// `git add -A` did not mark the conflict as resolved.
		expect(git(b, "ls-files", "-u")).not.toBe("");
		expect(remoteHead()).toBe(før);
	});

	test("after an autostash conflict the markers are not pushed", () => {
		sammeLinjer();
		kjør("sync-start.sh", b);
		const før = remoteHead();
		const r = kjør("sync-end.sh", b);
		expect(r.kode).toBe(1);
		expect(r.feil).toContain("✗ Unresolved conflicts in:");
		expect(remoteHead()).toBe(før);
		expect(remoteHarMarkører()).toBe(false);
	});

	test("a detached HEAD is refused", () => {
		git(b, "checkout", "-q", "--detach");
		skriv(b, "MEMORY.md", "# indeks\n- løs\n");
		const r = kjør("sync-end.sh", b);
		expect(r.kode).toBe(1);
		expect(r.feil).toContain("✗ HEAD is not on a branch");
		expect(git(b, "rev-list", "--count", "HEAD")).toBe("1");
	});

	test("markers in a file that is no longer unmerged are refused, and the file is unstaged", () => {
		skriv(b, "MEMORY.md", `# indeks\n${VENSTRE} Updated upstream\n- fra a\n=======\n- fra b\n${HØYRE} Stashed changes\n`);
		const r = kjør("sync-end.sh", b);
		expect(r.kode).toBe(1);
		expect(r.feil).toContain("✗ Not committing MEMORY.md: conflict markers. Resolve the conflict in the file.");
		expect(git(b, "diff", "--cached", "--name-only")).toBe("");
		expect(remoteHarMarkører()).toBe(false);
	});

	test("a Markdown heading underline and a marker inside a line are pushed", () => {
		skriv(b, "MEMORY.md", `Indeks\n=======\nI loggen: MEMORY.md:25:${VENSTRE} Updated upstream\n`);
		const r = kjør("sync-end.sh", b);
		expect(r.feil).not.toContain("✗");
		expect(r.kode).toBe(0);
		expect(git(remote, "show", "main:MEMORY.md")).toContain("=======");
	});
});
