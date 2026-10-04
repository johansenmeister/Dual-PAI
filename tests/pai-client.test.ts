/**
 * Kontrakt-test: `scripts/pai-client.sh` (#162, fase 3, planens punkt 11)
 *
 * Skriptet er prøvd ende til ende mot en sshd på 127.0.0.1 (2026-10-04). Her
 * er `ssh` en stubb, så testen vokter det som skjer i brukerens `~/.ssh/config`:
 * blokken øverst, en ny kjøring erstatter den, en egen `Host pai` stopper
 * skriptet, og en lenket konfig forblir en lenke.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKRIPT = join(import.meta.dir, "..", "scripts", "pai-client.sh");

let rot: string;
let hjem: string;
let bin: string;

/** `ssh` svarer ja på alt; oppslaget etter tmux gir `$STUB_TMUX`. */
const SSH_STUBB = `#!/bin/sh
for a; do last=$a; done
case $last in *"command -v tmux"*) [ -n "$STUB_TMUX" ] && echo "$STUB_TMUX" ;; esac
exit 0
`;

beforeEach(() => {
	rot = mkdtempSync(join(tmpdir(), "pai-client-"));
	hjem = join(rot, "home");
	bin = join(rot, "bin");
	mkdirSync(join(hjem, ".ssh"), { recursive: true });
	mkdirSync(bin);
	writeFileSync(join(hjem, ".ssh", "id_ed25519"), "nøkkel\n");
	for (const [navn, innhold] of [
		["ssh", SSH_STUBB],
		["ssh-keygen", "#!/bin/sh\nexit 0\n"],
		["ssh-copy-id", "#!/bin/sh\nexit 0\n"],
	]) {
		writeFileSync(join(bin, navn), innhold);
		chmodSync(join(bin, navn), 0o755);
	}
	for (const v of ["awk", "grep", "sed", "cat", "rm", "mv", "mkdir", "chmod", "touch", "dirname"]) {
		const sti = Bun.which(v);
		if (sti) symlinkSync(sti, join(bin, v));
	}
});

afterEach(() => rmSync(rot, { recursive: true, force: true }));

function kjør(args: string[], tmux = "/usr/bin/tmux") {
	const p = Bun.spawnSync([Bun.which("bash") ?? "/bin/bash", SKRIPT, ...args], {
		stdin: "ignore",
		env: { PATH: bin, HOME: hjem, USER: "anna", STUB_TMUX: tmux },
	});
	return { kode: p.exitCode, ut: p.stdout.toString(), feil: p.stderr.toString() };
}

const konfig = () => readFileSync(join(hjem, ".ssh", "config"), "utf-8");
const ARGS = ["--host", "10.0.0.5", "--user", "anna"];

describe("pai-client.sh", () => {
	test("syntaksen er gyldig, og --help skriver bruken", () => {
		expect(Bun.spawnSync(["bash", "-n", SKRIPT]).exitCode).toBe(0);
		const r = kjør(["--help"]);
		expect(r.kode).toBe(0);
		expect(r.ut).toContain("ssh pai-shell");
		expect(r.ut).not.toContain("set -euo");
	});

	test("blokken står øverst med tmux -u og full sti, og resten av fila blir stående", () => {
		writeFileSync(join(hjem, ".ssh", "config"), "ServerAliveInterval 60\n\nHost git.example\n  User git\n");
		const r = kjør(ARGS, "/opt/homebrew/bin/tmux");
		expect(r.kode).toBe(0);
		const k = konfig();
		expect(k.startsWith("# >>> PAI client: pai >>>\n")).toBe(true);
		expect(k).toContain("RemoteCommand /opt/homebrew/bin/tmux -u new-session -A -s pai");
		expect(k).toContain("Host pai-shell\n");
		// Globale linjer etter blokken skal fortsatt gjelde alle verter.
		expect(k).toContain("Host *\n# <<< PAI client: pai <<<\nServerAliveInterval 60\n");
		expect(k).toContain("Host git.example\n  User git\n");
	});

	test("en ny kjøring erstatter blokken i stedet for å legge til en til", () => {
		writeFileSync(join(hjem, ".ssh", "config"), "Host git.example\n  User git\n");
		expect(kjør(ARGS).kode).toBe(0);
		const første = konfig();
		expect(kjør(["--host", "10.0.0.6", "--user", "anna"]).kode).toBe(0);
		const andre = konfig();
		expect(andre.match(/>>> PAI client: pai >>>/g)?.length).toBe(1);
		expect(andre).toContain("HostName 10.0.0.6");
		expect(andre).not.toContain("HostName 10.0.0.5");
		expect(andre.length).toBe(første.length);
	});

	test("en egen Host pai stopper skriptet og lar fila være, også som eneste navn", () => {
		for (const før of ["Host pai\n  HostName 192.0.2.1\n", "Host other pai\n", "  host PAI-shell\n"]) {
			writeFileSync(join(hjem, ".ssh", "config"), før);
			const r = kjør(ARGS);
			expect(r.kode).toBe(1);
			expect(r.feil).toContain("--alias");
			expect(konfig()).toBe(før);
		}
	});

	test("en vert som bare begynner på aliaset, stopper ikke skriptet", () => {
		writeFileSync(join(hjem, ".ssh", "config"), "Host pai-prod\n  HostName 192.0.2.1\n");
		expect(kjør(ARGS).kode).toBe(0);
	});

	test("uten tmux på serveren stopper skriptet før konfigen skrives", () => {
		writeFileSync(join(hjem, ".ssh", "config"), "Host git.example\n");
		const r = kjør(ARGS, "");
		expect(r.kode).toBe(1);
		expect(r.feil).toContain("tmux is not installed");
		expect(konfig()).toBe("Host git.example\n");
	});

	test("en lenket konfig forblir en lenke", () => {
		const ekte = join(rot, "dotfiles-ssh-config");
		writeFileSync(ekte, "Host git.example\n");
		symlinkSync(ekte, join(hjem, ".ssh", "config"));
		expect(kjør(ARGS).kode).toBe(0);
		expect(lstatSync(join(hjem, ".ssh", "config")).isSymbolicLink()).toBe(true);
		expect(readFileSync(ekte, "utf-8")).toContain("Host pai\n");
	});
});
