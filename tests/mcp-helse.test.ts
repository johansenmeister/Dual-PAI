/**
 * K26 og K32 i `pai doctor`: MCP-paritet mellom motorene, og lokale servere som
 * dør ved oppstart. Serverne her er små skript i en temp-katalog.
 *
 * #375: the declared health call, over stdio against a fake MCP server script
 * and over streamable HTTP against a fake `Bun.serve` server.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claudeDefinisjoner,
	claudeServere,
	feillinje,
	type Helsekall,
	helsekall,
	lesHelsekall,
	MCP_HELSE_FIL,
	mcpHelse,
	mcpParitet,
	merketSkrivende,
	opencodeServere,
	prøvOppstart,
	utvidClaudeEnv,
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
		expect(h.varsler).toEqual([
			"MCP server egen exists only in Claude (not in opencode.json)",
			`no health call in ${MCP_HELSE_FIL}, so doctor cannot see whether the backend answers: doende, egen, fjern, frisk, medEnv`,
		]);
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

// A fake stdio MCP server. MODUS picks the behaviour; MARKOR, when set, gets the
// tools/call params written to it, so a test can prove a call was or was not made.
// tools/list is paged: the declared tool `les` is on the second page.
const MCP = skript(
	"mcp.ts",
	`const modus = process.env.MODUS ?? "frisk";
const verktøy = [
	{ name: "les", inputSchema: { type: "object" }, annotations: { readOnlyHint: modus !== "skrivende" } },
	{ name: "annet", inputSchema: { type: "object" } },
];
if (modus === "logg") console.log("starter, ikke JSON-RPC");
let rest = "";
const svar = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
for await (const bit of Bun.stdin.stream()) {
	rest += new TextDecoder().decode(bit);
	let i = rest.indexOf("\\n");
	while (i >= 0) {
		const m = JSON.parse(rest.slice(0, i));
		rest = rest.slice(i + 1);
		i = rest.indexOf("\\n");
		if (m.id === undefined) continue;
		if (m.method === "initialize") svar(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "falsk", version: "1" } });
		else if (m.method === "tools/list") svar(m.id, m.params?.cursor ? { tools: verktøy } : { tools: [{ name: "side1", inputSchema: { type: "object" } }], nextCursor: "2" });
		else if (m.method === "tools/call") {
			if (process.env.MARKOR) await Bun.write(process.env.MARKOR, JSON.stringify(m.params));
			if (modus === "heng") continue;
			if (modus === "nede") svar(m.id, { isError: true, content: [{ type: "text", text: "Error: connect ECONNREFUSED 10.0.0.1:9000" }] });
			else svar(m.id, { content: [{ type: "text", text: "ok" }] });
		}
	}
}`
);

const LES: Helsekall = { verktøy: "les", argumenter: { limit: 1 }, tidsavbrudd: 5_000 };

function stdio(modus: string, markør?: string) {
	return {
		navn: modus,
		type: "local",
		kommando: [process.execPath, MCP],
		miljø: { MODUS: modus, ...(markør ? { MARKOR: markør } : {}) },
	};
}

describe("#375: MCP-HELSE.json", () => {
	test("no file: no calls and no errors", () => {
		expect(lesHelsekall(join(tmp, "uten-fil"))).toEqual({ kall: new Map(), feil: [] });
	});

	test("a call, false, a default timeout in ms, and an entry without a tool is an error", () => {
		const dir = join(tmp, "helsefil", ".opencode");
		mkdirSync(join(dir, "PAI", "USER"), { recursive: true });
		writeFileSync(
			join(dir, MCP_HELSE_FIL),
			JSON.stringify({
				a: { kall: "les", argumenter: { x: 1 }, tidsavbrudd: 2 },
				b: { kall: "les" },
				c: false,
				d: { argumenter: {} },
				e: { kall: "les", argumenter: [1] },
			})
		);
		const h = lesHelsekall(dir);
		expect(h.kall.get("a")).toEqual({ verktøy: "les", argumenter: { x: 1 }, tidsavbrudd: 2_000 });
		expect(h.kall.get("b")).toEqual({ verktøy: "les", argumenter: {}, tidsavbrudd: 10_000 });
		expect(h.kall.get("c")).toBe(false);
		expect([...h.kall.keys()]).toEqual(["a", "b", "c"]);
		expect(h.feil).toHaveLength(2);
		expect(h.feil[0]).toContain("d needs “kall”");
	});

	test("a file that is not a JSON object is an error, not silence", () => {
		const dir = join(tmp, "helsefil-odelagt", ".opencode");
		mkdirSync(join(dir, "PAI", "USER"), { recursive: true });
		writeFileSync(join(dir, MCP_HELSE_FIL), "[]");
		expect(lesHelsekall(dir).feil).toEqual([`could not read ${MCP_HELSE_FIL} as a JSON object`]);
	});
});

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: ${…} here is Claude's config syntax, not a template
describe("#375: Claude's server definitions", () => {
	test("stdio with args and env, http with headers, ${VAR} and ${VAR:-default}; a later scope wins", () => {
		const env = { HOME: "/h", TOKEN: "t" };
		const d = claudeDefinisjoner(
			{
				mcpServers: {
					portainer: { type: "stdio", command: "uvx", args: ["--from", "${HOME}/x"], env: { A: "${MANGLER:-std}" } },
					delt: { command: "user" },
				},
				projects: { "/repo": { mcpServers: { delt: { command: "lokal" } } } },
			},
			["/repo"],
			[{ mcpServers: { fjern: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer ${TOKEN}" } } } }],
			env
		);
		expect(d.get("portainer")).toMatchObject({ type: "stdio", kommando: ["uvx", "--from", "/h/x"], miljø: { A: "std" } });
		expect(d.get("delt")?.kommando).toEqual(["lokal"]);
		expect(d.get("fjern")).toMatchObject({ type: "http", url: "https://x/mcp", headere: { Authorization: "Bearer t" } });
		expect(utvidClaudeEnv("${TOM:-x}${TOKEN}", { TOM: "", TOKEN: "t" })).toBe("xt");
	});

	test("a server marked as writing is refused; an unmarked one is trusted to the declaration", () => {
		expect(merketSkrivende({ name: "a", annotations: { readOnlyHint: true } })).toBe(false);
		expect(merketSkrivende({ name: "a" })).toBe(false);
		expect(merketSkrivende({ name: "a", annotations: { readOnlyHint: false } })).toBe(true);
		expect(merketSkrivende({ name: "a", annotations: { destructiveHint: true } })).toBe(true);
		expect(merketSkrivende({ name: "a", annotations: { readOnlyHint: true, destructiveHint: true } })).toBe(false);
	});
});

// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of the block above

describe("#375: the health call over stdio", () => {
	test("healthy: the call is made with the declared arguments, past a paged tools/list", async () => {
		const markør = join(tmp, "frisk.json");
		expect(await helsekall(stdio("frisk", markør), LES, tmp)).toBeNull();
		expect(JSON.parse(await Bun.file(markør).text())).toEqual({ name: "les", arguments: { limit: 1 } });
	});

	test("a backend that is gone: the server answers with isError, and doctor says so", async () => {
		expect(await helsekall(stdio("nede"), LES, tmp)).toBe("answered les with an error: Error: connect ECONNREFUSED 10.0.0.1:9000");
	});

	test("no answer: the timeout, and the process is killed", async () => {
		const t = Date.now();
		expect(await helsekall(stdio("heng"), { ...LES, tidsavbrudd: 500 }, tmp)).toBe("did not answer les within 0.5 s");
		expect(Date.now() - t).toBeLessThan(3_000);
	});

	test("a tool the server marks as writing is never called", async () => {
		const markør = join(tmp, "skrivende.json");
		expect(await helsekall(stdio("skrivende", markør), LES, tmp)).toContain("marks les as writing");
		expect(await Bun.file(markør).exists()).toBe(false);
	});

	test("a tool the server does not have", async () => {
		expect(await helsekall(stdio("frisk"), { ...LES, verktøy: "finnes_ikke" }, tmp)).toBe(
			`does not have the tool finnes_ikke from ${MCP_HELSE_FIL}`
		);
	});

	test("a server that dies at startup, and a command that does not exist", async () => {
		expect(await helsekall({ navn: "d", type: "local", kommando: [process.execPath, DØR] }, LES, tmp)).toBe(
			"health call failed: the server exited (exit 1): Error: API_URL is not set"
		);
		expect(await helsekall({ navn: "x", type: "local", kommando: ["pai-finnes-ikke-xyz"] }, LES, tmp)).toStartWith(
			"health call failed: "
		);
	});

	test("a line on stdout that is not JSON-RPC is skipped", async () => {
		expect(await helsekall(stdio("logg"), LES, tmp)).toBeNull();
	});
});

/** Streamable HTTP: a session id from initialize, required after it; JSON or SSE answers. */
function httpServer(opt: { sse: boolean; nede?: boolean; token?: string }) {
	const kall: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (opt.token && req.headers.get("authorization") !== `Bearer ${opt.token}`) return new Response("unauthorized", { status: 401 });
			if (req.method === "DELETE") return new Response(null, { status: 200 });
			const m = (await req.json()) as { id?: number; method: string; params?: { cursor?: string } };
			kall.push(m.method);
			if (m.method !== "initialize" && req.headers.get("mcp-session-id") !== "s1") return new Response("no session", { status: 400 });
			if (m.id === undefined) return new Response(null, { status: 202 });
			let result: unknown;
			if (m.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "h", version: "1" } };
			else if (m.method === "tools/list") result = { tools: [{ name: "les", inputSchema: { type: "object" } }] };
			else result = opt.nede ? { isError: true, content: [{ type: "text", text: "502 Bad Gateway" }] } : { content: [] };
			const svar = JSON.stringify({ jsonrpc: "2.0", id: m.id, result });
			const headers = { "mcp-session-id": "s1" };
			if (!opt.sse) return Response.json(JSON.parse(svar), { headers });
			// The stream stays open after the answer, as a server may keep it.
			const strøm = new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode(`event: message\r\ndata: ${svar}\r\n\r\n`));
				},
			});
			return new Response(strøm, { headers: { ...headers, "content-type": "text/event-stream" } });
		},
	});
	return { url: `http://localhost:${server.port}/mcp`, kall, stopp: () => server.stop(true) };
}

describe("#375: the health call over streamable HTTP", () => {
	test("JSON answers, with the session id carried", async () => {
		const h = httpServer({ sse: false });
		try {
			expect(await helsekall({ navn: "h", type: "remote", url: h.url }, LES, tmp)).toBeNull();
			expect(h.kall).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
		} finally {
			h.stopp();
		}
	});

	test("an SSE answer on a stream that stays open", async () => {
		const h = httpServer({ sse: true });
		try {
			expect(await helsekall({ navn: "h", type: "http", url: h.url }, LES, tmp)).toBeNull();
		} finally {
			h.stopp();
		}
	});

	test("headers are sent; without them the server's 401 is the answer", async () => {
		const h = httpServer({ sse: false, token: "t" });
		try {
			expect(await helsekall({ navn: "h", type: "http", url: h.url, headere: { Authorization: "Bearer t" } }, LES, tmp)).toBeNull();
			expect(await helsekall({ navn: "h", type: "http", url: h.url }, LES, tmp)).toBe("health call failed: HTTP 401: unauthorized");
		} finally {
			h.stopp();
		}
	});

	test("a backend that is gone behind a live MCP server", async () => {
		const h = httpServer({ sse: true, nede: true });
		try {
			expect(await helsekall({ navn: "h", type: "remote", url: h.url }, LES, tmp)).toBe("answered les with an error: 502 Bad Gateway");
		} finally {
			h.stopp();
		}
	});
});

describe("#375: mcpHelse with MCP-HELSE.json", () => {
	test("declared calls in both engines, a deliberate false, a stale entry and an undeclared server", async () => {
		const dir = join(tmp, "helse-repo", ".opencode");
		mkdirSync(join(dir, "PAI", "USER"), { recursive: true });
		const lokal = (modus: string) => ({ type: "local", command: [process.execPath, MCP], environment: { MODUS: modus } });
		writeFileSync(join(dir, "opencode.json"), JSON.stringify({ mcp: { frisk: lokal("frisk"), nede: lokal("nede"), bevisst: lokal("frisk") } }));
		const claudeJson = join(tmp, "helse-claude.json");
		const def = (modus: string) => ({ type: "stdio", command: process.execPath, args: [MCP], env: { MODUS: modus } });
		writeFileSync(
			claudeJson,
			JSON.stringify({ mcpServers: { frisk: {}, nede: {}, bevisst: {}, portainer: def("nede"), glemt: def("frisk"), pai: {} } })
		);
		writeFileSync(
			join(dir, MCP_HELSE_FIL),
			JSON.stringify({
				frisk: { kall: "les" },
				nede: { kall: "les" },
				portainer: { kall: "les" },
				bevisst: false,
				borte: { kall: "les" },
			})
		);
		const h = await mcpHelse(dir, claudeJson);
		expect(h.problemer.sort()).toEqual([
			"MCP server nede answered les with an error: Error: connect ECONNREFUSED 10.0.0.1:9000",
			"MCP server portainer answered les with an error: Error: connect ECONNREFUSED 10.0.0.1:9000",
		]);
		expect(h.varsler).toEqual([
			"MCP server glemt exists only in Claude (not in opencode.json)",
			"MCP server portainer exists only in Claude (not in opencode.json)",
			`${MCP_HELSE_FIL} has a health call for borte, but neither engine has the server`,
			`no health call in ${MCP_HELSE_FIL}, so doctor cannot see whether the backend answers: glemt`,
		]);
	});
});
