/**
 * BrowserSession: loopback, token and state file (#356)
 *
 * The Browser skill's BrowserSession drives the assistant's browser over HTTP
 * and lives up to 30 minutes after the session. It listened on every interface
 * without authentication, with `Access-Control-Allow-Origin: *`. This test holds
 * that requests without the token and requests from a web page are refused,
 * that the state file with the token is readable only by the user and does not
 * follow a symlink, and that the server binds loopback and the client talks to
 * the same address.
 *
 * The server itself is not started here: it needs Playwright and a browser.
 *
 * @module tests/browser-session-auth
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSER = join(import.meta.dir, "..", ".opencode", "skills", "Utilities", "Browser");
const AUTH = join(BROWSER, "Tools", "session-auth.ts");

describe.skipIf(!existsSync(AUTH))("BrowserSession: access (#356)", async () => {
	const { HOSTNAME, authHeaders, newToken, readState, reject, removeState, stateFile, writeState } = await import(AUTH);
	const token = newToken();
	const req = (headers: Record<string, string>) => new Request(`http://${HOSTNAME}:9222/health`, { headers });

	test("no token, a wrong token or an empty token: 401", () => {
		expect(reject(req({}), token)?.status).toBe(401);
		expect(reject(req(authHeaders(newToken())), token)?.status).toBe(401);
		expect(reject(req(authHeaders("")), "")?.status).toBe(401);
	});

	test("the right token passes", () => {
		expect(reject(req(authHeaders(token)), token)).toBeNull();
	});

	test("a request from a web page (Origin) is refused, even with the right token", () => {
		expect(reject(req({ ...authHeaders(token), Origin: "https://example.com" }), token)?.status).toBe(403);
	});

	test("loopback, and the token is long and different every time", () => {
		expect(HOSTNAME).toBe("127.0.0.1");
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(newToken()).not.toBe(token);
	});

	test("the state file is per user, not the old shared name in /tmp", () => {
		expect(stateFile()).not.toBe("/tmp/browser-session.json");
		if (typeof process.getuid === "function") expect(stateFile()).toContain(`-${process.getuid()}.json`);
	});

	const dir = mkdtempSync(join(tmpdir(), "pai-browser-auth-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const state = { pid: 1, port: 9222, token, sessionId: "abc", startedAt: "", headless: true, url: "" };

	test("the state is written with mode 0600 and read back", () => {
		const file = join(dir, "state.json");
		writeFileSync(file, "old", { mode: 0o644 });
		writeState(state, file);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readState(file)?.token).toBe(token);
		removeState(file);
		expect(existsSync(file)).toBe(false);
	});

	test("a symlink in place of the state file is not followed", () => {
		const target = join(dir, "target.txt");
		const link = join(dir, "link.json");
		writeFileSync(target, "unchanged");
		symlinkSync(target, link);
		expect(() => writeState(state, link)).toThrow();
		expect(readFileSync(target, "utf-8")).toBe("unchanged");
	});
});

describe.skipIf(!existsSync(AUTH))("BrowserSession and Browse.ts use the access check (#356)", () => {
	const server = readFileSync(join(BROWSER, "Tools", "BrowserSession.ts"), "utf-8");
	const client = readFileSync(join(BROWSER, "Tools", "Browse.ts"), "utf-8");

	test("the server binds loopback and refuses before doing anything else", () => {
		expect(server).toMatch(/Bun\.serve\(\{\s*hostname: HOSTNAME,/);
		expect(server).toMatch(/async fetch\(req\) \{\s*const denied = reject\(req, CONFIG\.token\)/);
		expect(server).not.toContain("Access-Control-Allow-Origin");
	});

	test("the client talks to the loopback address, not localhost (which can be ::1)", () => {
		expect(client).not.toMatch(/http:\/\/localhost:\$\{(state\.)?port\}/);
		expect(client).toMatch(/http:\/\/\$\{HOSTNAME\}:\$\{port\}/);
	});
});
