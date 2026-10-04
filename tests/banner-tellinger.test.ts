/**
 * Kontrakt-test: banneret viser tellingene `update-counts.ts` skriver
 *
 * Banneret leste `counts.hooks` fra porteringen og ut, mens handleren skrev
 * `counts.plugins`: «Hooks 0» ved hver oppstart, uten at noe sa fra. Og
 * handleren telte `SKILL.md` ett nivå ned i et hierarkisk tre, så banneret viste
 * kategoriene (9), ikke skillene (57). Begge er stumme feil i et grensesnitt som
 * går gjennom `settings.json`, der ingen typer følger med.
 *
 * Testen lar handleren skrive tellingene i et temp-`PAI_HOME`, kjører det ekte
 * banneret mot det samme treet og leser tallene i utskriften. I tillegg: hvert
 * `settings.counts.<felt>` banneret leser, finnes blant feltene handleren skriver.
 *
 * @module tests/banner-tellinger
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleUpdateCounts } from "../.opencode/pai-core/handlers/update-counts";

const REPO = join(import.meta.dir, "..");
const BANNER = join(REPO, ".opencode", "PAI", "Tools", "Banner.ts");

let hjem: string;
let forrige: string | undefined;

beforeAll(async () => {
	hjem = mkdtempSync(join(tmpdir(), "pai-banner-"));
	// Tre skills: én på toppen og to under en kategori, som i det ekte treet.
	for (const sti of ["Alene", "Kategori/En", "Kategori/To"]) {
		mkdirSync(join(hjem, "skills", sti), { recursive: true });
		writeFileSync(join(hjem, "skills", sti, "SKILL.md"), "# skill\n");
	}
	mkdirSync(join(hjem, "skills", "Kategori", "To", "Workflows"), { recursive: true });
	writeFileSync(join(hjem, "skills", "Kategori", "To", "Workflows", "Gjør.md"), "# wf\n");
	writeFileSync(join(hjem, "settings.json"), JSON.stringify({ daidentity: { name: "Testa" } }));

	forrige = process.env.PAI_HOME;
	process.env.PAI_HOME = hjem;
	await handleUpdateCounts();
	process.env.PAI_HOME = forrige;
});

afterAll(() => {
	process.env.PAI_HOME = forrige;
	rmSync(hjem, { recursive: true, force: true });
});

/** Banneret i Navy-utgaven, uten fargekoder. */
function banner(motor: "opencode" | "claude"): string {
	const r = Bun.spawnSync([process.execPath, BANNER, "--design=navy", `--engine=${motor}`], {
		env: { ...process.env, OPENCODE_DIR: hjem, COLUMNS: "100" },
	});
	// biome-ignore lint/suspicious/noControlCharactersInRegex: \x1b er starten på hver ANSI-fargekode
	return r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, "");
}

describe("banneret og update-counts (Hooks 0, SK 9)", () => {
	test("handleren teller skills i hele treet", () => {
		const counts = JSON.parse(readFileSync(join(hjem, "settings.json"), "utf-8")).counts;
		expect(counts.skills).toBe(3);
		expect(counts.workflows).toBe(1);
	});

	test("banneret viser tellingene handleren skrev", () => {
		const ut = banner("opencode");
		expect(ut).toMatch(/Skills\s+3\b/);
		expect(ut).toMatch(/WF\s+1\b/);
		expect(ut).toContain("Dual PAI · Testa");
	});

	test("hvert counts-felt banneret leser, skriver handleren", () => {
		const skrevet = Object.keys(JSON.parse(readFileSync(join(hjem, "settings.json"), "utf-8")).counts);
		const lest = [...readFileSync(BANNER, "utf-8").matchAll(/settings\.counts\.(\w+)/g)].map((m) => m[1]);
		expect(lest.length).toBeGreaterThan(0);
		expect(lest.filter((f) => !skrevet.includes(f))).toEqual([]);
	});

	test("motoren som starter, med den pinnede versjonen", () => {
		const pin = JSON.parse(readFileSync(join(REPO, ".opencode", "package.json"), "utf-8")).pai.claudeCode;
		expect(banner("claude")).toMatch(new RegExp(`Engine\\s+Claude Code ${pin.replace(/\./g, "\\.")}`));
		expect(banner("opencode")).toMatch(/Engine\s+OpenCode \d/);
	});
});
