/**
 * Kontrakt-test: installeren skriver pai-funksjonen der login-skallet leser (#215)
 *
 * Før #215 fikk alt som ikke var bash, zsh eller fish, funksjonen i `~/.zshrc`.
 * MÅLT i prøven av `install.sh` (#162 fase 3): med `env -i` (ingen `SHELL`)
 * havnet blokken der, og `type pai` i et innloggingsskall ga «not found», mens
 * `install.sh` sa «✓ … the pai command». En konto laget med `useradd` uten `-s`
 * har `/bin/sh` på Debian og fikk det samme.
 *
 * Ende til ende her: blokken skrives til en temp-HOME med fila `shellProfile`
 * velger, og et ekte login-skall med den HOME-en skal finne `pai`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellProfile, writePaiFunction } from "../PAI-Install/cli/shell-setup";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pai-skallprofil-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("shellProfile", () => {
	test("zsh, bash og fish får sin egen fil", () => {
		expect(shellProfile("/bin/zsh", "/h").file).toBe("/h/.zshrc");
		expect(shellProfile("/usr/bin/bash", "/h").file).toBe("/h/.bashrc");
		expect(shellProfile("/usr/bin/fish", "/h").file).toBe("/h/.config/fish/config.fish");
	});

	test("sh, dash, et ukjent skall og intet skall får ~/.profile, ikke ~/.zshrc", () => {
		for (const s of ["/bin/sh", "/bin/dash", "/bin/ksh", "", undefined]) {
			expect(shellProfile(s, "/h").file).toBe("/h/.profile");
		}
	});
});

/** Finner et login-skall med denne HOME-en `pai`? Bare PATH og HOME, som `env -i`. */
function finnerPai(skall: string): boolean {
	const p = Bun.spawnSync([skall, "-lic", "type pai"], {
		stdin: "ignore",
		env: { HOME: home, PATH: "/usr/bin:/bin" },
	});
	return p.exitCode === 0 && p.stdout.toString().includes("function");
}

describe("pai-funksjonen lastes av login-skallet", () => {
	for (const skall of ["/bin/sh", "/bin/bash"]) {
		test.skipIf(!Bun.which(skall))(`${skall}`, () => {
			// Debian-standarden: ~/.profile henter ~/.bashrc når skallet er bash.
			writeFileSync(join(home, ".profile"), '[ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n');
			const { file, shell } = shellProfile(skall, home);
			writePaiFunction(file, shell, "/opt/pai");
			expect(finnerPai(skall)).toBe(true);
		});
	}

	test.skipIf(!Bun.which("sh"))("med ~/.zshrc, som før #215, finner sh den ikke", () => {
		writePaiFunction(join(home, ".zshrc"), "sh", "/opt/pai");
		expect(finnerPai("/bin/sh")).toBe(false);
	});

	test("en ny kjøring erstatter blokken i ~/.profile og lar resten stå", () => {
		writeFileSync(join(home, ".profile"), "# brukerens egen linje\numask 022\n");
		writePaiFunction(join(home, ".profile"), "sh", "/opt/a");
		writePaiFunction(join(home, ".profile"), "sh", "/opt/b");
		const innhold = readFileSync(join(home, ".profile"), "utf-8");
		expect(innhold).toContain("umask 022");
		expect(innhold.match(/# PAI shell setup —/g)).toHaveLength(1);
		expect(innhold).toContain('cd "/opt/b"');
	});
});
