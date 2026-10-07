/**
 * The secrets module: known values from `.env`, token shapes, and what must
 * NOT be masked (git hashes, ordinary code, paths).
 *
 * Fake tokens are built at runtime, never written as literals: the repository
 * is mirrored publicly, and a token-shaped literal would trip secret scanners
 * and PAI's own guard.
 *
 * @module tests/secrets
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forStorage, knownSecrets, maskDeep, maskNotice, maskSecrets, parseEnvSecrets } from "../.opencode/pai-core/lib/secrets";

const r = (n: number, c = "a") => c.repeat(n);
const GITEA = `${r(20, "3")}${r(20, "f")}`; // 40 hex, like a Gitea token
const SHA = "88fa026e9d3b1c4f5a6b7c8d9e0f1a2b3c4d5e6f"; // 40 hex, like a commit

describe("parseEnvSecrets", () => {
	test("takes secret-named values only, of a useful length", () => {
		const env = [
			`GITEA_TOKEN=${GITEA}`,
			"GITEA_API_URL=https://git.example.com",
			'GMAIL_APP_PASSWORD="abcd efgh ijkl mnop"',
			"GMAIL_USER=someone@example.com",
			`FIREWORKS_API_KEY='fw_${r(24, "x")}'`,
			"SHORT_TOKEN=abc",
			`export TRUENAS_API_KEY=${r(30, "k")}`,
			`# COMMENTED_TOKEN=${r(30, "z")}`,
			"PWD=/home/someone/repos",
		].join("\n");
		expect(parseEnvSecrets(env).map((s) => s.name)).toEqual([
			"GITEA_TOKEN",
			"GMAIL_APP_PASSWORD",
			"FIREWORKS_API_KEY",
			"TRUENAS_API_KEY",
		]);
	});
});

describe("maskSecrets: known values", () => {
	const known = [{ name: "GITEA_TOKEN", value: GITEA }];

	test("a known value is masked by name, wherever it appears", () => {
		const out = maskSecrets(`url = https://svc:${GITEA}@git.example.com/x.git\ntoken ${GITEA}`, known);
		expect(out.text).not.toContain(GITEA);
		expect(out.text).toContain("[MASKED:GITEA_TOKEN]");
		expect(out.hits).toContainEqual({ kind: "known", label: "GITEA_TOKEN" });
	});

	test("a git commit hash is left alone, even though it has the same shape", () => {
		const out = maskSecrets(`commit ${SHA}\nMerge: ${SHA.slice(0, 7)}`, known);
		expect(out.text).toContain(SHA);
		expect(out.hits).toEqual([]);
	});
});

describe("maskSecrets: shapes", () => {
	const cases: [string, string, string][] = [
		["url-credential", "https://svc-portainer:secretvalue123@git.example.com/repo.git", "secretvalue123"],
		["auth-header", 'curl -H "Authorization: token tok3nvalu3xyz" https://x', "tok3nvalu3xyz"],
		["bearer-token", `Bearer ${r(30, "b")}`, r(30, "b")],
		["jwt", `eyJ${r(12, "h")}.eyJ${r(12, "p")}.${r(20, "s")}`, r(20, "s")],
		["anthropic-key", `sk-ant-${r(30, "q")}`, r(30, "q")],
		["openai-key", `sk-proj-${r(40, "o")}`, r(40, "o")],
		["github-token", `ghp_${r(36, "g")}`, r(36, "g")],
		["gitlab-token", `glpat-${r(20, "l")}`, r(20, "l")],
		["slack-token", `xoxb-${r(24, "1")}`, r(24, "1")],
		["aws-access-key", `AKIA${r(16, "Q")}`, r(16, "Q")],
		["fireworks-key", `fw_${r(24, "f")}`, r(24, "f")],
		["assignment", `POSTGRES_PASSWORD=${r(12, "p")}`, r(12, "p")],
		["assignment", `  - GITEA_TOKEN: "${r(16, "t")}"`, r(16, "t")],
		["assignment", `"api_key": "${r(16, "k")}"`, r(16, "k")],
		// A run of x's inside a value is not a placeholder: the smoke tests' fake secret (#370).
		["url-credential", `https://svc-smoke:smokesecret${r(10, "x")}@git.example.com/x.git`, `smokesecret${r(10, "x")}`],
	];
	for (const [kind, input, secret] of cases) {
		test(`${kind}: ${input.slice(0, 40)}`, () => {
			const out = maskSecrets(input, []);
			expect(out.text).not.toContain(secret);
			expect(out.text).toContain(`[MASKED:${kind}]`);
			expect(out.hits.map((h) => h.kind)).toContain(kind);
		});
	}

	test("a private key keeps its header and footer, loses its body", () => {
		const body = r(64, "M");
		const out = maskSecrets(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`, []);
		expect(out.text).not.toContain(body);
		expect(out.text).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
		expect(out.text).toContain("[MASKED:private-key]");
	});

	test("the user name in a URL credential stays, so the model knows which account", () => {
		expect(maskSecrets("https://svc-portainer:secretvalue123@host/x", []).text).toBe(
			"https://svc-portainer:[MASKED:url-credential]@host/x"
		);
	});
});

describe("maskSecrets: what must not be masked", () => {
	const untouched = [
		"const token = process.env.GITEA_TOKEN;",
		"GITEA_TOKEN=$(sed -n 's/^GITEA_TOKEN=//p' .env)",
		"export interface Auth { token: string; password: boolean }",
		"https://git.example.com/owner/repo.git",
		"ssh://git@github.com/owner/repo.git",
		`git log --oneline ${SHA}`,
		"PASSWORD=short",
		"/home/someone/.opencode/.env",
		"Authorization: Bearer $TOKEN",
		// Documentation placeholders (#370): skills and .env.example files are full of them.
		"ANTHROPIC_API_KEY=your_api_key_here",
		"OPENAI_API_KEY=sk-proj-your-key-here",
		"GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx",
		"APIFY_TOKEN=apify_api_xxxxx",
		"PERPLEXITY_API_KEY=pplx-...",
		"SHODAN_API_KEY=[YOUR_SHODAN_API_KEY]",
		"JWT_SECRET=ChangeThisToARandomString",
		"Authorization: Bearer YOUR_AUTH_TOKEN",
		"GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,",
		"https://svc:your-token@git.example.com/x.git",
	];
	for (const text of untouched) {
		test(text.slice(0, 50), () => {
			const out = maskSecrets(text, []);
			expect(out.text).toBe(text);
			expect(out.hits).toEqual([]);
		});
	}

	test("already masked text is not masked again", () => {
		const once = maskSecrets("https://u:secretvalue123@h/x", []).text;
		expect(maskSecrets(once, []).text).toBe(once);
	});
});

describe("maskDeep", () => {
	test("masks strings inside a tool result object and keeps the shape", () => {
		const result = { output: { exit: 0, output: "https://u:secretvalue123@h/x\n" }, content: [{ type: "text", text: "https://u:secretvalue123@h/x\n" }] };
		const out = maskDeep(result, []);
		expect(JSON.stringify(out.value)).not.toContain("secretvalue123");
		expect((out.value as typeof result).output.exit).toBe(0);
		expect(out.hits).toEqual([{ kind: "url-credential", label: "url-credential" }]);
	});

	test("returns the same reference when there is nothing to mask", () => {
		const result = { content: [{ type: "text", text: "nothing secret here" }] };
		expect(maskDeep(result, []).value).toBe(result);
	});
});

describe("knownSecrets reads <PAI home>/.env and the environment", () => {
	const home = process.env.PAI_HOME as string;
	const env = join(home, ".env");
	beforeAll(() => {
		mkdirSync(home, { recursive: true });
		writeFileSync(env, `GITEA_TOKEN=${GITEA}\nGITEA_API_URL=https://git.example.com\n`);
	});
	afterAll(() => rmSync(env, { force: true }));

	test("the file's secret values, and secret-named environment values, longest first", () => {
		const k = knownSecrets({ CLAUDE_CODE_OAUTH_TOKEN: r(50, "c"), PWD: "/home/someone/repos/project", HOME: "/home/someone" });
		expect(k.map((s) => s.name)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "GITEA_TOKEN"]);
	});

	test("forStorage masks with the real known values", () => {
		expect(forStorage(`token is ${GITEA}`)).toBe("token is [MASKED:GITEA_TOKEN]");
	});
});

test("the notice names what was masked and never a value", () => {
	const n = maskNotice([{ kind: "known", label: "GITEA_TOKEN" }, { kind: "url-credential", label: "url-credential" }]);
	expect(n).toContain("GITEA_TOKEN, url-credential");
	expect(n).toContain("Do not try to reveal");
});
