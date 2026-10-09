/**
 * Every environment variable a skill or tool reads is in `.env.example` (#183)
 *
 * The `.env` step of the run plan (#162) assumes the template is complete. A
 * key a tool reads that is not there, a new user finds only when the tool fails
 * with "not set". The scan covers `skills/`, `PAI/Tools/`, `Tools/` and
 * `tools/` under `.opencode`; what it counts as a read is in
 * `tests/lib/env-lesere.ts`. A name that is not a key belongs in `EXCEPTIONS`,
 * with the reason.
 *
 * @module tests/env-mal
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeReads, envReads, shellReads, templateKeys } from "./lib/env-lesere";

const TREE = join(import.meta.dir, "..", ".opencode");
const ROOTS = ["skills", "PAI/Tools", "Tools", "tools"];

const OS = "set by the OS, the shell or the terminal";
const HARNESS = "set by the launcher, the engine or PAI itself";
const DEV = "a development override for tests; the default is right for users";
const OPTION = "a per-run option with a working default; nothing fails without it";
const PLACEHOLDER = "a placeholder in a workflow's example, filled in by the agent";

const EXCEPTIONS: Record<string, string> = {
	HOME: OS,
	PATH: OS,
	TMPDIR: OS,
	TERM: OS,
	COLORTERM: OS,
	COLUMNS: OS,
	KITTY_WINDOW_ID: OS,
	USERPROFILE: OS,
	OSTYPE: OS,
	BASH_SOURCE: OS,
	PIPESTATUS: OS,
	XDG_CACHE_HOME: OS,
	XDG_CONFIG_HOME: OS,
	XDG_DATA_HOME: OS,
	XDG_RUNTIME_DIR: OS,
	PAI_DIR: HARNESS,
	PAI_HOME: HARNESS,
	OPENCODE_DIR: HARNESS,
	CLAUDECODE: HARNESS,
	CLAUDE_CONFIG_DIR: HARNESS,
	DISABLE_AUTOUPDATER: HARNESS,
	PAI_CLAUDE_BIN: DEV,
	PAI_CLAUDE_PLUGIN_DIR: DEV,
	PAI_OPENCODE2_BIN: DEV,
	BROWSER_HEADLESS: OPTION,
	BROWSER_HEIGHT: OPTION,
	BROWSER_PORT: OPTION,
	BROWSER_TOKEN: OPTION,
	BROWSER_WIDTH: OPTION,
	CURL_TIMEOUT: OPTION,
	LOG_LIMIT: OPTION,
	SSH_TIMEOUT: OPTION,
	STALE_SECONDS: OPTION,
	PROJECTS_DIR: OPTION,
	THREATMODEL_DATA_DIR: OPTION,
	API_BASE_URL: PLACEHOLDER,
	PORT: PLACEHOLDER,
	RUNNER_DEBUG: PLACEHOLDER,
	BROWSER: PLACEHOLDER,
	BLOCK: PLACEHOLDER,
	PRIVATE_REPO: PLACEHOLDER,
	PUBLIC_REPO: PLACEHOLDER,
};

/** `OPNSENSE_ENV_FILE` and the like point at the `.env` file itself. */
const EXCEPTION_PATTERNS: [RegExp, string][] = [[/_ENV_FILE$/, OPTION]];

function excepted(name: string): boolean {
	return name in EXCEPTIONS || EXCEPTION_PATTERNS.some(([re]) => re.test(name));
}

describe("the scanner", () => {
	test("finds the code forms, and not a write or a delete", () => {
		const ts = [
			"const a = process.env.A_KEY;",
			"const b = Bun.env.B_KEY;",
			'const c = process.env["C_KEY"];',
			"const d = env.D_KEY || process.env.D_KEY;",
			'if (line.startsWith("E_KEY=")) {}',
			'process.env.W_KEY = "0";',
			"delete env.X_KEY;",
		].join("\n");
		expect(codeReads(ts).sort()).toEqual(["A_KEY", "B_KEY", "C_KEY", "D_KEY", "E_KEY"]);
		const py = ['a = os.environ.get("A_KEY")', 'b = os.getenv("B_KEY", "")', 'c = ENV["C_KEY"]', 'd = ENV.get("D_KEY") or "x"'];
		expect(codeReads(py.join("\n")).sort()).toEqual(["A_KEY", "B_KEY", "C_KEY", "D_KEY"]);
	});

	// biome-ignore-start lint/suspicious/noTemplateCurlyInString: shell ${X} in shell samples, not JS templates
	test("shell: what is read and not assigned, and X=${X:-default}", () => {
		const sh = [
			'LIMIT="${LIMIT:-50}"',
			"LOCAL=1",
			"for ITEM in a b; do echo $ITEM; done",
			"read -r FIRST SECOND <<< x",
			'curl -H "$TOKEN_KEY" "${URL_KEY}/x" -m "$LIMIT" $LOCAL $FIRST $SECOND',
		].join("\n");
		expect(shellReads(sh).sort()).toEqual(["LIMIT", "TOKEN_KEY", "URL_KEY"]);
		expect(shellReads(sh, new Set(["URL_KEY"])).sort()).toEqual(["LIMIT", "TOKEN_KEY"]);
	});
	// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of the shell samples

	test("markdown: shell fences, and code in any fence", () => {
		const r = envReads(join(import.meta.dir, "fixtures", "env-lesere"), ["skills"]);
		expect([...r.reads.keys()].sort()).toEqual(["API_SECRET", "API_URL", "PY_KEY"]);
	});
});

describe(".env.example covers what the tools read (#183)", () => {
	const template = templateKeys(readFileSync(join(TREE, ".env.example"), "utf-8"));
	const { reads, files } = envReads(TREE, ROOTS);

	test("the tree is read: over 300 files and 30 variables", () => {
		// A root that has moved gives zero reads and a green test.
		expect(files).toBeGreaterThan(300);
		expect(reads.size).toBeGreaterThan(30);
	});

	test("every variable read is in .env.example or an exception", () => {
		const missing = [...reads]
			.filter(([name]) => !template.has(name) && !excepted(name))
			.map(([name, where]) => `${name} (${[...new Set(where)].slice(0, 3).join(", ")})`)
			.sort();
		// Add a key to its group in .opencode/.env.example, or a name that is not a
		// key to EXCEPTIONS in this file, with the reason.
		expect(missing).toEqual([]);
	});

	test("no exception is also a key in the template", () => {
		expect([...template].filter(excepted)).toEqual([]);
	});
});
