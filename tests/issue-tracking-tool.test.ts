/**
 * Kontrakt-test: steg 8 skriver feilseksjonen med et verktøy (#246)
 *
 * `PAI-Install/cli/issue-tracking.ts` leser seksjonen og oppskriftene fra
 * `guide/issue-tracking.md` og skriver dem i `USER/INFRASTRUCTURE.md`. Testen
 * holder guiden og verktøyet i lag (finner verktøyet ikke fram i den ekte
 * guiden, er den rød), og sjekker at en ny kjøring bytter ut seksjonen i stedet
 * for å legge til en til, også når oppskriften har en kodeblokk.
 *
 * @module tests/issue-tracking-tool
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { filseksjon, medSeksjon, NY_ISSUES, OVERSKRIFT, serverseksjon, ugyldigRepo } from "../PAI-Install/cli/issue-tracking";

const REPO = join(import.meta.dir, "..");
const GUIDE = readFileSync(join(REPO, "guide/issue-tracking.md"), "utf-8");

const antall = (tekst: string) => tekst.split("\n").filter((l) => l.trimEnd() === OVERSKRIFT).length;

describe("seksjonene fra den ekte guiden", () => {
	test("fila: regelen «stopp og spør», og ISSUES.md", () => {
		const s = filseksjon(GUIDE);
		expect(s.startsWith(`${OVERSKRIFT}\n`)).toBe(true);
		expect(s).toContain("stop what you are doing");
		expect(s).toContain(".opencode/PAI/USER/ISSUES.md");
		expect(s).not.toContain("```");
	});

	for (const [server, sti] of [
		["gitea", "/api/v1/repos/min-org/pai/issues"],
		["gitlab", "/api/v4/projects/min-org%2Fpai/issues"],
		["github", "https://api.github.com/repos/min-org/pai/issues"],
	] as const) {
		test(`${server}: repoet og serveren fylt inn, og oppskriften under`, () => {
			const s = serverseksjon(GUIDE, server, "min-org/pai");
			expect(s.startsWith(`${OVERSKRIFT}\n`)).toBe(true);
			expect(s).toContain("issue list of `min-org/pai`");
			expect(s).toContain("stop what you are doing");
			expect(s).toContain(sti);
			expect(s).toMatch(/```bash\n[\s\S]+\n```\n$/);
			expect(s).not.toMatch(/<owner>|<repo>|<group>|<server>/);
		});
	}

	test("repoet må være <eier>/<repo>", () => {
		expect(ugyldigRepo("min-org/pai")).toBeNull();
		for (const r of ["pai", "a/b/c", "", "min org/pai", "x/$(rm)"]) expect(ugyldigRepo(r)).not.toBeNull();
	});
});

describe("medSeksjon", () => {
	const ny = `${OVERSKRIFT}\n\nNy regel.\n`;

	test("mangler seksjonen, legges den til bakerst", () => {
		const ut = medSeksjon("# Infra\n\n## Rules\n\n- en\n", ny);
		expect(ut).toBe(`# Infra\n\n## Rules\n\n- en\n\n${OVERSKRIFT}\n\nNy regel.\n`);
	});

	test("finnes den, byttes den ut, og seksjonen etter står", () => {
		const før = `# Infra\n\n${OVERSKRIFT}\n\nGammel regel.\n\n## Etter\n\n- står\n`;
		const ut = medSeksjon(før, ny);
		expect(ut).toBe(`# Infra\n\n${OVERSKRIFT}\n\nNy regel.\n\n## Etter\n\n- står\n`);
	});

	test("en ## i en kodeblokk avslutter ikke seksjonen", () => {
		const gammel = serverseksjon(GUIDE, "gitea", "a/b").replace("```bash\n", "```bash\n## ikke en overskrift\n");
		const før = `# Infra\n\n${gammel}\n## Etter\n`;
		const ut = medSeksjon(før, ny);
		expect(ut).toBe(`# Infra\n\n${OVERSKRIFT}\n\nNy regel.\n\n## Etter\n`);
	});
});

describe("issue-tracking.ts i et repo", () => {
	let rot: string;
	const infra = () => join(rot, ".opencode/PAI/USER/INFRASTRUCTURE.md");
	const issues = () => join(rot, ".opencode/PAI/USER/ISSUES.md");
	const kjør = (...a: string[]) => Bun.spawnSync(["bun", "PAI-Install/cli/issue-tracking.ts", ...a], { cwd: rot });

	beforeEach(() => {
		rot = mkdtempSync(join(tmpdir(), "pai-issue-tracking-"));
		for (const f of ["PAI-Install/cli/issue-tracking.ts", "guide/issue-tracking.md"]) {
			mkdirSync(dirname(join(rot, f)), { recursive: true });
			copyFileSync(join(REPO, f), join(rot, f));
		}
		mkdirSync(dirname(infra()), { recursive: true });
		copyFileSync(join(REPO, ".opencode/PAI/INFRASTRUCTURE.template.md"), infra());
	});

	afterEach(() => {
		rmSync(rot, { recursive: true, force: true });
	});

	test("--file lager ISSUES.md og seksjonen, og en ny kjøring endrer ingenting", () => {
		expect(kjør("--file").exitCode).toBe(0);
		expect(readFileSync(issues(), "utf-8")).toBe(NY_ISSUES);
		const etter = readFileSync(infra(), "utf-8");
		expect(antall(etter)).toBe(1);
		expect(kjør("--file").exitCode).toBe(0);
		expect(readFileSync(infra(), "utf-8")).toBe(etter);
	});

	test("--file rører ikke en ISSUES.md med oppføringer", () => {
		writeFileSync(issues(), "# Faults and improvements\n\n## 2026-10-04 · noe\n");
		expect(kjør("--file").exitCode).toBe(0);
		expect(readFileSync(issues(), "utf-8")).toContain("## 2026-10-04 · noe");
	});

	test("fra fil til Gitea: én seksjon, med serveren, og ISSUES.md står", () => {
		kjør("--file");
		const p = kjør("--gitea", "min-org/pai");
		expect(p.exitCode, p.stderr.toString()).toBe(0);
		const etter = readFileSync(infra(), "utf-8");
		expect(antall(etter)).toBe(1);
		expect(etter).toContain("/api/v1/repos/min-org/pai/issues");
		expect(etter).not.toContain("ISSUES.md");
		expect(existsSync(issues())).toBe(true);
		expect(kjør("--show").stdout.toString()).toContain("issues in min-org/pai on your Gitea");
	});

	test("et ugyldig repo eller ingen valg stopper uten å skrive", () => {
		const før = readFileSync(infra(), "utf-8");
		expect(kjør("--gitea", "pai").exitCode).toBe(1);
		expect(kjør().exitCode).toBe(1);
		expect(readFileSync(infra(), "utf-8")).toBe(før);
	});
});
