/**
 * Kontrakt-test: `sync-end.sh` sender aldri en hemmelighet til Gitea (K16)
 *
 * Skriptet gjør `git add -A` og pusher, så det eneste som holder en nøkkel
 * ute, er `.gitignore`. Jobbens Graph-privatnøkkel lå usporet i `.opencode/`,
 * og bare jobbens `*.pem`-regel holdt den ute; hjemme lå `..env.swp` usporet
 * og uignorert (2026-09-27). Vakten ser på det som skal pushes, og nekter når
 * en sti eller en ny linje ser ut som en hemmelighet.
 *
 * Kjører det ekte skriptet mot et temp-repo med en bare-remote. Begge
 * retningene sjekkes: det nekter når noe er galt, og det er taust og pusher
 * når alt er riktig (regel 1 i «Vaktene: tre lag»).
 *
 * @module tests/sync-end
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SKRIPT = join(import.meta.dir, "..", "scripts", "sync-end.sh");

// Delt i to, så denne fila aldri inneholder en hel nøkkelblokk selv.
const BLOKK = `-----BEGIN ${"OPENSSH PRIVATE"} KEY-----`;

let rot: string;
let repo: string;
let remote: string;

function miljø(ekstra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: rot,
		PAI_REPO: repo,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
		LC_ALL: "C.UTF-8",
		...ekstra,
	};
}

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], { cwd, env: miljø(), stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

function skriv(sti: string, innhold = "x\n"): void {
	const full = join(repo, sti);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, innhold);
}

function syncEnd(ekstra: Record<string, string> = {}): { kode: number; ut: string; feil: string } {
	const r = Bun.spawnSync(["bash", SKRIPT], { cwd: rot, env: miljø(ekstra), stdout: "pipe", stderr: "pipe" });
	return { kode: r.exitCode, ut: r.stdout.toString(), feil: r.stderr.toString() };
}

/** Filene i remotens `main`. */
function påRemote(): string[] {
	return git(remote, "ls-tree", "-r", "-z", "--name-only", "main").split("\0").filter(Boolean);
}

beforeEach(() => {
	rot = mkdtempSync(join(tmpdir(), "pai-sync-end-"));
	remote = join(rot, "remote.git");
	repo = join(rot, "repo");
	git(rot, "init", "-q", "--bare", "-b", "main", remote);
	git(rot, "clone", "-q", remote, repo);
	git(repo, "checkout", "-q", "-b", "main");
	skriv("README.md", "hei\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "start");
	git(repo, "push", "-q", "-u", "origin", "main");
});

afterEach(() => {
	rmSync(rot, { recursive: true, force: true });
});

describe("sync-end.sh nekter hemmeligheter (K16)", () => {
	test("en vanlig endring committes og pushes", () => {
		skriv("MEMORY/WORK/økt/META.yaml", "status: COMPLETED\n");
		const r = syncEnd();
		expect(r.feil).not.toContain("✗");
		expect(r.kode).toBe(0);
		expect(påRemote()).toContain("MEMORY/WORK/økt/META.yaml");
	});

	for (const [sti, grunn] of [
		[".opencode/graph-jobb.pem", "*.pem"],
		[".opencode/.env", ".env"],
		[".opencode/..env.swp", ".env"],
		["config/prod.env", ".env"],
		[".env.local", ".env"],
		["nøkler/id_ed25519", "id_*"],
		["nøkler/id_jobb", "id_*"],
	] as const) {
		test(`nekter ${sti} (${grunn}), og ingenting når remoten`, () => {
			skriv("MEMORY/annet.md");
			skriv(sti);
			const r = syncEnd();
			expect(r.kode).toBe(1);
			expect(r.feil).toContain(`✗ Not committing ${sti}:`);
			expect(r.feil).toContain(grunn);
			expect(påRemote()).toEqual(["README.md"]);
			// Ikke committet lokalt heller, og stien er ute av indeksen igjen.
			expect(git(repo, "rev-list", "--count", "HEAD")).toBe("1");
			expect(git(repo, "ls-files", "--", sti)).toBe("");
		});
	}

	test("eksempelfiler og offentlige nøkler slipper gjennom", () => {
		for (const sti of [
			".opencode/.env.example",
			"skill-packs/infra-blueprint/VALUES.example.env",
			"nøkler/id_ed25519.pub",
			"docs/id_mapping.md",
		])
			skriv(sti);
		const r = syncEnd();
		expect(r.feil).not.toContain("✗");
		expect(r.kode).toBe(0);
		expect(påRemote()).toContain(".opencode/.env.example");
		expect(påRemote()).toContain("nøkler/id_ed25519.pub");
	});

	test("en nøkkelblokk i innholdet nektes, uansett filnavn, også med mellomrom i stien", () => {
		skriv("MEMORY/WORK/økt med mellomrom/notat.md", `Her er den:\n${BLOKK}\nb3BlbnNzaA==\n`);
		const r = syncEnd();
		expect(r.kode).toBe(1);
		expect(r.feil).toContain("✗ Not committing MEMORY/WORK/økt med mellomrom/notat.md: private key");
		expect(git(repo, "ls-files", "--", "MEMORY")).toBe("");
		expect(påRemote()).toEqual(["README.md"]);
	});

	test("en commit som ikke er pushet ennå, stoppes også før push", () => {
		skriv(".opencode/graph-jobb.pem");
		git(repo, "add", "-f", "-A");
		git(repo, "commit", "-q", "-m", "manuell commit med nøkkel");
		const r = syncEnd();
		expect(r.kode).toBe(1);
		expect(r.feil).toContain("graph-jobb.pem");
		expect(påRemote()).toEqual(["README.md"]);
	});

	test("en nøkkelblokk som alt ligger på remoten, gir ingen alarm ved neste endring", () => {
		// Regel 1: en vakt som roper hver gang, er verre enn ingen. Et eksempel
		// i en runbook skal ikke stoppe autosynken i hver økt etter.
		skriv("runbooks/eksempel.md", `${BLOKK}\n`);
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "eksempel");
		git(repo, "push", "-q");
		skriv("runbooks/eksempel.md", `${BLOKK}\nen linje til\n`);
		const r = syncEnd();
		expect(r.feil).not.toContain("✗");
		expect(r.kode).toBe(0);
	});

	test("en innholdslinje som begynner med «++ » forveksles ikke med filnavnet", () => {
		// I `-U0`-diffen blir en ny linje «++ x» til «+++ x». Leste awk den som
		// filhodet, ville funnet på neste linje blitt meldt på feil sti.
		skriv("docs/a.md", `++ ikke et filnavn\n${BLOKK}\n`);
		const r = syncEnd();
		expect(r.kode).toBe(1);
		expect(r.feil).toContain("✗ Not committing docs/a.md:");
	});
});

/**
 * #370 (work issue #11): the autosync pushed a `THREAD.md` with a Gitea PAT in
 * a remote URL, because the guard only knew key files and key blocks. New
 * lines now go through `Tools/SecretScan.ts`, which uses the same patterns and
 * known `.env` values as the masking for the model. Fake values are built at
 * runtime, as in `secrets.test.ts`.
 */
describe("sync-end.sh refuses tokens in the content (#370)", () => {
	const PAT = `${"3".repeat(20)}${"f".repeat(20)}`; // 40 hex, like a Gitea token
	const SHA = "88fa026e9d3b1c4f5a6b7c8d9e0f1a2b3c4d5e6f";
	const THREAD = "MEMORY/WORK/2026-10/økt/THREAD.md";

	test("a user:token@host URL is refused, as in the work issue, and the value is never printed", () => {
		skriv(THREAD, `ran: git remote set-url origin https://svc-bot:${PAT}@git.example.invalid/org/repo.git\n`);
		const r = syncEnd();
		expect(r.kode).toBe(1);
		expect(r.feil).toContain(`✗ Not committing ${THREAD}: token in the content (url-credential). Remove the value from the file.`);
		expect(r.ut + r.feil).not.toContain(PAT);
		expect(git(repo, "ls-files", "--", "MEMORY")).toBe("");
		expect(påRemote()).toEqual(["README.md"]);
	});

	test("a bare token is refused when its value is in ~/.opencode/.env, named by its variable", () => {
		skriv("../.opencode/.env", `GITEA_TOKEN=${PAT}\n`);
		skriv(THREAD, `the token is ${PAT}\n`);
		const r = syncEnd();
		expect(r.kode).toBe(1);
		expect(r.feil).toContain("token in the content (GITEA_TOKEN)");
		expect(r.ut + r.feil).not.toContain(PAT);
		expect(påRemote()).toEqual(["README.md"]);
	});

	test("placeholders, commit hashes and env references are pushed", () => {
		skriv(
			"runbooks/oppsett.md",
			[
				"GITEA_TOKEN=your-token-here",
				"GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx",
				"curl -H \"Authorization: token $GITEA_TOKEN\" https://git.example.invalid",
				`git show ${SHA}`,
				"",
			].join("\n")
		);
		const r = syncEnd();
		expect(r.feil).not.toContain("✗");
		expect(r.kode).toBe(0);
		expect(påRemote()).toContain("runbooks/oppsett.md");
	});

	test("a token already on the remote gives no alarm on the next change", () => {
		skriv("tests/fixture.ts", `const url = "https://u:${PAT}@h/x";\n`);
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "fixture");
		git(repo, "push", "-q");
		skriv("tests/fixture.ts", `const url = "https://u:${PAT}@h/x";\nexport { url };\n`);
		const r = syncEnd();
		expect(r.feil).not.toContain("✗");
		expect(r.kode).toBe(0);
	});

	test("if the scanner fails, it says so and pushes; file names were checked anyway", () => {
		const falsk = join(rot, "falsk-bun");
		mkdirSync(falsk);
		writeFileSync(join(falsk, "bun"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
		skriv(THREAD, `https://svc-bot:${PAT}@git.example.invalid/x.git\n`);
		const r = syncEnd({ PATH: `${falsk}:${process.env.PATH ?? "/usr/bin:/bin"}` });
		expect(r.kode).toBe(0);
		expect(r.feil).toContain("⚠ The token check failed, so the content was not checked for tokens.");
		expect(påRemote()).toContain(THREAD);
	});

	const gitKatalog = dirname(Bun.which("git") ?? "/usr/bin/git");
	test.skipIf(existsSync(join(gitKatalog, "bun")))("without bun on PATH it says so and pushes", () => {
		skriv("MEMORY/annet.md");
		const r = syncEnd({ PATH: gitKatalog });
		expect(r.kode).toBe(0);
		expect(r.feil).toContain("⚠ Did not check the content for tokens: bun is not on PATH.");
		expect(påRemote()).toContain("MEMORY/annet.md");
	});
});

/**
 * K47: `sync-end.sh` genererer Claude-speilet før commit. Generatoren her er
 * falsk: `speil.md` skal være lik `kilde.md`, og `--sjekk` sier om den er det.
 * Den ekte generatorens innhold er `claude-mirror.test.ts` sitt ansvar; dette
 * er koblingen i skriptet.
 */
describe("sync-end.sh holder Claude-speilet ferskt (K47)", () => {
	const GENERATOR = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
if (process.env.FALSK_GENERATOR_FEIL) process.exit(2);
const kilde = readFileSync("kilde.md", "utf8");
const speil = existsSync("speil.md") ? readFileSync("speil.md", "utf8") : null;
if (process.argv.includes("--sjekk")) process.exit(speil === kilde ? 0 : 1);
writeFileSync("speil.md", kilde);
`;

	beforeEach(() => {
		skriv("Tools/BuildClaudePlugin.ts", GENERATOR);
		skriv("kilde.md", "v1\n");
		skriv("speil.md", "v1\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "generator");
		git(repo, "push", "-q");
	});

	const påRemoteInnhold = (sti: string) => git(remote, "show", `main:${sti}`);

	test("et gammelt speil genereres og pushes sammen med kilden", () => {
		skriv("kilde.md", "v2\n");
		const r = syncEnd();
		expect(r.kode).toBe(0);
		expect(r.ut).toContain("↻ The Claude mirror was stale and has been regenerated.");
		expect(påRemoteInnhold("speil.md")).toBe("v2");
	});

	test("taus når speilet er ferskt", () => {
		skriv("MEMORY/annet.md");
		const r = syncEnd();
		expect(r.kode).toBe(0);
		expect(r.ut + r.feil).not.toContain("mirror");
		expect(påRemote()).toContain("MEMORY/annet.md");
	});

	test("feiler genereringen, pushes resten likevel, med én linje", () => {
		skriv("kilde.md", "v2\n");
		const r = syncEnd({ FALSK_GENERATOR_FEIL: "1" });
		expect(r.kode).toBe(0);
		expect(r.feil).toContain("⚠ The Claude mirror is stale, and regenerating it failed. Run: bun Tools/BuildClaudePlugin.ts");
		expect(påRemoteInnhold("kilde.md")).toBe("v2");
		expect(påRemoteInnhold("speil.md")).toBe("v1");
	});

	// En PATH med git og uten bun. Ligger de i samme katalog, lar det seg ikke lage.
	const gitKatalog = dirname(Bun.which("git") ?? "/usr/bin/git");
	test.skipIf(existsSync(join(gitKatalog, "bun")))("uten bun på PATH sier den fra og pusher", () => {
		skriv("kilde.md", "v2\n");
		const r = syncEnd({ PATH: gitKatalog });
		expect(r.kode).toBe(0);
		expect(r.feil).toContain("⚠ Did not check the Claude mirror: bun is not on PATH.");
		expect(påRemoteInnhold("kilde.md")).toBe("v2");
	});
});
