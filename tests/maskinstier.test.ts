/**
 * Kontrakt-test: ingen maskinstier i koden (K52)
 *
 * Synkskriptene hadde `~/repos/pai-opencode` fast, så `pai-push` virket ikke
 * på testmaskinen, der klonen heter `~/repos/pai` (K48). Tre verktøy under
 * `PAI/Tools/` falt tilbake til eierens hjemmekatalog når `HOME` manglet. Samme klasse
 * som M-29: en verdi som bare stemmer på én maskin, som ingen test ser, og som
 * saneringen for `pai-harness-public` måtte fange for hånd.
 *
 * Ser på alt git sporer, unntatt markdown (runbookene beskriver maskinene med
 * vilje), `docs/`, `tests/` og MEMORY. Fail-open uten git, som K15 og K42.
 *
 * The skills' markdown is what the model runs, though, so the shell blocks in
 * markdown under `.opencode/skills/` are checked too: no `/home/<user>` there, only `~` or
 * `$HOME` (#399; a job skill sourced one user's `.env` by its full path).
 *
 * @module tests/maskinstier
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

/** `/home/<bruker>` og klonenavnet på `pai` og `pc-en`. */
const MØNSTER = "/home/[a-z][a-z0-9_.-]*|repos/pai-opencode";

/** `fil` → treffet som er lov der, med grunnen. */
const UNNTAK: Record<string, { treff: string; grunn: string }> = {
	"Tools/lib/gyldne-payloads.ts": {
		treff: "/home/bruker",
		grunn: "plassholderen hjemmestien i fixturene skrives om til",
	},
};

/** `fil:linje: treff` for hvert treff git finner, eller null utenfor et git-tre. */
function treff(mønster: string): string[] | null {
	const r = Bun.spawnSync(
		["git", "grep", "-n", "-I", "-o", "-E", mønster, "--", ".", ":!*.md", ":!docs/", ":!tests/", ":!**/MEMORY/**"],
		{ cwd: REPO, stdout: "pipe", stderr: "pipe" }
	);
	// 1 er «ingen treff»; alt over er at git ikke kunne svare.
	if (r.exitCode === 1) return [];
	if (r.exitCode !== 0) return null;
	return r.stdout.toString().split("\n").filter(Boolean);
}

describe("ingen maskinstier i koden (K52)", () => {
	test("hvert treff er et oppført unntak", () => {
		const funn = treff(MØNSTER);
		if (funn === null) return;
		const ulovlige = funn.filter((l) => {
			const [fil, , verdi] = l.split(":");
			return UNNTAK[fil]?.treff !== verdi;
		});
		expect(ulovlige).toEqual([]);
	});

	test("hvert unntak treffer fortsatt, så lista ikke råtner", () => {
		const funn = treff(MØNSTER);
		if (funn === null) return;
		for (const [fil, { treff: verdi }] of Object.entries(UNNTAK)) {
			expect(
				funn.some((l) => l.startsWith(`${fil}:`) && l.endsWith(`:${verdi}`)),
				fil
			).toBe(true);
		}
	});
});

/** A home directory inside a container, not on a machine: the user of the official node images. */
const CONTAINER_HJEM = new Set(["/home/node"]);

const SKALL = /^(bash|sh|shell|zsh|console)$/;

/** The shell blocks read, and `fil:linje: treff` for each `/home/<user>` in them. */
function skallblokkTreff(): { blokker: number; funn: string[] } | null {
	const r = Bun.spawnSync(["git", "ls-files", "-z", "--", ".opencode/skills/*.md"], {
		cwd: REPO,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) return null;
	const funn: string[] = [];
	let blokker = 0;
	for (const fil of r.stdout.toString().split("\0").filter(Boolean)) {
		let iBlokk = false;
		let skall = false;
		readFileSync(join(REPO, fil), "utf-8")
			.split("\n")
			.forEach((linje, i) => {
				const gjerde = linje.match(/^\s*```\s*(\S*)/);
				if (gjerde) {
					skall = !iBlokk && SKALL.test(gjerde[1] ?? "");
					if (skall) blokker++;
					iBlokk = !iBlokk;
					return;
				}
				if (!iBlokk || !skall) return;
				for (const m of linje.matchAll(/\/home\/[a-z][a-z0-9_.-]*/g))
					if (!CONTAINER_HJEM.has(m[0])) funn.push(`${fil}:${i + 1}: ${m[0]}`);
			});
	}
	return { blokker, funn };
}

describe("ingen maskinstier i skallblokkene i skillene (#399)", () => {
	test("a shell block in a skill uses ~ or $HOME, not /home/<user>", () => {
		const svar = skallblokkTreff();
		if (svar === null) return;
		expect(svar.funn).toEqual([]);
	});

	test("the check reads shell blocks, so an empty file list is not a pass", () => {
		const svar = skallblokkTreff();
		if (svar === null) return;
		expect(svar.blokker).toBeGreaterThan(50);
	});
});
