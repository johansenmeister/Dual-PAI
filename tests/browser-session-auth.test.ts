/**
 * BrowserSession: loopback, token og tilstandsfil (#356)
 *
 * Browser-skillens BrowserSession styrer agentens nettleser over HTTP og lever
 * opptil 30 minutter etter økta. Den lyttet på alle grensesnitt uten
 * autentisering, med `Access-Control-Allow-Origin: *`. Testen holder fast at
 * forespørsler uten tokenet og forespørsler fra en nettside avvises, at
 * tilstandsfila med tokenet bare kan leses av brukeren og ikke følger en lenke,
 * og at serveren binder loopback og klienten snakker til samme adresse.
 *
 * Serveren selv startes ikke her: den trenger Playwright og en nettleser.
 *
 * @module tests/browser-session-auth
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSER = join(import.meta.dir, "..", ".opencode", "skills", "Utilities", "Browser");
const AUTH = join(BROWSER, "Tools", "session-auth.ts");

describe.skipIf(!existsSync(AUTH))("BrowserSession: tilgang (#356)", async () => {
	const { HOSTNAME, authHeaders, newToken, readState, reject, removeState, stateFile, writeState } = await import(AUTH);
	const token = newToken();
	const req = (headers: Record<string, string>) => new Request(`http://${HOSTNAME}:9222/health`, { headers });

	test("uten token, med feil token eller tomt token: 401", () => {
		expect(reject(req({}), token)?.status).toBe(401);
		expect(reject(req(authHeaders(newToken())), token)?.status).toBe(401);
		expect(reject(req(authHeaders("")), "")?.status).toBe(401);
	});

	test("riktig token slipper gjennom", () => {
		expect(reject(req(authHeaders(token)), token)).toBeNull();
	});

	test("en forespørsel fra en nettside (Origin) avvises, også med riktig token", () => {
		expect(reject(req({ ...authHeaders(token), Origin: "https://example.com" }), token)?.status).toBe(403);
	});

	test("loopback, og tokenet er langt og ulikt hver gang", () => {
		expect(HOSTNAME).toBe("127.0.0.1");
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(newToken()).not.toBe(token);
	});

	test("tilstandsfila er per bruker, ikke det gamle felles navnet i /tmp", () => {
		expect(stateFile()).not.toBe("/tmp/browser-session.json");
		if (typeof process.getuid === "function") expect(stateFile()).toContain(`-${process.getuid()}.json`);
	});

	const dir = mkdtempSync(join(tmpdir(), "pai-browser-auth-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const state = { pid: 1, port: 9222, token, sessionId: "abc", startedAt: "", headless: true, url: "" };

	test("tilstanden skrives med modus 0600 og leses tilbake", () => {
		const fil = join(dir, "state.json");
		writeFileSync(fil, "gammel", { mode: 0o644 });
		writeState(state, fil);
		expect(statSync(fil).mode & 0o777).toBe(0o600);
		expect(readState(fil)?.token).toBe(token);
		removeState(fil);
		expect(existsSync(fil)).toBe(false);
	});

	test("en lenke på stedet for tilstandsfila følges ikke", () => {
		const mål = join(dir, "mål.txt");
		const lenke = join(dir, "lenke.json");
		writeFileSync(mål, "uendret");
		symlinkSync(mål, lenke);
		expect(() => writeState(state, lenke)).toThrow();
		expect(readFileSync(mål, "utf-8")).toBe("uendret");
	});
});

describe.skipIf(!existsSync(AUTH))("BrowserSession og Browse.ts bruker tilgangen (#356)", () => {
	const server = readFileSync(join(BROWSER, "Tools", "BrowserSession.ts"), "utf-8");
	const klient = readFileSync(join(BROWSER, "Tools", "Browse.ts"), "utf-8");

	test("serveren binder loopback og avviser før den gjør noe annet", () => {
		expect(server).toMatch(/Bun\.serve\(\{\s*hostname: HOSTNAME,/);
		expect(server).toMatch(/async fetch\(req\) \{\s*const denied = reject\(req, CONFIG\.token\)/);
		expect(server).not.toContain("Access-Control-Allow-Origin");
	});

	test("klienten snakker til loopback-adressen, ikke localhost (som kan bli ::1)", () => {
		expect(klient).not.toMatch(/http:\/\/localhost:\$\{(state\.)?port\}/);
		expect(klient).toMatch(/http:\/\/\$\{HOSTNAME\}:\$\{port\}/);
	});
});
