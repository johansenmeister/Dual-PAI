/**
 * Kontrakt-test: `install.sh` i roten (#162)
 *
 * Selve installasjonen er prøvd ende til ende i en fersk HOME (fase 2), og den
 * laster ned ~800 MB, så den kjøres ikke her. Det som testes, er det som ville
 * feilet før noe skjer: syntaksen og flaggene. Variabelnavn utenfor ASCII
 * vokter `skall-ascii.test.ts` for alle skallskriptene (#199).
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKRIPT = join(import.meta.dir, "..", "install.sh");

function kjør(args: string[]) {
	const p = Bun.spawnSync(["bash", SKRIPT, ...args], { stdin: "ignore", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" } });
	return { kode: p.exitCode, ut: p.stdout.toString(), feil: p.stderr.toString() };
}

describe("install.sh", () => {
	test("syntaksen er gyldig", () => {
		expect(Bun.spawnSync(["bash", "-n", SKRIPT]).exitCode).toBe(0);
	});

	test("--help viser bruken og avslutter uten å installere noe", () => {
		const r = kjør(["--help"]);
		expect(r.kode).toBe(0);
		expect(r.ut).toContain("./install.sh --no-start");
		expect(r.ut).not.toContain("==>");
	});

	test("et ukjent flagg stopper før første steg", () => {
		const r = kjør(["--fresh"]);
		expect(r.kode).toBe(1);
		expect(r.feil).toContain("Unknown option: --fresh");
		expect(r.ut).not.toContain("==>");
	});


	// macOS uten Command Line Tools: /usr/bin/git finnes, men gir exit 1
	// (MÅLT 2026-10-04, Sequoia 15.8.1). `command -v` slapp den gjennom.
	test("en git som finnes, men ikke kjører, stopper skriptet før noe installeres", () => {
		const bin = mkdtempSync(join(tmpdir(), "pai-install-sh-"));
		try {
			for (const v of ["id", "uname", "grep", "dirname", "curl", "unzip", "jq"]) {
				const sti = Bun.which(v);
				if (sti) symlinkSync(sti, join(bin, v));
			}
			writeFileSync(join(bin, "git"), "#!/bin/sh\necho 'xcode-select: error: No developer tools were found' >&2\nexit 1\n");
			chmodSync(join(bin, "git"), 0o755);
			const p = Bun.spawnSync([Bun.which("bash") ?? "/bin/bash", SKRIPT, "--no-start"], {
				stdin: "ignore",
				env: { PATH: bin, HOME: "/nonexistent" },
			});
			expect(p.exitCode).toBe(1);
			expect(p.stderr.toString()).toContain("Please install git");
			expect(p.stdout.toString()).not.toContain("Installing");
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	});
	// Pakkesystemet velges etter hvilket program som finnes, ikke etter distro-navnet.
	// Stubbene logger argumentene og feiler, så skriptet stopper før noe lastes ned.
	function medPakkesystem(systemer: string[]) {
		const bin = mkdtempSync(join(tmpdir(), "pai-install-pm-"));
		const logg = join(bin, "logg");
		for (const v of ["id", "uname", "grep", "dirname", "curl", "unzip", "jq"]) {
			const sti = Bun.which(v);
			if (sti) symlinkSync(sti, join(bin, v));
		}
		writeFileSync(join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n');
		for (const s of systemer) writeFileSync(join(bin, s), `#!/bin/sh\necho "${s} $*" >> "${logg}"\nexit 1\n`);
		for (const f of ["sudo", ...systemer]) chmodSync(join(bin, f), 0o755);
		const p = Bun.spawnSync([Bun.which("bash") ?? "/bin/bash", SKRIPT, "--no-start"], {
			stdin: "ignore",
			env: { PATH: bin, HOME: "/nonexistent" },
		});
		const r = { kode: p.exitCode, feil: p.stderr.toString(), logg: existsSync(logg) ? readFileSync(logg, "utf8") : "" };
		rmSync(bin, { recursive: true, force: true });
		return r;
	}

	test.each([
		["apt-get", "apt-get update -qq"],
		["dnf", "dnf install -y -q git ca-certificates"],
		["yum", "yum install -y -q git ca-certificates"],
		["zypper", "zypper --non-interactive --quiet install git ca-certificates"],
		["pacman", "pacman -S --needed --noconfirm git ca-certificates"],
	])("en manglende git installeres med %s", (system, forventet) => {
		const r = medPakkesystem([system]);
		expect(r.kode).toBe(1);
		expect(r.logg.trim()).toBe(forventet);
		expect(r.feil).toContain(`${system} could not install git`);
	});

	test("apt-get velges når flere pakkesystemer finnes", () => {
		const r = medPakkesystem(["pacman", "dnf", "apt-get"]);
		expect(r.logg.trim()).toBe("apt-get update -qq");
	});

	// Uten en klone (curl | bash, eller fila alene) kloner skriptet PAI og fortsetter
	// med klonens egen install.sh, med flaggene som ikke var dens egne fjernet.
	describe("uten klone", () => {
		function oppsett() {
			const rot = mkdtempSync(join(tmpdir(), "pai-install-klon-"));
			const kilde = join(rot, "kilde");
			mkdirSync(join(kilde, ".opencode"), { recursive: true });
			writeFileSync(join(kilde, "SETUP.md"), "# setup\n");
			writeFileSync(join(kilde, ".opencode", "package.json"), "{}\n");
			writeFileSync(join(kilde, "install.sh"), 'echo "KLONENS install.sh i $(pwd) med: $*"\n');
			const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: kilde, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
			git("init", "-q");
			git("add", ".");
			git("commit", "-qm", "init");
			const ensom = join(rot, "ensom");
			mkdirSync(ensom);
			copyFileSync(SKRIPT, join(ensom, "install.sh"));
			const home = join(rot, "home");
			mkdirSync(home);
			return { rot, kilde, ensom, home };
		}
		const env = (home: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home });

		test("som fil: kloner til --dir og kjører klonens install.sh med --no-start", () => {
			const o = oppsett();
			try {
				const mål = join(o.home, "repos", "pai");
				const p = Bun.spawnSync(["bash", join(o.ensom, "install.sh"), "--repo", o.kilde, "--dir", mål, "--no-start"], { stdin: "ignore", env: env(o.home) });
				const ut = p.stdout.toString();
				expect(p.exitCode).toBe(0);
				expect(ut).toContain(`cloned from ${o.kilde}`);
				expect(ut).toContain("KLONENS install.sh i");
				expect(ut).toMatch(/med: --no-start$/m);
				expect(existsSync(join(mål, ".git"))).toBe(true);
			} finally {
				rmSync(o.rot, { recursive: true, force: true });
			}
		});

		test("fra et rør (curl | bash): leser hele skriptet først og kloner", () => {
			const o = oppsett();
			try {
				const mål = join(o.home, "pai");
				const p = Bun.spawnSync(["bash", "-s", "--", "--repo", o.kilde, "--dir", mål], { stdin: readFileSync(SKRIPT), cwd: o.home, env: env(o.home) });
				expect(p.exitCode).toBe(0);
				expect(p.stdout.toString()).toMatch(/KLONENS install\.sh i .* med: $/m);
				expect(existsSync(join(mål, "SETUP.md"))).toBe(true);
			} finally {
				rmSync(o.rot, { recursive: true, force: true });
			}
		});

		// tmux nekter stdin fra /dev/tty («can't use /dev/tty», MÅLT i LXC 101), så
		// klonens install.sh må få terminalen ved sitt egentlige navn. `script` gir en pty.
		test.skipIf(!Bun.which("script"))("fra et rør i en terminal: klonens install.sh får terminalen ved navn og skrivbar", () => {
			const o = oppsett();
			try {
				writeFileSync(join(o.kilde, "install.sh"), 'echo "STDIN=$(tty)"\n{ printf "\\r" >&0; } 2>/dev/null && echo "STDIN-SKRIVBAR"\n');
				Bun.spawnSync(["git", "commit", "-qam", "tty"], { cwd: o.kilde, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
				const kopi = join(o.rot, "rør.sh");
				copyFileSync(SKRIPT, kopi);
				const mål = join(o.home, "pai");
				const p = Bun.spawnSync(["script", "-qec", `cat '${kopi}' | bash -s -- --repo '${o.kilde}' --dir '${mål}'`, "/dev/null"], { stdin: "ignore", env: env(o.home) });
				const ut = p.stdout.toString();
				expect(ut).toMatch(/STDIN=\/dev\/(pts\/|tty[a-z])/);
				expect(ut).not.toContain("STDIN=/dev/tty\r");
				// tmux-klienten tegner skjermen gjennom stdin: lest bare, så ser brukeren ingenting (MÅLT).
				expect(ut).toContain("STDIN-SKRIVBAR");
			} finally {
				rmSync(o.rot, { recursive: true, force: true });
			}
		});

		/** Den ensomme kopien med en annen PAI_REPO_URL, så testen ikke går mot GitHub. */
		function medAdresse(o: { ensom: string }, adresse: string) {
			const fil = join(o.ensom, "install.sh");
			const før = readFileSync(fil, "utf-8");
			const etter = før.replace(/^PAI_REPO_URL=".*"$/m, `PAI_REPO_URL="${adresse}"`);
			expect(etter).not.toBe(før);
			writeFileSync(fil, etter);
		}

		test("adressen i skriptet er GitHub-repoet, så README-linja trenger ikke --repo", () => {
			expect(readFileSync(SKRIPT, "utf-8")).toMatch(/^PAI_REPO_URL="https:\/\/github\.com\/johansenmeister\/dual-pai\.git"$/m);
		});

		test("uten --repo kloner det fra adressen i skriptet", () => {
			const o = oppsett();
			try {
				medAdresse(o, o.kilde);
				const mål = join(o.home, "pai");
				const p = Bun.spawnSync(["bash", join(o.ensom, "install.sh"), "--dir", mål, "--no-start"], { stdin: "ignore", env: env(o.home) });
				expect(p.exitCode).toBe(0);
				expect(p.stdout.toString()).toContain(`cloned from ${o.kilde}`);
				expect(existsSync(join(mål, "SETUP.md"))).toBe(true);
			} finally {
				rmSync(o.rot, { recursive: true, force: true });
			}
		});

		test("uten --repo og uten adresse i skriptet stopper det med en forklaring", () => {
			const o = oppsett();
			try {
				medAdresse(o, "");
				const p = Bun.spawnSync(["bash", join(o.ensom, "install.sh"), "--dir", join(o.home, "pai")], { stdin: "ignore", env: env(o.home) });
				expect(p.exitCode).toBe(1);
				expect(p.stderr.toString()).toContain("Run again with: --repo <git url>");
			} finally {
				rmSync(o.rot, { recursive: true, force: true });
			}
		});

		test("en mappe som finnes og ikke er tom, blir ikke klonet over", () => {
			const o = oppsett();
			try {
				const mål = join(o.home, "opptatt");
				mkdirSync(mål);
				writeFileSync(join(mål, "noe"), "x");
				const p = Bun.spawnSync(["bash", join(o.ensom, "install.sh"), "--repo", o.kilde, "--dir", mål], { stdin: "ignore", env: env(o.home) });
				expect(p.exitCode).toBe(1);
				expect(p.stderr.toString()).toContain("exists and is not empty");
			} finally {
				rmSync(o.rot, { recursive: true, force: true });
			}
		});
	});
});
