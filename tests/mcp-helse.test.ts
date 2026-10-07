/**
 * K26 og K32 i `pai doctor`: MCP-paritet mellom motorene, og lokale servere som
 * dør ved oppstart. Serverne her er små skript i en temp-katalog.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claudeServere,
	feillinje,
	mcpHelse,
	mcpParitet,
	opencodeServere,
	prøvOppstart,
	utvidEnv,
} from "../.opencode/PAI/Tools/mcp-helse";

const tmp = mkdtempSync(join(tmpdir(), "pai-mcp-helse-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function skript(navn: string, kropp: string): string {
	const sti = join(tmp, navn);
	writeFileSync(sti, kropp);
	return sti;
}

const DØR = skript("dor.ts", 'console.error("   1 | const x = 1;"); console.error("Error: API_URL is not set"); process.exit(1);');
const EOF = skript("eof.ts", "for await (const _ of Bun.stdin.stream()) {} process.exit(0);");
const LEVER = skript("lever.ts", "setInterval(() => {}, 1000);");

describe("K26: hvilke servere hver motor har", () => {
	test("opencode.json: bare de påslåtte, med kommando og miljø", () => {
		const s = opencodeServere({
			mcp: {
				bookstack: { type: "remote", url: "https://x/mcp", enabled: true },
				av: { type: "local", command: ["x"], enabled: false },
				pureservice: { type: "local", command: ["bun", "run", "s.ts"], environment: { A: "1" } },
			},
		});
		expect(s.map((x) => x.navn)).toEqual(["bookstack", "pureservice"]);
		expect(s[1].kommando).toEqual(["bun", "run", "s.ts"]);
		expect(s[1].miljø).toEqual({ A: "1" });
		expect(opencodeServere(null)).toEqual([]);
	});

	test("{env:NAVN} byttes ut som i v2: midt i en streng, flere ganger, usatt blir tom", () => {
		const env = { HOME: "/h", DIR: "/d" };
		expect(utvidEnv("--env-file={env:HOME}/.opencode/.env", env)).toBe("--env-file=/h/.opencode/.env");
		expect(utvidEnv("{env:HOME}{env:HOME}", env)).toBe("/h/h");
		expect(utvidEnv("a{env:FINNES_IKKE}b", env)).toBe("ab");
		expect(utvidEnv("uten", env)).toBe("uten");
		const [s] = opencodeServere(
			{ mcp: { p: { type: "local", command: ["bun", "{env:DIR}/s.ts"], environment: { E: "{env:HOME}/x" } } } },
			env
		);
		expect(s.kommando).toEqual(["bun", "/d/s.ts"]);
		expect(s.miljø).toEqual({ E: "/h/x" });
	});

	test("Claude: user-scope, local-scope for repoets stier, og .mcp.json", () => {
		const claudeJson = {
			mcpServers: { portainer: {} },
			projects: { "/repo/.opencode": { mcpServers: { lokal: {} } }, "/annet": { mcpServers: { fremmed: {} } } },
		};
		expect(claudeServere(claudeJson, ["/repo/.opencode", "/repo"], [{ mcpServers: { prosjekt: {} } }, null])).toEqual([
			"lokal",
			"portainer",
			"prosjekt",
		]);
	});

	test("pai er PAIs egen og telles ikke; begge retningene", () => {
		const p = mcpParitet(["bookstack", "pureservice"], ["pai", "pureservice", "portainer"]);
		expect(p).toEqual({ bareOpencode: ["bookstack"], bareClaude: ["portainer"] });
		expect(mcpParitet(["pai"], [])).toEqual({ bareOpencode: [], bareClaude: [] });
	});
});

describe("K32: oppstarten", () => {
	test("en server som dør med feil, er død, med stderr", async () => {
		const u = await prøvOppstart({ navn: "d", type: "local", kommando: [process.execPath, DØR] }, tmp);
		expect(u.død).toBe(true);
		expect(u.kode).toBe(1);
		expect(feillinje(u.stderr)).toBe("Error: API_URL is not set");
	});

	test("with FORCE_COLOR set, the error line has no colour codes (#328)", async () => {
		const before = process.env.FORCE_COLOR;
		process.env.FORCE_COLOR = "3";
		try {
			const u = await prøvOppstart({ navn: "d", type: "local", kommando: [process.execPath, DØR] }, tmp);
			expect(feillinje(u.stderr)).toBe("Error: API_URL is not set");
		} finally {
			if (before === undefined) delete process.env.FORCE_COLOR;
			else process.env.FORCE_COLOR = before;
		}
	});

	test("feillinje strips colour codes in the middle of the line too (#328)", () => {
		const esc = String.fromCharCode(27);
		expect(feillinje(`${esc}[31m${esc}[1mError${esc}[0m: API_URL is not set${esc}[0m`)).toBe("Error: API_URL is not set");
	});

	test("EOF på stdin og exit 0 er friskt", async () => {
		const u = await prøvOppstart({ navn: "e", type: "local", kommando: [process.execPath, EOF] }, tmp);
		expect(u).toMatchObject({ død: false, kode: 0 });
	});

	test("en server som lever etter vinduet, er frisk, og blir drept", async () => {
		const t = Date.now();
		const u = await prøvOppstart({ navn: "l", type: "local", kommando: [process.execPath, LEVER] }, tmp, 300);
		expect(u.død).toBe(false);
		expect(Date.now() - t).toBeLessThan(3_000);
	});

	test("en kommando som ikke finnes, er død", async () => {
		const u = await prøvOppstart({ navn: "x", type: "local", kommando: ["pai-finnes-ikke-xyz"] }, tmp);
		expect(u.død).toBe(true);
	});

	test("feillinja: bun-stacktrace, vanlig tekst, tom", () => {
		// MÅLT 2026-09-27: jobbens pureservice uten PURESERVICE_API_URL. Kildelinjene
		// over feilen nevner selv «Error», så feillinja må finnes på formen, ikke på ordet.
		const bun = [
			"81 |   private readonly writeKey: string;",
			"84 |   constructor(config: ClientConfig) {",
			"85 |     if (!config.baseUrl) {",
			"86 |       throw new PureserviceError(",
			"                 ^",
			"PureserviceError: PURESERVICE_API_URL is not set",
			' status: undefined,',
			'   code: "CONFIG_MISSING"',
		].join("\n");
		expect(feillinje(bun)).toBe("PureserviceError: PURESERVICE_API_URL is not set");
		expect(feillinje("kan ikke koble til\n")).toBe("kan ikke koble til");
		expect(feillinje("")).toBe("no stderr");
	});
});

describe("mcpHelse: hele sjekken", () => {
	test("paritet og oppstart er problemer, bare-i-Claude er et varsel", async () => {
		const dir = join(tmp, "repo", ".opencode");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "opencode.json"),
			JSON.stringify({
				mcp: {
					doende: { type: "local", command: [process.execPath, DØR] },
					frisk: { type: "local", command: [process.execPath, EOF] },
					medEnv: { type: "local", command: [process.execPath, "{env:PAI_MCP_HELSE_TMP}/eof.ts"] },
					fjern: { type: "remote", url: "https://x/mcp" },
				},
			})
		);
		const claudeJson = join(tmp, "claude.json");
		writeFileSync(claudeJson, JSON.stringify({ mcpServers: { doende: {}, frisk: {}, medEnv: {}, egen: {} } }));
		process.env.PAI_MCP_HELSE_TMP = tmp;
		const h = await mcpHelse(dir, claudeJson).finally(() => {
			delete process.env.PAI_MCP_HELSE_TMP;
		});
		expect(h.problemer).toHaveLength(2);
		expect(h.problemer.some((p) => p.includes("fjern is in opencode.json"))).toBe(true);
		expect(h.problemer.some((p) => p.includes("doende died at startup (exit 1): Error: API_URL is not set"))).toBe(true);
		expect(h.varsler).toEqual(["MCP server egen exists only in Claude (not in opencode.json)"]);
	});

	test("ingen mcp-blokk og ingen Claude-konfig: taus", async () => {
		const dir = join(tmp, "tom", ".opencode");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "opencode.json"), "{}");
		expect(await mcpHelse(dir, join(tmp, "finnes-ikke.json"))).toEqual({ problemer: [], varsler: [] });
	});

	test("en opencode.json som ikke er JSON, er et problem, ikke stillhet", async () => {
		const dir = join(tmp, "odelagt", ".opencode");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "opencode.json"), "{ ikke json");
		const h = await mcpHelse(dir, join(tmp, "finnes-ikke.json"));
		expect(h.problemer[0]).toContain("could not read");
	});
});
