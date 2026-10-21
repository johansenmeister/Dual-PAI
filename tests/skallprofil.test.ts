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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paiCommandWarnings } from "../.opencode/PAI/Tools/maskin-helse";
import { paiCommandPath, paiCommandState, writePaiCommand } from "../.opencode/PAI/Tools/pai-command";
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

/**
 * #476: the function exists only where the profile is read. `~/.local/bin/pai`
 * is for the rest: a non-interactive `sh -c`, as the agents' shell tools run it.
 */
describe("pai on PATH for shells that do not read the profile (#476)", () => {
	/** A repo whose launcher prints where it runs and what it got. */
	function fakeRepo(name: string): string {
		const repo = join(home, name);
		mkdirSync(join(repo, ".opencode", "PAI", "Tools"), { recursive: true });
		writeFileSync(
			join(repo, ".opencode", "PAI", "Tools", "pai.ts"),
			"console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n"
		);
		return repo;
	}

	function run(command: string): { code: number; out: string } {
		const p = Bun.spawnSync(["/bin/sh", "-c", command], {
			stdin: "ignore",
			cwd: home,
			env: { HOME: home, PATH: `${join(home, ".local", "bin")}:${dirname(process.execPath)}:/usr/bin:/bin` },
		});
		return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() };
	}

	test("sh -c finds pai, and the launcher runs in the repo with the arguments intact", () => {
		const repo = fakeRepo("it's a repo");
		expect(writePaiCommand(home, repo)).toBe("missing");
		const r = run(`pai version "two words" '$HOME'`);
		expect(r.code, r.out).toBe(0);
		expect(JSON.parse(r.out)).toEqual({ cwd: repo, args: ["version", "two words", "$HOME"] });
		expect(statSync(paiCommandPath(home)).mode & 0o777).toBe(0o755);
	});

	test("with bun only in ~/.bun/bin, as the bun installer leaves it, the arguments still arrive", () => {
		const repo = fakeRepo("r");
		writePaiCommand(home, repo);
		mkdirSync(join(home, ".bun", "bin"), { recursive: true });
		symlinkSync(process.execPath, join(home, ".bun", "bin", "bun"));
		const p = Bun.spawnSync(["/bin/sh", "-c", `pai a "b c"`], {
			stdin: "ignore",
			env: { HOME: home, PATH: `${join(home, ".local", "bin")}:/usr/bin:/bin` },
		});
		expect(JSON.parse(p.stdout.toString())).toEqual({ cwd: repo, args: ["a", "b c"] });
	});

	test("a new run leaves it for the same repo and rewrites it for another", () => {
		const a = fakeRepo("a");
		const b = fakeRepo("b");
		writePaiCommand(home, a);
		expect(writePaiCommand(home, a)).toBe("ok");
		expect(paiCommandState(home, b)).toBe("other");
		expect(writePaiCommand(home, b)).toBe("other");
		expect(JSON.parse(run("pai").out).cwd).toBe(b);
	});

	test("a pai that PAI did not write is left alone", () => {
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		writeFileSync(paiCommandPath(home), "#!/bin/sh\necho other\n");
		expect(writePaiCommand(home, fakeRepo("a"))).toBe("foreign");
		expect(readFileSync(paiCommandPath(home), "utf-8")).toBe("#!/bin/sh\necho other\n");
	});

	test("pai doctor warns when it is missing, runs another repo or is not PAI's, and is silent otherwise", () => {
		const repo = fakeRepo("r");
		const tree = join(repo, ".opencode");
		expect(paiCommandWarnings(tree, home)[0]).toContain(`is missing, so shells that do not read your shell profile`);
		expect(paiCommandWarnings(tree, home)[0]).toContain(`bun ${repo}/PAI-Install/cli/shell-setup.ts`);
		writePaiCommand(home, fakeRepo("other"));
		expect(paiCommandWarnings(tree, home)[0]).toContain("runs another PAI or is outdated");
		writePaiCommand(home, repo);
		expect(paiCommandWarnings(tree, home)).toEqual([]);
		writeFileSync(paiCommandPath(home), "#!/bin/sh\n");
		expect(paiCommandWarnings(tree, home)[0]).toContain("is not PAI's");
	});
});

describe("shell-setup.ts as the installer runs it (#476)", () => {
	const SCRIPT = join(import.meta.dir, "..", "PAI-Install", "cli", "shell-setup.ts");
	const REPO = realpathSync(join(import.meta.dir, ".."));

	function setup(): { code: number; err: string } {
		const p = Bun.spawnSync(["bun", SCRIPT], {
			stdin: "ignore",
			env: { HOME: home, SHELL: "/bin/sh", PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
		});
		return { code: p.exitCode ?? -1, err: p.stderr.toString() };
	}

	test("writes the profile block and ~/.local/bin/pai for this repo", () => {
		const r = setup();
		expect(r.code, r.err).toBe(0);
		expect(readFileSync(join(home, ".profile"), "utf-8")).toContain("# PAI shell setup —");
		expect(paiCommandState(home, REPO)).toBe("ok");
	});

	test("says so when ~/.local/bin/pai is not PAI's, and still writes the profile", () => {
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		writeFileSync(paiCommandPath(home), "#!/bin/sh\n");
		const r = setup();
		expect(r.code).toBe(0);
		expect(r.err).toContain("is not PAI's and was left alone");
		expect(readFileSync(join(home, ".profile"), "utf-8")).toContain("# PAI shell setup —");
	});
});

test("a hand-written block with the short marker is replaced whole, not in part (#476)", () => {
	const rc = join(home, ".bashrc");
	const old = [
		"# user's line",
		"# PAI shell setup",
		'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"',
		"",
		"pai() {",
		'  (cd "$HOME/repos/pai" && bun run .opencode/PAI/Tools/pai.ts "$@")',
		"}",
		"# end PAI shell setup",
		"",
		"# PAI sync-alias",
		"source $HOME/repos/pai/scripts/aliases.sh",
		"",
	].join("\n");
	writeFileSync(rc, old);
	writePaiFunction(rc, "bash", "/opt/pai");
	const text = readFileSync(rc, "utf-8");
	expect(text.match(/# end PAI shell setup/g)).toHaveLength(1);
	expect(text.match(/# PAI shell setup/g)).toHaveLength(1);
	expect(text.match(/^export PATH=/gm)).toHaveLength(1);
	expect(text).toContain("# user's line");
	expect(text).toContain("source $HOME/repos/pai/scripts/aliases.sh");
	expect(text).toContain('cd "/opt/pai"');
});
