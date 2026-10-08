/**
 * MCP-serverne i `pai doctor`: K26 og K32
 *
 * K26: en server i `opencode.json` som Claude ikke har, gir ulik atferd i de to
 * motorene uten at noe sier fra. Jobb-fase 3 fant `bookstack` og `pureservice`
 * bare i `opencode.json`. Claude-sidens servere leses fra konfigen, ikke fra
 * `claude mcp list`, som kobler til hver av dem.
 *
 * K32: `pureservice` uten nøkler i `.env` døde ved oppstart, og v2 sa bare
 * «Connection closed». Hver lokal server startes med stdin fra `/dev/null` i
 * 2 s. En server som avslutter med feil i det vinduet, meldes med første
 * stderr-linje. Én som avslutter med 0 (EOF på stdin) eller lever, er i orden.
 * Aldri et verktøykall.
 *
 * v2 bytter ut `{env:NAVN}` i konfigen før den starter serveren, også midt i en
 * streng og flere ganger i samme, og en usatt variabel blir tom (MÅLT
 * 2026-09-29 mot 2.0.18). Oppstarten gjør det samme, ellers ville en kommando
 * som `{env:HOME}/.opencode/…` alltid meldes død her og virke i motoren.
 *
 * Regel 1 i selvtest-rammen: en server som bare finnes i Claude, er et varsel og
 * ikke en feil. Den kan være brukerens egen (`portainer` på en av maskinene).
 *
 * #375: a stdio server is "connected" as soon as its process starts, so neither
 * engine's `mcp list` nor the startup check above notices a backend that is
 * gone (jobb #12: `portainer ✔ Connected` after the Portainer server was
 * removed). `PAI/USER/MCP-HELSE.json` declares one cheap, read-only tool call
 * per server; doctor opens a real MCP session (stdio or streamable HTTP) and
 * makes that call with a timeout. The call is declared, never guessed, and a
 * tool the server itself marks as not read-only is refused without calling it.
 *
 * ```json
 * {
 *   "pureservice": { "kall": "pureservice_list", "argumenter": { "entityType": "status", "limit": 1 } },
 *   "bookstack": { "kall": "search_pages", "argumenter": { "query": "PAI" }, "tidsavbrudd": 15 },
 *   "egen": false
 * }
 * ```
 *
 * `kall` is the server's own tool name, not the one the model sees: v2 prefixes
 * `<server>_` and Claude `mcp__<server>__`.
 *
 * `false` means deliberately without a health call. A configured server with
 * no entry is one warning line; an entry for a server neither engine has is
 * another (a stale declaration). No file, no servers: silent.
 *
 * @module PAI/Tools/mcp-helse
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

export interface McpServer {
	navn: string;
	type: string;
	kommando?: string[];
	miljø?: Record<string, string>;
	/** Remote servers (`remote` in v2, `http` in Claude). */
	url?: string;
	headere?: Record<string, string>;
}

/** PAIs egen server kommer fra pluginen på Claude-siden, og v2 har verktøyene uten MCP. */
export const EGNE_SERVERE: readonly string[] = ["pai"];

const OPPSTART_MS = 2_000;
const HELSEKALL_MS = 10_000;

/** Relative to the PAI tree (`.opencode`), next to `SKRIVEBESKYTTET.json`. */
export const MCP_HELSE_FIL = join("PAI", "USER", "MCP-HELSE.json");

/** `{env:NAVN}` byttet ut med verdien i `env`, som v2 gjør; usatt blir tom. */
export function utvidEnv(tekst: string, env: Record<string, string | undefined> = process.env): string {
	return tekst.replace(/\{env:([^}]+)\}/g, (_, navn: string) => env[navn] ?? "");
}

/** De påslåtte serverne i `mcp`-blokken (v2 leser `enabled` i begge retninger, M-J1). */
export function opencodeServere(konfig: unknown, env: Record<string, string | undefined> = process.env): McpServer[] {
	const mcp = (konfig as { mcp?: Record<string, Record<string, unknown>> } | null)?.mcp ?? {};
	return Object.entries(mcp)
		.filter(([, v]) => v && v.enabled !== false)
		.map(([navn, v]) => ({
			navn,
			type: String(v.type ?? ""),
			kommando: Array.isArray(v.command) ? v.command.map((d) => utvidEnv(String(d), env)) : undefined,
			miljø: strengkart(v.environment, (d) => utvidEnv(d, env)),
			url: typeof v.url === "string" ? utvidEnv(v.url, env) : undefined,
			headere: strengkart(v.headers, (d) => utvidEnv(d, env)),
		}));
}

function strengkart(v: unknown, utvid: (d: string) => string): Record<string, string> | undefined {
	if (!v || typeof v !== "object") return undefined;
	return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, d]) => [k, utvid(String(d))]));
}

/** Claude Code expands `${NAVN}` and `${NAVN:-standard}` in its MCP config. */
export function utvidClaudeEnv(tekst: string, env: Record<string, string | undefined> = process.env): string {
	return tekst.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, navn: string, std?: string) => env[navn] || (std ?? ""));
}

/**
 * Claude's server definitions by name, in the same scopes as `claudeServere`.
 * A later scope wins, as in Claude: user, then local, then project.
 */
export function claudeDefinisjoner(
	claudeJson: unknown,
	prosjektStier: readonly string[],
	prosjektMcp: readonly unknown[],
	env: Record<string, string | undefined> = process.env
): Map<string, McpServer> {
	const d = (claudeJson ?? {}) as {
		mcpServers?: Record<string, unknown>;
		projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
	};
	const kilder = [
		d.mcpServers,
		...prosjektStier.map((s) => d.projects?.[s]?.mcpServers),
		...prosjektMcp.map((f) => (f as { mcpServers?: Record<string, unknown> } | null)?.mcpServers),
	];
	const ut = new Map<string, McpServer>();
	for (const kilde of kilder) {
		for (const [navn, rå] of Object.entries(kilde ?? {})) {
			const v = (rå ?? {}) as Record<string, unknown>;
			const utvid = (x: string) => utvidClaudeEnv(x, env);
			const type = String(v.type ?? (v.url ? "http" : "stdio"));
			ut.set(navn, {
				navn,
				type,
				kommando:
					typeof v.command === "string"
						? [utvid(v.command), ...(Array.isArray(v.args) ? v.args.map((a) => utvid(String(a))) : [])]
						: undefined,
				miljø: strengkart(v.env, utvid),
				url: typeof v.url === "string" ? utvid(v.url) : undefined,
				headere: strengkart(v.headers, utvid),
			});
		}
	}
	return ut;
}

/**
 * Navnene Claude Code har: `user`-scope (`mcpServers` i `.claude.json`),
 * `local`-scope for katalogene økten kan starte i (`projects[<sti>]`), og
 * `project`-scope (`.mcp.json` i de samme katalogene).
 */
export function claudeServere(claudeJson: unknown, prosjektStier: readonly string[], prosjektMcp: readonly unknown[]): string[] {
	const d = (claudeJson ?? {}) as {
		mcpServers?: Record<string, unknown>;
		projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
	};
	const navn = new Set(Object.keys(d.mcpServers ?? {}));
	for (const sti of prosjektStier) for (const n of Object.keys(d.projects?.[sti]?.mcpServers ?? {})) navn.add(n);
	for (const fil of prosjektMcp) {
		for (const n of Object.keys((fil as { mcpServers?: Record<string, unknown> } | null)?.mcpServers ?? {})) navn.add(n);
	}
	return [...navn].sort();
}

export function mcpParitet(
	opencode: readonly string[],
	claude: readonly string[],
	egne: readonly string[] = EGNE_SERVERE
): { bareOpencode: string[]; bareClaude: string[] } {
	const o = new Set(opencode.filter((n) => !egne.includes(n)));
	const c = new Set(claude.filter((n) => !egne.includes(n)));
	return { bareOpencode: [...o].filter((n) => !c.has(n)).sort(), bareClaude: [...c].filter((n) => !o.has(n)).sort() };
}

export interface Oppstart {
	navn: string;
	død: boolean;
	kode: number | null;
	stderr: string;
}

/** Start serveren med stdin fra `/dev/null`, og se om den dør med feil innen `ms`. */
export async function prøvOppstart(s: McpServer, cwd: string, ms = OPPSTART_MS): Promise<Oppstart> {
	if (!s.kommando?.length) return { navn: s.navn, død: false, kode: null, stderr: "" };
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(s.kommando, {
			cwd,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
			env: { ...process.env, ...(s.miljø ?? {}) },
		});
	} catch (e) {
		// ENOENT kastes før prosessen finnes: kommandoen er ikke på PATH.
		return { navn: s.navn, død: true, kode: null, stderr: e instanceof Error ? e.message : String(e) };
	}
	let tidsavbrudd = false;
	const vakt = setTimeout(() => {
		tidsavbrudd = true;
		proc.kill("SIGKILL");
	}, ms);
	const [stderr] = await Promise.all([new Response(proc.stderr as ReadableStream).text(), proc.exited]);
	clearTimeout(vakt);
	const kode = tidsavbrudd ? null : proc.exitCode;
	return { navn: s.navn, død: !tidsavbrudd && kode !== 0, kode, stderr };
}

/**
 * Linja som sier hva som gikk galt. En bun-stacktrace begynner med kildekoden
 * rundt feilen, så første linje er verdiløs (MÅLT: `81 |   private readonly …`
 * for Pureservice uten nøkler); feillinja er `PureserviceError: … is not set`.
 *
 * Colour codes are stripped first (#328): with `FORCE_COLOR` set, bun colours
 * its error output even without a terminal, and the line reached `pai doctor`
 * wrapped in `\x1b[31m`.
 */
export function feillinje(stderr: string): string {
	const linjer = stripVTControlCharacters(stderr)
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	return (
		linjer.find((l) => /^[A-Za-z]*Error\b:?|^error:/.test(l)) ??
		linjer.find((l) => /error|not found|not set|ENOENT/i.test(l)) ??
		linjer[0] ??
		"no stderr"
	);
}

export interface Helsekall {
	verktøy: string;
	argumenter: Record<string, unknown>;
	/** Milliseconds. */
	tidsavbrudd: number;
}

/**
 * `MCP-HELSE.json` by server name: a call, or `false` for deliberately none.
 * `feil` holds what could not be read; a missing file is no error.
 */
export function lesHelsekall(opencodeDir: string): { kall: Map<string, Helsekall | false>; feil: string[] } {
	const kall = new Map<string, Helsekall | false>();
	const sti = join(opencodeDir, MCP_HELSE_FIL);
	if (!existsSync(sti)) return { kall, feil: [] };
	const data = lesJson(sti);
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return { kall, feil: [`could not read ${MCP_HELSE_FIL} as a JSON object`] };
	}
	const feil: string[] = [];
	for (const [navn, v] of Object.entries(data as Record<string, unknown>)) {
		if (v === false) {
			kall.set(navn, false);
			continue;
		}
		const d = (v ?? {}) as Record<string, unknown>;
		const argumenter = d.argumenter ?? {};
		if (typeof d.kall !== "string" || !d.kall || typeof argumenter !== "object" || Array.isArray(argumenter)) {
			feil.push(`${MCP_HELSE_FIL}: ${navn} needs “kall” (text) and optionally “argumenter” (an object), or false`);
			continue;
		}
		const sek = typeof d.tidsavbrudd === "number" && d.tidsavbrudd > 0 ? d.tidsavbrudd : HELSEKALL_MS / 1000;
		kall.set(navn, { verktøy: d.kall, argumenter: argumenter as Record<string, unknown>, tidsavbrudd: sek * 1000 });
	}
	return { kall, feil };
}

const PROTOKOLL = "2025-06-18";

interface Økt {
	be(metode: string, params?: unknown): Promise<Record<string, unknown>>;
	varsle(metode: string): Promise<void>;
	versjon?: string;
	lukk(): void;
}

function rpcSvar(melding: Record<string, unknown>): Record<string, unknown> {
	const feil = melding.error as { message?: string; code?: number } | undefined;
	if (!feil) return (melding.result ?? {}) as Record<string, unknown>;
	const tekst = feil.message || "no message";
	throw new Error(`JSON-RPC error ${feil.code}: ${tekst}`);
}

/** Newline-delimited JSON-RPC over the server's stdin and stdout. */
function stdioØkt(s: McpServer, cwd: string): Økt {
	const proc = Bun.spawn(s.kommando as string[], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...(s.miljø ?? {}) },
	});
	const ventende = new Map<number, { ok: (r: Record<string, unknown>) => void; nei: (e: Error) => void }>();
	let neste = 1;
	const stderr = new Response(proc.stderr).text();
	void proc.exited.then(async (kode) => {
		const e = new Error(`the server exited (exit ${kode}): ${feillinje(await stderr).slice(0, 160)}`);
		for (const v of ventende.values()) v.nei(e);
		ventende.clear();
	});
	void (async () => {
		let rest = "";
		const dekoder = new TextDecoder();
		for await (const bit of proc.stdout) {
			rest += dekoder.decode(bit, { stream: true });
			let i = rest.indexOf("\n");
			while (i >= 0) {
				const linje = rest.slice(0, i).trim();
				rest = rest.slice(i + 1);
				i = rest.indexOf("\n");
				if (!linje) continue;
				try {
					const m = JSON.parse(linje) as Record<string, unknown>;
					const v = typeof m.id === "number" ? ventende.get(m.id) : undefined;
					if (!v) continue;
					ventende.delete(m.id as number);
					try {
						v.ok(rpcSvar(m));
					} catch (e) {
						v.nei(e as Error);
					}
				} catch {
					// Not JSON-RPC: a server that logs to stdout. Engines ignore it too.
				}
			}
		}
	})().catch(() => {});
	const skriv = (m: unknown) => {
		proc.stdin.write(`${JSON.stringify(m)}\n`);
		proc.stdin.flush();
	};
	return {
		be(metode, params) {
			const id = neste++;
			return new Promise((ok, nei) => {
				ventende.set(id, { ok, nei });
				try {
					skriv({ jsonrpc: "2.0", id, method: metode, params });
				} catch (e) {
					ventende.delete(id);
					nei(e as Error);
				}
			});
		},
		async varsle(metode) {
			skriv({ jsonrpc: "2.0", method: metode });
		},
		lukk() {
			proc.kill("SIGKILL");
		},
	};
}

/** The response to `id` in a JSON or SSE body (streamable HTTP). */
async function lesHttpSvar(res: Response, id: number): Promise<Record<string, unknown>> {
	const finn = (m: unknown) =>
		(Array.isArray(m) ? m : [m]).find((x) => (x as { id?: unknown })?.id === id) as Record<string, unknown> | undefined;
	if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
		const m = finn(await res.json());
		if (!m) throw new Error("the response lacked the JSON-RPC answer");
		return rpcSvar(m);
	}
	// The stream may stay open after the response, so read events until ours arrives.
	const leser = (res.body as ReadableStream<Uint8Array>).getReader();
	const dekoder = new TextDecoder();
	let rest = "";
	try {
		for (;;) {
			const { done, value } = await leser.read();
			if (done) break;
			rest += dekoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
			let i = rest.indexOf("\n\n");
			while (i >= 0) {
				const data = rest
					.slice(0, i)
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5).trimStart())
					.join("\n");
				rest = rest.slice(i + 2);
				i = rest.indexOf("\n\n");
				if (!data) continue;
				try {
					const m = finn(JSON.parse(data));
					if (m) return rpcSvar(m);
				} catch (e) {
					if (!(e instanceof SyntaxError)) throw e;
				}
			}
		}
	} finally {
		void leser.cancel().catch(() => {});
	}
	throw new Error("the stream ended without the JSON-RPC answer");
}

/** Streamable HTTP: POST per message, with the session id the server hands out. */
function httpØkt(s: McpServer, signal: AbortSignal): Økt {
	let sesjon: string | undefined;
	let neste = 1;
	const økt: Økt = {
		async be(metode, params) {
			const id = neste++;
			const res = await post({ jsonrpc: "2.0", id, method: metode, params });
			return lesHttpSvar(res, id);
		},
		async varsle(metode) {
			const res = await post({ jsonrpc: "2.0", method: metode });
			await res.body?.cancel();
		},
		lukk() {
			if (!sesjon) return;
			void fetch(s.url as string, {
				method: "DELETE",
				headers: { ...(s.headere ?? {}), "mcp-session-id": sesjon },
				signal: AbortSignal.timeout(2_000),
			}).catch(() => {});
		},
	};
	async function post(melding: unknown): Promise<Response> {
		const res = await fetch(s.url as string, {
			method: "POST",
			headers: {
				...(s.headere ?? {}),
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(sesjon ? { "mcp-session-id": sesjon } : {}),
				...(økt.versjon ? { "mcp-protocol-version": økt.versjon } : {}),
			},
			body: JSON.stringify(melding),
			signal,
		});
		sesjon = res.headers.get("mcp-session-id") ?? sesjon;
		if (!res.ok) {
			const tekst = (await res.text().catch(() => "")).split("\n")[0].slice(0, 120);
			throw new Error(`HTTP ${res.status}${tekst ? `: ${tekst}` : ""}`);
		}
		return res;
	}
	return økt;
}

interface Verktøy {
	name: string;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/**
 * A tool the server marks as writing is refused. Unmarked tools are trusted to
 * the declaration: most servers set no annotations.
 */
export function merketSkrivende(v: Verktøy): boolean {
	const a = v.annotations ?? {};
	return a.readOnlyHint === false || (a.readOnlyHint !== true && a.destructiveHint === true);
}

async function finnVerktøy(økt: Økt, navn: string): Promise<Verktøy | undefined> {
	let cursor: string | undefined;
	for (let side = 0; side < 20; side++) {
		const r = await økt.be("tools/list", cursor ? { cursor } : {});
		const treff = ((r.tools ?? []) as Verktøy[]).find((t) => t.name === navn);
		if (treff) return treff;
		cursor = typeof r.nextCursor === "string" ? r.nextCursor : undefined;
		if (!cursor) return undefined;
	}
	return undefined;
}

function førsteTekst(r: Record<string, unknown>): string {
	const tekst = ((r.content ?? []) as { type?: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
	return feillinje(tekst).slice(0, 160);
}

/**
 * Open a session, check that the declared tool exists and is not marked as
 * writing, and call it. `null` is healthy; otherwise what went wrong.
 */
export async function helsekall(s: McpServer, kall: Helsekall, cwd: string): Promise<string | null> {
	const avbryt = new AbortController();
	let økt: Økt | undefined;
	let vakt: ReturnType<typeof setTimeout> | undefined;
	const arbeid = (async (): Promise<string | null> => {
		if (s.url) økt = httpØkt(s, avbryt.signal);
		else if (s.kommando?.length) økt = stdioØkt(s, cwd);
		else return "has neither a command nor a url to call";
		const init = await økt.be("initialize", {
			protocolVersion: PROTOKOLL,
			capabilities: {},
			clientInfo: { name: "pai-doctor", version: "1" },
		});
		økt.versjon = typeof init.protocolVersion === "string" ? init.protocolVersion : PROTOKOLL;
		await økt.varsle("notifications/initialized");
		const v = await finnVerktøy(økt, kall.verktøy);
		if (!v) return `does not have the tool ${kall.verktøy} from ${MCP_HELSE_FIL}`;
		if (merketSkrivende(v)) {
			return `marks ${kall.verktøy} as writing, so the health call was not made: pick a read-only tool in ${MCP_HELSE_FIL}`;
		}
		const r = await økt.be("tools/call", { name: kall.verktøy, arguments: kall.argumenter });
		return r.isError === true ? `answered ${kall.verktøy} with an error: ${førsteTekst(r)}` : null;
	})().catch((e: unknown) => `health call failed: ${e instanceof Error ? e.message : String(e)}`);
	const tid = new Promise<string>((ok) => {
		vakt = setTimeout(() => ok(`did not answer ${kall.verktøy} within ${kall.tidsavbrudd / 1000} s`), kall.tidsavbrudd);
	});
	try {
		return await Promise.race([arbeid, tid]);
	} finally {
		clearTimeout(vakt);
		avbryt.abort();
		(økt as Økt | undefined)?.lukk();
	}
}

function lesJson(sti: string): unknown {
	try {
		return existsSync(sti) ? JSON.parse(readFileSync(sti, "utf-8")) : null;
	} catch {
		return null;
	}
}

function ekte(sti: string): string {
	try {
		return realpathSync(sti);
	} catch {
		return sti;
	}
}

/**
 * Hele sjekken for `opencodeDir` (`<repo>/.opencode`). `problemer` gjør doctor
 * rød; `varsler` er informasjon.
 */
export async function mcpHelse(
	opencodeDir: string,
	claudeJsonSti = join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json")
): Promise<{ problemer: string[]; varsler: string[] }> {
	const problemer: string[] = [];
	const varsler: string[] = [];
	const konfigSti = join(opencodeDir, "opencode.json");
	const konfig = lesJson(konfigSti);
	if (existsSync(konfigSti) && konfig === null) problemer.push(`could not read ${konfigSti} as JSON`);
	const servere = opencodeServere(konfig);

	// `pai --claude` starter i `.opencode/`, `-l` i katalogen brukeren står i; repo-roten er den vanlige.
	const stier = [...new Set([ekte(opencodeDir), ekte(dirname(opencodeDir))])];
	const claudeJson = lesJson(claudeJsonSti);
	const prosjektMcp = stier.map((s) => lesJson(join(s, ".mcp.json")));
	const claude = claudeServere(claudeJson, stier, prosjektMcp);
	const p = mcpParitet(
		servere.map((s) => s.navn),
		claude
	);
	for (const n of p.bareOpencode) {
		problemer.push(`MCP server ${n} is in opencode.json, but Claude does not have it: claude mcp add --scope user (install.md, step 11)`);
	}
	for (const n of p.bareClaude) varsler.push(`MCP server ${n} exists only in Claude (not in opencode.json)`);

	// #375: every server either engine has, v2's definition first.
	const alle = claudeDefinisjoner(claudeJson, stier, prosjektMcp);
	for (const s of servere) alle.set(s.navn, s);
	for (const n of EGNE_SERVERE) alle.delete(n);
	const helse = lesHelsekall(opencodeDir);
	problemer.push(...helse.feil);
	for (const n of helse.kall.keys()) {
		if (!alle.has(n)) varsler.push(`${MCP_HELSE_FIL} has a health call for ${n}, but neither engine has the server`);
	}
	const udeklarerte = [...alle.keys()].filter((n) => !helse.kall.has(n)).sort();
	if (udeklarerte.length > 0) {
		varsler.push(`no health call in ${MCP_HELSE_FIL}, so doctor cannot see whether the backend answers: ${udeklarerte.join(", ")}`);
	}
	const kalles = [...alle.values()].filter((s) => helse.kall.get(s.navn));
	const sse = kalles.filter((s) => s.type === "sse");
	for (const s of sse) varsler.push(`MCP server ${s.navn} uses sse, which the health call does not support`);

	// A server with a health call is started by it; the startup check is for the rest.
	const lokale = servere.filter((s) => s.type === "local" && !helse.kall.get(s.navn));
	const [utfall, svar] = await Promise.all([
		Promise.all(lokale.map((s) => prøvOppstart(s, dirname(opencodeDir)))),
		Promise.all(
			kalles
				.filter((s) => s.type !== "sse")
				.map(async (s) => ({ navn: s.navn, feil: await helsekall(s, helse.kall.get(s.navn) as Helsekall, dirname(opencodeDir)) }))
		),
	]);
	for (const u of utfall.filter((x) => x.død)) {
		problemer.push(`MCP server ${u.navn} died at startup (exit ${u.kode ?? "?"}): ${feillinje(u.stderr).slice(0, 160)}`);
	}
	for (const h of svar.filter((x) => x.feil)) problemer.push(`MCP server ${h.navn} ${h.feil}`);
	return { problemer, varsler };
}
