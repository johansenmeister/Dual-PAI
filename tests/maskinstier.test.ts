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
 * @module tests/maskinstier
 */

import { describe, expect, test } from "bun:test";
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
