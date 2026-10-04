#!/usr/bin/env bun
/**
 * shell-setup.ts — `pai`-funksjonen i login-skallets profil (#215, #221)
 *
 * `install.sh` kjører dette på hver ny maskin, den første og maskin nummer to.
 * Fila velges med `shellProfile` (`$SHELL`, ellers kontoens login-skall), og
 * skrives ut. Markørene står som før, så en blokk fra den gamle installeren
 * byttes ut og ikke legges til en gang til.
 *
 * `--profile` skriver ingenting, men gir fila og skallets navn på hver sin
 * linje: `guide/gitea/sync.sh` legger synkaliasene i samme fil (#232).
 *
 * Bruk:
 *   bun PAI-Install/cli/shell-setup.ts
 *   bun PAI-Install/cli/shell-setup.ts --profile
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The `pai` function between PAI's markers, in fish or POSIX syntax. */
export function paiFunctionBlock(shellName: string, installDir: string): string {
	// POSIX shells use "$@"; fish uses $argv and function/end syntax.
	const escapedInstallDir = installDir.replaceAll('"', '\\"');
	const aliasBlock = shellName === "fish"
		? `set -gx PATH $HOME/.bun/bin $HOME/.local/bin $PATH\n\nfunction pai\n\tset -l __pai_oldpwd (pwd)\n\tset -l __pai_bun "$HOME/.bun/bin/bun"\n\tcd "${escapedInstallDir}"\n\tif test -x $__pai_bun\n\t\t$__pai_bun run .opencode/PAI/Tools/pai.ts $argv\n\telse\n\t\tbun run .opencode/PAI/Tools/pai.ts $argv\n\tend\n\tset -l __pai_status $status\n\tcd $__pai_oldpwd\n\treturn $__pai_status\nend`
		: `export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"\n\npai() {\n  (cd "${escapedInstallDir}" &&\n    if [ -x "$HOME/.bun/bin/bun" ]; then\n      "$HOME/.bun/bin/bun" run .opencode/PAI/Tools/pai.ts "$@"\n    else\n      bun run .opencode/PAI/Tools/pai.ts "$@"\n    fi\n  )\n}`;
	return `# PAI shell setup — added by PAI installer\n${aliasBlock}\n# end PAI shell setup`;
}

/**
 * Writes the `pai` function to `shellConfig`, replacing an earlier PAI block or
 * hand-written `pai`/`opencode` function there.
 */
export function writePaiFunction(shellConfig: string, shellName: string, installDir: string): void {
	// Ensure parent directory exists (matters for fish: ~/.config/fish/ may be absent)
	mkdirSync(dirname(shellConfig), { recursive: true });

	const existing = existsSync(shellConfig)
		? readFileSync(shellConfig, "utf-8")
		: "";

	let content = existing;
	content = content.replace(/\n?# PAI shell setup — added by PAI installer[\s\S]*?# end PAI shell setup\n?/g, "");
	content = content.replace(
		/\n?#\s*PAI\s*(?:alias|shell\s*setup|setup|installer|installed|PAI)[^\n]*[\s\S]*?(?=\n(?:#|alias\b|export\b|set\b|source\b|pai\(\)|opencode\(\)|function\s+pai\b|function\s+opencode\b|function\s+\w+\b)|$)/gi,
		""
	);
	content = content.replace(
		/^pai\(\)\s*\{[\s\S]*?^\}\s*(?=\n(?:#|alias\b|export\b|set\b|source\b|pai\(\)|opencode\(\)|function\s+pai\b|function\s+opencode\b|function\s+\w+\b)|$)\n?/gm,
		""
	);
	content = content.replace(
		/^opencode\(\)\s*\{[\s\S]*?^\}\s*(?=\n(?:#|alias\b|export\b|set\b|source\b|pai\(\)|opencode\(\)|function\s+pai\b|function\s+opencode\b|function\s+\w+\b)|$)\n?/gm,
		""
	);
	content = content.replace(
		/^function\s+pai\s*$[\s\S]*?^end\s*(?=\n(?:#|alias\b|export\b|set\b|source\b|pai\(\)|opencode\(\)|function\s+pai\b|function\s+opencode\b|function\s+\w+\b)|$)\n?/gm,
		""
	);
	content = content.replace(
		/^function\s+opencode\s*$[\s\S]*?^end\s*(?=\n(?:#|alias\b|export\b|set\b|source\b|pai\(\)|opencode\(\)|function\s+pai\b|function\s+opencode\b|function\s+\w+\b)|$)\n?/gm,
		""
	);
	content = content.replace(/^alias pai=.*\n?/gm, "");
	content = content.replace(/^alias pai\s+.*\n?/gm, "");

	content = `${content.trimEnd()}\n\n${paiFunctionBlock(shellName, installDir)}\n`;
	writeFileSync(shellConfig, content.endsWith("\n") ? content : `${content}\n`);
}

/**
 * The file that gets the `pai` function (#215). `$SHELL` first, then the
 * account's login shell from the password database: SHELL is missing under
 * `env -i` and in some ssh and sudo setups. zsh, bash and fish get their own rc
 * file. Any other shell (sh, dash, ksh, or none known) gets ~/.profile, which
 * every POSIX login shell reads; the old fallback, ~/.zshrc, was never read by a
 * /bin/sh account, and nothing said so.
 */
export function shellProfile(shellPath: string | undefined, home: string): { file: string; shell: string } {
	const shell = shellPath?.split("/").pop() || "sh";
	switch (shell) {
		case "zsh":
			return { file: join(home, ".zshrc"), shell };
		case "bash":
			return { file: join(home, ".bashrc"), shell };
		case "fish":
			return { file: join(home, ".config", "fish", "config.fish"), shell };
		default:
			return { file: join(home, ".profile"), shell };
	}
}

if (import.meta.main) {
	const { file, shell } = shellProfile(process.env.SHELL || userInfo().shell || undefined, homedir());
	if (process.argv.includes("--profile")) {
		console.log(`${file}\n${shell}`);
	} else {
		writePaiFunction(file, shell, resolve(import.meta.dir, "..", ".."));
		console.log(file);
	}
}
