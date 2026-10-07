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
}

/** PAIs egen server kommer fra pluginen på Claude-siden, og v2 har verktøyene uten MCP. */
export const EGNE_SERVERE: readonly string[] = ["pai"];

const OPPSTART_MS = 2_000;

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
			miljø:
				v.environment && typeof v.environment === "object"
					? Object.fromEntries(
							Object.entries(v.environment as Record<string, unknown>).map(([k, d]) => [k, utvidEnv(String(d), env)])
						)
					: undefined,
		}));
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
	const claude = claudeServere(
		lesJson(claudeJsonSti),
		stier,
		stier.map((s) => lesJson(join(s, ".mcp.json")))
	);
	const p = mcpParitet(
		servere.map((s) => s.navn),
		claude
	);
	for (const n of p.bareOpencode) {
		problemer.push(`MCP server ${n} is in opencode.json, but Claude does not have it: claude mcp add --scope user (install.md, step 11)`);
	}
	for (const n of p.bareClaude) varsler.push(`MCP server ${n} exists only in Claude (not in opencode.json)`);

	const lokale = servere.filter((s) => s.type === "local");
	const utfall = await Promise.all(lokale.map((s) => prøvOppstart(s, dirname(opencodeDir))));
	for (const u of utfall.filter((x) => x.død)) {
		problemer.push(`MCP server ${u.navn} died at startup (exit ${u.kode ?? "?"}): ${feillinje(u.stderr).slice(0, 160)}`);
	}
	return { problemer, varsler };
}
