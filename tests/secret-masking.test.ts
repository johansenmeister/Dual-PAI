/**
 * Claude Code: the hook binary masks secrets in PostToolUse output (#367).
 *
 * Runs the real `pai-hook.ts` as Claude Code does, one process per event,
 * with a fake `.env` in a temporary PAI home. Read goes through the shortcut
 * that skips the core, Bash through the core; both must come back masked.
 * The audit log and the debug log must name what was masked, never the value.
 *
 * @module tests/secret-masking
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "pai-secret-masking-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const KNOWN = `${"4".repeat(20)}${"e".repeat(20)}`;
const URL_SECRET = `secret${"u".repeat(12)}`;

function runHook(name: string, payload: Record<string, unknown>) {
	const paiHome = join(tmp, name);
	mkdirSync(join(paiHome, "MEMORY", "STATE"), { recursive: true });
	writeFileSync(join(paiHome, ".env"), `GITEA_TOKEN=${KNOWN}\n`);
	const log = join(tmp, `${name}.log`);
	const r = Bun.spawnSync([process.execPath, join(ROOT, "claude-plugin", "bin", "pai-hook.ts")], {
		stdin: new TextEncoder().encode(JSON.stringify({ session_id: `mask-${name}`, cwd: tmp, ...payload })),
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: process.env.HOME ?? tmp,
			PAI_ENABLED: "1",
			PAI_HARNESS: "claude",
			PAI_HOME: paiHome,
			PAI_LOG_PATH: log,
			CLAUDE_PLUGIN_ROOT: join(ROOT, "claude-plugin"),
		},
	});
	const audit = join(paiHome, "MEMORY", "STATE", "security-audit.jsonl");
	return {
		answer: JSON.parse(r.stdout.toString() || "{}"),
		audit: existsSync(audit) ? readFileSync(audit, "utf-8") : "",
		log: existsSync(log) ? readFileSync(log, "utf-8") : "",
	};
}

describe("PostToolUse output is masked for every tool", () => {
	test("Read (the shortcut that skips the core): URL credential and known value", () => {
		const content = `[remote "origin"]\n\turl = https://svc:${URL_SECRET}@git.example.com/x.git\ntoken = ${KNOWN}\n`;
		const { answer, audit, log } = runHook("read", {
			hook_event_name: "PostToolUse",
			tool_name: "Read",
			tool_input: { file_path: "/repo/.git/config" },
			tool_response: { type: "text", file: { filePath: "/repo/.git/config", content } },
		});
		const out = answer.hookSpecificOutput;
		expect(out.hookEventName).toBe("PostToolUse");
		const masked = JSON.stringify(out.updatedToolOutput);
		expect(masked).not.toContain(URL_SECRET);
		expect(masked).not.toContain(KNOWN);
		expect(masked).toContain("[MASKED:url-credential]");
		expect(masked).toContain("[MASKED:GITEA_TOKEN]");
		expect(out.additionalContext).toContain("GITEA_TOKEN");
		const entry = JSON.parse(audit.trim().split("\n").at(-1) as string);
		expect(entry).toMatchObject({ tool: "Read", action: "masked", harness: "claude" });
		expect(entry.masked).toEqual(["GITEA_TOKEN", "url-credential"]);
		expect(audit).not.toContain(KNOWN);
		expect(audit).not.toContain(URL_SECRET);
		expect(log).not.toContain(KNOWN);
	});

	test("Bash (through the core): stdout masked", () => {
		const { answer } = runHook("bash", {
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "grep -n svc .git/config" },
			tool_response: { stdout: `2:\turl = https://svc:${URL_SECRET}@git.example.com/x.git`, stderr: "", interrupted: false },
		});
		expect(answer.hookSpecificOutput.updatedToolOutput.stdout).toBe("2:\turl = https://svc:[MASKED:url-credential]@git.example.com/x.git");
		expect(answer.hookSpecificOutput.updatedToolOutput.interrupted).toBe(false);
	});

	test("clean output: no hookSpecificOutput, nothing in the audit log", () => {
		const { answer, audit } = runHook("clean", {
			hook_event_name: "PostToolUse",
			tool_name: "Read",
			tool_input: { file_path: "/repo/README.md" },
			tool_response: { type: "text", file: { filePath: "/repo/README.md", content: "# Hello\n" } },
		});
		expect(answer.hookSpecificOutput).toBeUndefined();
		expect(audit).not.toContain("masked");
	});
});

describe("PAI's own files never store a secret (#367)", () => {
	const saved: Record<string, string | undefined> = {};
	let home = "";

	function filesUnder(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
			const p = join(dir, d.name);
			return d.isDirectory() ? filesUnder(p) : [p];
		});
	}

	test("a prompt, a reply, a subagent answer and a tool call with a secret leave no trace of it", async () => {
		home = join(tmp, "writers");
		mkdirSync(join(home, "MEMORY", "STATE"), { recursive: true });
		writeFileSync(join(home, ".env"), `GITEA_TOKEN=${KNOWN}\n`);
		for (const k of ["PAI_HOME", "PAI_LOG_PATH"]) saved[k] = process.env[k];
		process.env.PAI_HOME = home;
		process.env.PAI_LOG_PATH = join(home, "debug.log");
		try {
			const { dispatch } = await import("../.opencode/pai-core");
			const base = { harness: "claude" as const, sessionId: "w-1", sessionKey: "cc_w-1", at: Date.now(), cwd: home };
			const leak = `the token is ${KNOWN} and the remote is https://svc:${URL_SECRET}@git.example.com/x.git`;
			await dispatch({ ...base, type: "user.message", text: `Please set up the remote. ${leak}` });
			await dispatch({ ...base, type: "tool.after", tool: "Bash", args: { command: `git remote add origin https://svc:${URL_SECRET}@h/x.git` }, result: leak });
			await dispatch({ ...base, type: "agent.stop", agentId: "a-1", agentType: "Engineer", output: `Done. ${leak}` });
			await dispatch({ ...base, type: "assistant.message", text: `I configured it. ${leak} ${"padding ".repeat(20)}` });

			const files = [...filesUnder(join(home, "MEMORY")), join(home, "debug.log")].filter((f) => existsSync(f));
			expect(files.length).toBeGreaterThan(1);
			const leaks = files.filter((f) => {
				const text = readFileSync(f, "utf-8");
				return text.includes(KNOWN) || text.includes(URL_SECRET);
			});
			expect(leaks).toEqual([]);
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});
});
