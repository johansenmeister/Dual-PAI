/**
 * Kontrakt-test: pai-pull og pai-push havner der login-skallet leser (#232)
 *
 * `guide/gitea/sync.sh` la synkaliasene i `~/.zshrc` for zsh og `~/.bashrc` for
 * alt annet, samme feil som #215 i installeren: et sh-login-skall leser aldri
 * `.bashrc`. Og `scripts/aliases.sh` var bash/zsh (`BASH_SOURCE[0]`,
 * funksjonsnavn med bindestrek), så dash stoppet med «Bad substitution» selv
 * om linja hadde stått riktig (MÅLT 2026-10-04).
 *
 * Profilsteget i `sync.sh` (fra `say "pai-pull…` til neste `say`) kjøres her
 * mot en temp-HOME med bare HOME, PATH og SHELL; resten av skriptet pusher til
 * en ssh-remote og kjøres ikke. Et ekte login-skall skal så finne `pai-pull`,
 * og aliaset skal peke på klonens `scripts/`. Uten `guide/` (jobben) hoppes den
 * delen over.
 *
 * @module tests/sync-skallprofil
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pai-sync-profil-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Profilsteget fra sync.sh, med skriptets hjelpere og REPO satt. */
function profilsteg(): string {
	const linjer = readFileSync(join(REPO, "guide/gitea/sync.sh"), "utf-8").split("\n");
	const fra = linjer.findIndex((l) => l.startsWith('say "pai-pull'));
	const til = linjer.findIndex((l, i) => i > fra && l.startsWith("say "));
	expect(fra).toBeGreaterThan(0);
	expect(til).toBeGreaterThan(fra);
	return [
		"set -euo pipefail",
		"say() { :; }; ok() { echo \"ok: $*\"; }; die() { echo \"die: $*\" >&2; exit 1; }",
		`REPO=${JSON.stringify(REPO)}`,
		...linjer.slice(fra, til),
	].join("\n");
}

function kjør(skall: string): { kode: number | null; ut: string } {
	const env = { HOME: home, PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, SHELL: skall };
	const p = Bun.spawnSync(["bash", "-c", profilsteg()], { env, stdin: "ignore" });
	return { kode: p.exitCode, ut: p.stdout.toString() + p.stderr.toString() };
}

// `guide/` følger ikke med jobben; aliases.sh gjør det.
describe.skipIf(!existsSync(join(REPO, "guide/gitea/sync.sh")))("sync.sh: synkaliasene i login-skallets profil (#232)", () => {
	test.skipIf(!Bun.which("dash"))("sh/dash: ~/.profile, og et login-skall har pai-pull mot klonen", () => {
		const r = kjør("/bin/sh");
		expect(r.kode, r.ut).toBe(0);
		expect(r.ut).toContain(`added to ${join(home, ".profile")}`);
		expect(r.ut).toContain("a new sh login shell has them");
		const p = Bun.spawnSync(["/bin/sh", "-lic", "alias pai-pull; echo $_PAI_SKRIPT"], { env: { HOME: home, PATH: "/usr/bin:/bin" }, stdin: "ignore" });
		expect(p.stdout.toString()).toContain(join(REPO, "scripts"));
	});

	test("bash: ~/.bashrc, og en ny kjøring legger ikke linja inn to ganger", () => {
		writeFileSync(join(home, ".profile"), '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n');
		expect(kjør("/bin/bash").ut).toContain("a new bash login shell has them");
		expect(kjør("/bin/bash").ut).toContain("already in");
		expect(readFileSync(join(home, ".bashrc"), "utf-8").match(/aliases\.sh/g)).toHaveLength(1);
	});

	test("en gammel source-linje fra før #232 regnes som på plass", () => {
		writeFileSync(join(home, ".bashrc"), `source "${REPO}/scripts/aliases.sh"\n`);
		expect(kjør("/bin/bash").ut).toContain("already in");
	});
});

describe("aliases.sh (#232)", () => {
	test.skipIf(!Bun.which("dash"))("dash henter fila uten feil når _PAI_SKRIPT er satt", () => {
		const p = Bun.spawnSync(["dash", "-c", `_PAI_SKRIPT=/x; . ${JSON.stringify(join(REPO, "scripts/aliases.sh"))}; alias pai-push`]);
		expect(p.exitCode, p.stderr.toString()).toBe(0);
		expect(p.stdout.toString()).toContain('/sync-end.sh"');
	});

	test("bash finner katalogen selv", () => {
		const p = Bun.spawnSync(["bash", "-c", `. ${JSON.stringify(join(REPO, "scripts/aliases.sh"))}; echo "$_PAI_SKRIPT"`]);
		expect(p.stdout.toString().trim()).toBe(join(REPO, "scripts"));
	});
});
