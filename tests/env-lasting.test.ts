/**
 * Tools that read a key from the environment get it from `.env` (#185)
 *
 * Nothing loads `.opencode/.env` into the engine (measured 2026-10-03), so a
 * tool that reads `process.env.X` saw "not set" even with the key in the file.
 * Three layers:
 *
 * - `loadPaiEnv()` itself: the file's values, without overwriting the
 *   environment.
 * - Three tools run end to end against a temp `.env`, on paths that stop before
 *   any network call: with the key they get past the key check, without it
 *   they stop there. The shell scripts are covered by the static guard only.
 * - A static guard over the whole tree: every file that reads a key from
 *   `.env.example` loads the file before the read. A new tool that forgets it,
 *   fails here.
 *
 * @module tests/env-lasting
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { loadPaiEnv, paiEnvDir, parseEnv } from "../.opencode/PAI/Tools/pai-env";
import { envReads, templateKeys } from "./lib/env-lesere";

const TREE = join(import.meta.dir, "..", ".opencode");
const ROOTS = ["skills", "PAI/Tools", "Tools", "tools"];

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "env-lasting-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("loadPaiEnv", () => {
	test("parses export, quotes and a trailing comment", () => {
		const text = ["# comment", "A_KEY=plain", "export B_KEY=exported", 'C_KEY="quoted # kept"', "D_KEY=value # dropped", "E_KEY=", "not a line"];
		expect(parseEnv(text.join("\n"))).toEqual({ A_KEY: "plain", B_KEY: "exported", C_KEY: "quoted # kept", D_KEY: "value", E_KEY: "" });
	});

	test("sets what the environment lacks, and nothing it has", () => {
		const names = ["PAI_ENV_TEST_NEW", "PAI_ENV_TEST_SET", "PAI_ENV_TEST_EMPTY", "PAI_ENV_TEST_BLANK"];
		const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
		try {
			process.env.PAI_ENV_TEST_SET = "from-env";
			process.env.PAI_ENV_TEST_EMPTY = "";
			delete process.env.PAI_ENV_TEST_NEW;
			delete process.env.PAI_ENV_TEST_BLANK;
			writeFileSync(
				join(dir, ".env"),
				"PAI_ENV_TEST_NEW=from-file\nPAI_ENV_TEST_SET=from-file\nPAI_ENV_TEST_EMPTY=from-file\nPAI_ENV_TEST_BLANK=\n",
			);
			expect(loadPaiEnv(dir)).toBe(join(dir, ".env"));
			expect(process.env.PAI_ENV_TEST_NEW).toBe("from-file");
			expect(process.env.PAI_ENV_TEST_SET).toBe("from-env");
			expect(process.env.PAI_ENV_TEST_EMPTY).toBe("from-file");
			expect(process.env.PAI_ENV_TEST_BLANK).toBeUndefined();
		} finally {
			for (const n of names) {
				if (before[n] === undefined) delete process.env[n];
				else process.env[n] = before[n];
			}
		}
	});

	test("no file is not an error", () => {
		expect(loadPaiEnv(join(dir, "missing"))).toBeNull();
	});

	test("the tree: PAI_HOME, then OPENCODE_DIR, then ~/.opencode", () => {
		const saved = { PAI_HOME: process.env.PAI_HOME, OPENCODE_DIR: process.env.OPENCODE_DIR };
		try {
			process.env.PAI_HOME = "/a";
			process.env.OPENCODE_DIR = "/b";
			expect(paiEnvDir()).toBe("/a");
			process.env.PAI_HOME = " ";
			expect(paiEnvDir()).toBe("/b");
			delete process.env.OPENCODE_DIR;
			expect(paiEnvDir()).toMatch(/\/\.opencode$/);
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});
});

/** Runs a tool with only a temp tree: no real `~/.opencode/.env` can answer. */
function run(cmd: string[], env: Record<string, string>): string {
	const r = Bun.spawnSync(cmd, {
		env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(dir, "home"), ...env },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	});
	return r.stdout.toString() + r.stderr.toString();
}

describe("the tools find a key that is only in .env", () => {
	const withKey = () => join(dir, "with");
	const withoutKey = () => join(dir, "without");
	beforeEach(() => {
		mkdirSync(withKey());
		mkdirSync(withoutKey());
		mkdirSync(join(dir, "home"));
	});

	// The Infrastructure skills are this tree's own; the job tree does not have them.
	const trueNas = join(TREE, "skills/Infrastructure/TrueNAS/Scripts/trueNasApi.ts");

	test.skipIf(!existsSync(trueNas))("trueNasApi.ts: TRUENAS_API_URL and TRUENAS_API_KEY", () => {
		// Port 1 refuses at once: the tool gets as far as connecting, and no further.
		writeFileSync(join(withKey(), ".env"), 'TRUENAS_API_URL=https://127.0.0.1:1/api/v2.0\nTRUENAS_API_KEY="k-test"\n');
		const tool = trueNas;
		const found = run(["bun", tool, "system.info"], { PAI_HOME: withKey() });
		expect(found).toContain("wss://127.0.0.1:1/api/current");
		expect(found).not.toContain("MISSING");
		expect(run(["bun", tool, "system.info"], { PAI_HOME: withoutKey() })).toContain("MISSING TRUENAS_API_KEY");
	});

	for (const name of ["ExtractTranscript", "SplitAndTranscribe"]) {
		test(`${name}.ts: OPENAI_API_KEY`, () => {
			// A file that does not exist stops the tool after the key check, before the API.
			writeFileSync(join(withKey(), ".env"), "OPENAI_API_KEY=sk-test-only\n");
			const tool = join(TREE, "PAI/Tools", `${name}.ts`);
			const args = ["bun", tool, join(dir, "missing.mp3")];
			const found = run(args, { PAI_HOME: withKey() });
			expect(found).toContain("missing.mp3");
			expect(found).not.toContain("OPENAI_API_KEY not set");
			expect(run(args, { PAI_HOME: withoutKey() })).toContain("OPENAI_API_KEY not set");
		});
	}

});

/**
 * Files that read a template key from the environment and load `.env` their
 * own way. They can move to `loadPaiEnv()`; the list should only shrink.
 */
const OWN_LOADER: Record<string, string> = {
	"PAI/Tools/MineReflections.ts": "own parser into process.env",
	"PAI/Tools/RemoveBg.ts": "own parser into process.env",
	"PAI/Tools/YouTubeApi.ts": "own parser, process.env first",
	"skills/Infrastructure/Technitium/Scripts/technitiumApi.ts": "own parser, process.env first",
	"skills/Telos/DashboardTemplate/App/api/chat/route.ts": "a Next.js app template; Next loads the app's own .env",
};

const SOURCES_ENV = /(?:^|[\s;])(?:source|\.)\s+["']?(?:~|\$HOME|\$\{HOME\})\/\.opencode\/\.env\b|(?:source|\.)\s+["']?\$\{?ENV_FILE\}?/m;

/** Why a file that reads `keys` does not load `.env` first, or null when it does. */
function notLoaded(file: string, text: string, keys: string[]): string | null {
	const ext = extname(file);
	if ([".ts", ".js", ".mjs"].includes(ext)) {
		if (file in OWN_LOADER) return null;
		const call = text.search(/^loadPaiEnv\(\);?$/m);
		if (call < 0) return "no loadPaiEnv() at the top of the file";
		const firstRead = Math.min(
			...keys.map((k) => text.search(new RegExp(`(?:process\\.env|Bun\\.env)(?:\\.${k}\\b|\\[\\s*["'\`]${k}["'\`])`))).filter((i) => i >= 0),
		);
		return firstRead < call ? "loadPaiEnv() comes after the first read" : null;
	}
	if (ext === ".py") return /load_dotenv\(|["']\.env["']|\/\.env["']\s*\)/.test(text) ? null : "does not read a .env file";
	if (ext === ".sh" || ext === ".md") return SOURCES_ENV.test(text) ? null : "does not source ~/.opencode/.env";
	return null;
}

describe("every reader of a template key loads .env (#185)", () => {
	const template = templateKeys(readFileSync(join(TREE, ".env.example"), "utf-8"));
	const { reads } = envReads(TREE, ROOTS);
	const byFile = new Map<string, string[]>();
	for (const [name, files] of reads) {
		if (!template.has(name)) continue;
		for (const f of new Set(files)) byFile.set(f, [...(byFile.get(f) ?? []), name]);
	}

	test("the tree is read: over 15 files read a template key", () => {
		expect(byFile.size).toBeGreaterThan(15);
	});

	test("each one loads the file before it reads", () => {
		const missing = [...byFile]
			.map(([f, keys]) => [f, notLoaded(f, readFileSync(join(TREE, f), "utf-8"), keys)] as const)
			.filter(([, why]) => why)
			.map(([f, why]) => `${f}: ${why}`)
			.sort();
		// TypeScript: `import { loadPaiEnv } from ".../PAI/Tools/pai-env"` and
		// `loadPaiEnv();` on its own line after the imports. Shell and workflows:
		// `set -a; . ~/.opencode/.env; set +a` before the first use.
		expect(missing).toEqual([]);
	});

	test("every OWN_LOADER file that exists still reads a template key", () => {
		// A tool that moved to loadPaiEnv() leaves the list. The list travels to
		// trees that lack some of the files, so a missing file is not stale.
		const stale = Object.keys(OWN_LOADER).filter((f) => existsSync(join(TREE, f)) && !byFile.has(f));
		expect(stale).toEqual([]);
	});
});
