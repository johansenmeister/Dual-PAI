/**
 * Kontrakt-test: maskin nummer to rører ikke de sporede filene (#221)
 *
 * Med eget Gitea og synk er maskin to en klone av brukerens repo. Før #221
 * kjørte `install.sh` installeren der som på en ny maskin, fordi
 * `settings.json` er maskinlokal og mangler i klonen: den skrev gjennom lenken
 * til den sporede `opencode.json` og tilbakestilte modellene, og neste
 * `pai-push` spredte det. Nå kjenner `install.sh` igjen et oppsatt repo
 * (`DAIDENTITY.md` ulik malen) og lager bare `settings.json` med
 * `identity.ts --from-repo`, lenken og skallblokken.
 *
 * Her: `identity.ts --from-repo` i et minimalt repo med en oppsatt identitet.
 * `git status` skal være tom etterpå, og navnene skal stå i `settings.json`.
 * Og `--first-run`, den første maskinen før intervjuet (#162 fase 4): malens
 * navn og «User», også uten `DAIDENTITY.md`, og heller ingen sporet fil endret.
 * Hele `install.sh` laster ned motoren og kjøres ikke her (se install-sh.test.ts).
 *
 * @module tests/maskin-to
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FORELØPIG_PRINSIPAL, navnILinja, prinsipalILinja } from "../PAI-Install/cli/identity";

const REPO = join(import.meta.dir, "..");
let rot: string;

function git(...a: string[]): string {
	const p = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: rot });
	return p.stdout.toString().trim();
}

function kopier(sti: string): void {
	mkdirSync(dirname(join(rot, sti)), { recursive: true });
	copyFileSync(join(REPO, sti), join(rot, sti));
}

beforeEach(() => {
	rot = mkdtempSync(join(tmpdir(), "pai-maskin-to-"));
	for (const f of ["PAI-Install/cli/identity.ts", ".opencode/PAI/DAIDENTITY.template.md"]) kopier(f);
	// Brukerens repo etter intervjuet: navnene i identiteten, og en opencode.json med modellene.
	const mal = readFileSync(join(REPO, ".opencode/PAI/DAIDENTITY.template.md"), "utf-8");
	const egen = mal
		.replace(/^(\s*(?:[-*]\s+)?\*\*Name:\*\*\s*).*$/m, "$1Testa")
		.replace(/^(\s*(?:[-*]\s+)?\*\*Principal:\*\*\s*).*$/m, "$1Kari Nordmann");
	mkdirSync(join(rot, ".opencode/PAI/USER"), { recursive: true });
	writeFileSync(join(rot, ".opencode/PAI/USER/DAIDENTITY.md"), egen);
	writeFileSync(join(rot, "opencode.json"), '{\n  "model": "fireworks-ai/egen-modell",\n  "username": "Kari Nordmann"\n}\n');
	symlinkSync("../opencode.json", join(rot, ".opencode/opencode.json"));
	writeFileSync(join(rot, ".gitignore"), ".opencode/settings.json\n");
	git("init", "-q");
	git("add", "-A");
	git("commit", "-qm", "brukerens repo");
});

afterEach(() => {
	rmSync(rot, { recursive: true, force: true });
});

describe("identity.ts --from-repo (#221)", () => {
	test("skriver settings.json med navnene fra DAIDENTITY.md, og ingen sporet fil endres", () => {
		const p = Bun.spawnSync(["bun", "PAI-Install/cli/identity.ts", "--from-repo", "--timezone", "Europe/Oslo"], { cwd: rot });
		expect(p.exitCode, p.stderr.toString()).toBe(0);
		expect(git("status", "--porcelain")).toBe("");
		const s = JSON.parse(readFileSync(join(rot, ".opencode/settings.json"), "utf-8"));
		expect(s.daidentity.name).toBe("Testa");
		expect(s.principal).toEqual({ name: "Kari Nordmann", timezone: "Europe/Oslo" });
		expect(s.pai.version).toBeTruthy();
	});

	test("uten tidssone brukes maskinens", () => {
		const p = Bun.spawnSync(["bun", "PAI-Install/cli/identity.ts", "--from-repo"], { cwd: rot, env: { ...process.env, TZ: "America/New_York" } });
		expect(p.exitCode, p.stderr.toString()).toBe(0);
		expect(JSON.parse(readFileSync(join(rot, ".opencode/settings.json"), "utf-8")).principal.timezone).toBe("America/New_York");
	});

	test("malens «the user» er ikke et navn; da gjelder username i opencode.json", () => {
		expect(prinsipalILinja("- **Principal:** the user\n")).toBe("");
		expect(prinsipalILinja("- **Principal:** Kari\n")).toBe("Kari");
	});
});

describe("identity.ts --first-run (#162 fase 4)", () => {
	const malensNavn = navnILinja(readFileSync(join(REPO, ".opencode/PAI/DAIDENTITY.template.md"), "utf-8"));

	/** Repoet slik det er klonet fra public: identiteten er malen, og `username` er tatt ut. */
	function somKlonet(medIdentitet: boolean): void {
		const mal = readFileSync(join(rot, ".opencode/PAI/DAIDENTITY.template.md"), "utf-8");
		if (medIdentitet) writeFileSync(join(rot, ".opencode/PAI/USER/DAIDENTITY.md"), mal);
		else rmSync(join(rot, ".opencode/PAI/USER/DAIDENTITY.md"));
		writeFileSync(join(rot, "opencode.json"), '{\n  "model": "opencode/en-modell"\n}\n');
		git("add", "-A");
		git("commit", "-qm", "klonet fra public");
	}

	test("skriver settings.json med malens navn og en foreløpig prinsipal, og ingen sporet fil endres", () => {
		somKlonet(true);
		const p = Bun.spawnSync(["bun", "PAI-Install/cli/identity.ts", "--first-run", "--timezone", "Europe/Oslo"], { cwd: rot });
		expect(p.exitCode, p.stderr.toString()).toBe(0);
		expect(git("status", "--porcelain")).toBe("");
		const s = JSON.parse(readFileSync(join(rot, ".opencode/settings.json"), "utf-8"));
		expect(s.daidentity.name).toBe(malensNavn);
		expect(s.principal).toEqual({ name: FORELØPIG_PRINSIPAL, timezone: "Europe/Oslo" });
		expect(s.pai.version).toBeTruthy();
	});

	test("uten DAIDENTITY.md leses malen", () => {
		somKlonet(false);
		const p = Bun.spawnSync(["bun", "PAI-Install/cli/identity.ts", "--first-run"], { cwd: rot });
		expect(p.exitCode, p.stderr.toString()).toBe(0);
		expect(JSON.parse(readFileSync(join(rot, ".opencode/settings.json"), "utf-8")).daidentity.name).toBe(malensNavn);
	});

	test("--from-repo faller ikke tilbake på malen eller «User»", () => {
		somKlonet(true);
		const uten = Bun.spawnSync(["bun", "PAI-Install/cli/identity.ts", "--from-repo"], { cwd: rot });
		expect(uten.exitCode).toBe(1);
		expect(uten.stderr.toString()).toContain("the name is empty");
		somKlonet(false);
		const p = Bun.spawnSync(["bun", "PAI-Install/cli/identity.ts", "--from-repo"], { cwd: rot });
		expect(p.exitCode).toBe(1);
		expect(p.stderr.toString()).toContain("DAIDENTITY.md is missing");
	});
});
