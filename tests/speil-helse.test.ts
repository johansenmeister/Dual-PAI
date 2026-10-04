/**
 * K57 i `pai doctor`: de skrivebeskyttede speilene er rene
 *
 * Begge retninger (regel 1): et rent speil og en sti som ikke finnes er
 * tause; en lokal endring, en ny fil og en stash-oppføring slår ut, hver med
 * kommandoen som retter det.
 *
 * @module tests/speil-helse
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reposUnder, speilHelse } from "../.opencode/PAI/Tools/speil-helse";
import { SKRIVEBESKYTTET_FIL } from "../.opencode/pai-core/lib/skrivebeskyttet";

let rot: string;
let paiDir: string;
let speil: string;
let repo: string;

function git(...args: string[]): void {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function konfig(stier: string[]): void {
	const fil = join(paiDir, SKRIVEBESKYTTET_FIL);
	mkdirSync(join(fil, ".."), { recursive: true });
	writeFileSync(fil, JSON.stringify({ stier }));
}

beforeEach(() => {
	rot = mkdtempSync(join(tmpdir(), "pai-speil-helse-"));
	paiDir = join(rot, "pai");
	speil = join(rot, "example-work-docs");
	repo = join(speil, "infra-docs");
	mkdirSync(repo, { recursive: true });
	git("init", "-q");
	writeFileSync(join(repo, "side.md"), "fra BookStack\n");
	git("add", ".");
	git("commit", "-q", "-m", "synk");
});

afterEach(() => {
	rmSync(rot, { recursive: true, force: true });
});

describe("speilHelse (K57)", () => {
	test("taus uten konfig, for et rent speil og for en sti som ikke finnes her", () => {
		expect(speilHelse(paiDir)).toEqual({ problemer: [], varsler: [], stier: 0, repoer: 0 });
		konfig([speil, join(rot, "finnes-ikke")]);
		expect(speilHelse(paiDir)).toEqual({ problemer: [], varsler: [], stier: 2, repoer: 1 });
	});

	test("en endret og en ny fil gir én linje med kommandoen som forkaster dem", () => {
		konfig([speil]);
		writeFileSync(join(repo, "side.md"), "redigert lokalt\n");
		writeFileSync(join(repo, "ny.md"), "ny\n");
		const { problemer } = speilHelse(paiDir);
		expect(problemer).toEqual([
			`${repo}: 2 local change(s) in a read-only mirror. Make the change in the source, and discard it here: git -C ${repo} reset --hard && git -C ${repo} clean -fd`,
		]);
	});

	test("en stash-oppføring slår ut, også når arbeidstreet er rent", () => {
		konfig([speil]);
		writeFileSync(join(repo, "side.md"), "redigert lokalt\n");
		git("stash", "-q");
		const { problemer } = speilHelse(paiDir);
		expect(problemer).toHaveLength(1);
		expect(problemer[0]).toContain("1 stash entry(ies)");
		expect(problemer[0]).toContain(`git -C ${repo} stash clear`);
	});

	test("en sti som er et repo selv, sjekkes direkte; en uten repo gir et varsel", () => {
		expect(reposUnder(repo)).toEqual([repo]);
		expect(reposUnder(speil)).toEqual([repo]);
		const tom = join(rot, "tom");
		mkdirSync(tom);
		konfig([tom]);
		expect(speilHelse(paiDir).varsler).toEqual([`${tom} is read-only, but has no git repo to check`]);
	});
});
