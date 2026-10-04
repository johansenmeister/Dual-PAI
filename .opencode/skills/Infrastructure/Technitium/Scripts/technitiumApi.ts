#!/usr/bin/env bun
/**
 * Technitium DNS Server API Client — HTTP REST (Bearer token)
 *
 * Usage:
 *   bun technitiumApi.ts [--pretty|--compact] <command> [args...]
 *
 * Reads from ~/.opencode/.env:
 *   TECHNITIUM_API_URL=https://<vert>:53443
 *   TECHNITIUM_API_TOKEN=<non-expiring token>
 *   TECHNITIUM_TLS_VERIFY=false     # self-signed cert
 *
 * All data retrieval from Technitium goes through this script.
 * The model must never make raw HTTP calls against Technitium itself.
 *
 * Read-only commands:
 *   status                              Server + session info (version, permissions)
 *   stats [type]                        Dashboard stats (default LastHour)
 *   top <clients|domains|blocked> [type] [limit]   Top stats
 *   zones                                List authoritative zones
 *   records <zone> [domain] [--all]      Get records for a domain/zone
 *   cache [domain]                       List cached zones/records
 *   blocked [domain] [up|down]           Browse Blocked zones
 *   allowed [domain] [up|down]           Browse Allowed zones
 *   export-blocked                       Export ALL blocked domains (text)
 *   export-allowed                       Export ALL allowed domains (text)
 *   resolve <domain> [type] [server]     DNS client resolve
 *   settings [key...]                    Get DNS settings (all or selected keys)
 *   apps                                 List installed DNS apps
 *   metrics [json|text]                  Lifetime metrics
 *   dhcp-leases                          List DHCP leases
 *   dhcp-scopes                          List DHCP scopes
 *   logs [limit] [--qname X] [--client IP] [--rcode X] [--qtype A]
 *                                       Query DNS logs (Query Logs Sqlite app)
 *   logs-files                          List available log files
 *
 * Write commands (need Modify/Delete permissions):
 *   cache-flush [domain]                 Flush whole cache, or delete one domain
 *   blocked-add <domain>                 Add domain to Blocked Zones
 *   blocked-delete <domain>              Remove domain from Blocked Zones
 *   blocked-flush                        Flush the whole Blocked zone
 *   blocked-import <file|domain,domain>  Import blocked domains
 *   allowed-add <domain>                 Add domain to Allowed Zones
 *   allowed-delete <domain>              Remove domain from Allowed Zones
 *   allowed-flush                        Flush the whole Allowed zone
 *   blocklist-update                     Force update block lists now
 *   blocking-disable <minutes>           Temporarily disable blocking
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
	url: string;
	token: string;
	tlsVerify: boolean;
}

function readEnvFile(): Record<string, string> {
	const env: Record<string, string> = {};
	const envPath = resolve(homedir(), ".opencode", ".env");
	if (!existsSync(envPath)) return env;
	for (const raw of readFileSync(envPath, "utf-8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return env;
}

function loadConfig(): Config {
	const env = readEnvFile();
	const url = process.env.TECHNITIUM_API_URL || env.TECHNITIUM_API_URL;
	const token = process.env.TECHNITIUM_API_TOKEN || env.TECHNITIUM_API_TOKEN;
	const tlsVerifyRaw =
		process.env.TECHNITIUM_TLS_VERIFY || env.TECHNITIUM_TLS_VERIFY || "true";

	if (!url || !token) {
		console.error("");
		console.error("╔══════════════════════════════════════════════════════════╗");
		console.error("║  MISSING TECHNITIUM CREDENTIALS                          ║");
		console.error("╠══════════════════════════════════════════════════════════╣");
		console.error("║  Add to ~/.opencode/.env:                                ║");
		console.error("║    TECHNITIUM_API_URL=https://<host>:53443               ║");
		console.error("║    TECHNITIUM_API_TOKEN=<token>                          ║");
		console.error("║    TECHNITIUM_TLS_VERIFY=false                           ║");
		console.error("║                                                          ║");
		console.error("║  Create a token (dedicated user recommended):            ║");
		console.error("║    curl -k -G <url>/api/user/createToken \\               ║");
		console.error('║      --data-urlencode "user=pai-api" \\                   ║');
		console.error('║      --data-urlencode "pass=<password>" \\                ║');
		console.error('║      --data-urlencode "tokenName=pai-api"                ║');
		console.error("╚══════════════════════════════════════════════════════════╝");
		console.error("");
		process.exit(1);
	}

	return {
		url: url.replace(/\/+$/, ""),
		token,
		tlsVerify: tlsVerifyRaw.toLowerCase() !== "false",
	};
}

const CONFIG = loadConfig();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface ApiResult {
	ok: boolean;
	httpStatus: number;
	status?: string;
	errorMessage?: string;
	response?: unknown;
	[key: string]: unknown;
}

function buildUrl(path: string, params?: Record<string, string | number | boolean>): string {
	const u = new URL(`${CONFIG.url}${path.startsWith("/") ? path : `/${path}`}`);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
		}
	}
	return u.toString();
}

async function apiGet(
	path: string,
	params?: Record<string, string | number | boolean>,
): Promise<ApiResult> {
	const res = await fetch(buildUrl(path, params), {
		headers: { Authorization: `Bearer ${CONFIG.token}` },
		tls: { rejectUnauthorized: CONFIG.tlsVerify },
	});
	const text = await res.text();
	let json: ApiResult;
	try {
		json = JSON.parse(text) as ApiResult;
	} catch {
		json = { ok: res.ok, httpStatus: res.status, status: "error", errorMessage: text.slice(0, 500) };
	}
	json.httpStatus = res.status;
	json.ok = res.ok && json.status === "ok";
	return json;
}

async function apiPostForm(path: string, form: Record<string, string>): Promise<ApiResult> {
	const body = new URLSearchParams(form).toString();
	const res = await fetch(buildUrl(path), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${CONFIG.token}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
		tls: { rejectUnauthorized: CONFIG.tlsVerify },
	});
	const text = await res.text();
	let json: ApiResult;
	try {
		json = JSON.parse(text) as ApiResult;
	} catch {
		json = { ok: res.ok, httpStatus: res.status, status: "error", errorMessage: text.slice(0, 500) };
	}
	json.httpStatus = res.status;
	json.ok = res.ok && json.status === "ok";
	return json;
}

async function apiGetText(path: string): Promise<string> {
	const res = await fetch(buildUrl(path), {
		headers: { Authorization: `Bearer ${CONFIG.token}` },
		tls: { rejectUnauthorized: CONFIG.tlsVerify },
	});
	return await res.text();
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

let PRETTY = true;

function emit(data: unknown): void {
	if (typeof data === "string") {
		console.log(data);
		return;
	}
	console.log(PRETTY ? JSON.stringify(data, null, 2) : JSON.stringify(data));
}

/** Emit an API JSON envelope; exit non-zero on API error. */
function emitResult(result: ApiResult): void {
	if (!result.ok) {
		console.error(
			`Technitium API error (${result.status ?? "?"}) HTTP ${result.httpStatus}: ${
				result.errorMessage ?? "unknown"
			}`,
		);
		emit(result);
		process.exit(1);
	}
	emit(result);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const READ_ONLY = new Set([
	"status",
	"stats",
	"top",
	"zones",
	"records",
	"cache",
	"blocked",
	"allowed",
	"export-blocked",
	"export-allowed",
	"resolve",
	"settings",
	"apps",
	"metrics",
	"dhcp-leases",
	"dhcp-scopes",
	"logs",
	"logs-files",
]);

// Query Logs (Sqlite) app identity on this server — used by /api/logs/query.
const LOGS_APP_NAME = "Query Logs (Sqlite)";
const LOGS_APP_CLASS_PATH = "QueryLogsSqlite.App";

interface ParsedArgs {
	command: string;
	positional: string[];
	flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--pretty") {
			PRETTY = true;
		} else if (a === "--compact") {
			PRETTY = false;
		} else if (a === "--all") {
			flags.all = true;
		} else if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			positional.push(a);
		}
	}
	return { command: positional.shift() ?? "", positional, flags };
}

const STATS_TYPES = new Set(["LastHour", "LastDay", "LastWeek", "LastMonth", "LastYear", "Custom"]);

function normalizeStatsType(t: string | undefined): string {
	if (!t) return "LastHour";
	const m = [...STATS_TYPES].find((x) => x.toLowerCase() === t.toLowerCase());
	return m ?? "LastHour";
}

function buildBlockedExport(domains: string): string {
	if (existsSync(domains)) {
		const content = readFileSync(domains, "utf-8");
		return content
			.split(/[\n,]/)
			.map((d) => d.trim())
			.filter((d) => d && !d.startsWith("#"))
			.join(",");
	}
	return domains
		.split(",")
		.map((d) => d.trim())
		.filter(Boolean)
		.join(",");
}

async function run(): Promise<void> {
	const { command, positional, flags } = parseArgs(process.argv.slice(2));

	if (!command) {
		console.error(
			"Usage: bun technitiumApi.ts [--pretty|--compact] <command> [args...]\n" +
				"Commands: " +
				[...READ_ONLY].join(", ") +
				"\ncache-flush, blocked-add, blocked-delete, blocked-flush, blocked-import, " +
				"allowed-add, allowed-delete, allowed-flush, blocklist-update, blocking-disable",
		);
		process.exit(1);
	}

	switch (command) {
		// ----- Read -----------------
		case "status": {
			const session = await apiGet("/api/user/session/get");
			emitResult(session);
			return;
		}
		case "stats": {
			const type = normalizeStatsType(positional[0]);
			const r = await apiGet("/api/dashboard/stats/get", { type, utc: true });
			emitResult(r);
			return;
		}
		case "top": {
			const kind = (positional[0] ?? "domains").toLowerCase();
			const map: Record<string, string> = {
				clients: "TopClients",
				domains: "TopDomains",
				blocked: "TopBlockedDomains",
			};
			const statsType = map[kind];
			if (!statsType) {
				console.error("top: expected clients | domains | blocked");
				process.exit(1);
			}
			const type = normalizeStatsType(positional[1]);
			const limit = positional[2] ?? "100";
			const r = await apiGet("/api/dashboard/stats/getTop", { type, statsType, limit });
			emitResult(r);
			return;
		}
		case "zones": {
			const r = await apiGet("/api/zones/list");
			emitResult(r);
			return;
		}
		case "records": {
			const zone = positional[0];
			if (!zone) {
				console.error("records: expected <zone> [domain]");
				process.exit(1);
			}
			const domain = positional[1];
			const listZone = flags.all === true || !domain;
			const r = await apiGet("/api/zones/records/get", {
				zone,
				domain: domain ?? zone,
				listZone: listZone ? "true" : "false",
			});
			emitResult(r);
			return;
		}
		case "cache": {
			const r = await apiGet("/api/cache/list", {
				domain: positional[0],
				direction: typeof flags.direction === "string" ? flags.direction : undefined,
			});
			emitResult(r);
			return;
		}
		case "blocked": {
			const r = await apiGet("/api/blocked/list", {
				domain: positional[0],
				direction: (positional[1] as string) ?? (flags.direction as string) ?? undefined,
			});
			emitResult(r);
			return;
		}
		case "allowed": {
			const r = await apiGet("/api/allowed/list", {
				domain: positional[0],
				direction: (positional[1] as string) ?? (flags.direction as string) ?? undefined,
			});
			emitResult(r);
			return;
		}
		case "export-blocked": {
			const text = await apiGetText("/api/blocked/export");
			emit(text);
			return;
		}
		case "export-allowed": {
			const text = await apiGetText("/api/allowed/export");
			emit(text);
			return;
		}
		case "resolve": {
			const domain = positional[0];
			if (!domain) {
				console.error("resolve: expected <domain> [type] [server]");
				process.exit(1);
			}
			const r = await apiGet("/api/dnsClient/resolve", {
				domain,
				type: (positional[1] ?? "A").toUpperCase(),
				server: positional[2] ?? "this-server",
				protocol: (flags.protocol as string) ?? "Udp",
			});
			emitResult(r);
			return;
		}
		case "settings": {
			const r = await apiGet("/api/settings/get");
			if (!r.ok) {
				emitResult(r);
				return;
			}
			const response = r.response as Record<string, unknown>;
			if (positional.length > 0) {
				const picked: Record<string, unknown> = {};
				for (const k of positional) picked[k] = response[k] ?? null;
				emit({ status: "ok", response: picked, httpStatus: r.httpStatus, ok: true });
			} else {
				emit(r);
			}
			return;
		}
		case "apps": {
			const r = await apiGet("/api/apps/list");
			emitResult(r);
			return;
		}
		case "metrics": {
			const kind = (positional[0] ?? "json").toLowerCase();
			if (kind === "text") {
				const text = await apiGetText("/api/dashboard/metrics/text");
				emit(text);
			} else {
				const r = await apiGet("/api/dashboard/metrics/json");
				emitResult(r);
			}
			return;
		}
		case "dhcp-leases": {
			const r = await apiGet("/api/dhcp/leases/list");
			emitResult(r);
			return;
		}
		case "dhcp-scopes": {
			const r = await apiGet("/api/dhcp/scopes/list");
			emitResult(r);
			return;
		}
		case "logs": {
			const limit = positional[0] ?? "50";
			const r = await apiGet("/api/logs/query", {
				name: (flags.name as string) ?? LOGS_APP_NAME,
				classPath: (flags.class as string) ?? LOGS_APP_CLASS_PATH,
				pageNumber: 1,
				entriesPerPage: limit,
				descendingOrder: flags.asc === true ? "false" : "true",
				qname: flags.qname as string,
				clientIpAddress: flags.client as string,
				rcode: flags.rcode as string,
				qtype: flags.qtype as string,
				start: flags.start as string,
				end: flags.end as string,
			});
			emitResult(r);
			return;
		}
		case "logs-files": {
			const r = await apiGet("/api/logs/list");
			emitResult(r);
			return;
		}

		// ----- Write -----------------
		case "cache-flush": {
			const domain = positional[0];
			const r = domain
				? await apiGet("/api/cache/delete", { domain })
				: await apiGet("/api/cache/flush");
			emitResult(r);
			return;
		}
		case "blocked-add": {
			const domain = positional[0];
			if (!domain) {
				console.error("blocked-add: expected <domain>");
				process.exit(1);
			}
			emitResult(await apiGet("/api/blocked/add", { domain }));
			return;
		}
		case "blocked-delete": {
			const domain = positional[0];
			if (!domain) {
				console.error("blocked-delete: expected <domain>");
				process.exit(1);
			}
			emitResult(await apiGet("/api/blocked/delete", { domain }));
			return;
		}
		case "blocked-flush": {
			emitResult(await apiGet("/api/blocked/flush"));
			return;
		}
		case "blocked-import": {
			const input = positional.join(",");
			if (!input) {
				console.error("blocked-import: expected <file|domain,domain>");
				process.exit(1);
			}
			const blockedZones = buildBlockedExport(input);
			emitResult(await apiPostForm("/api/blocked/import", { blockedZones }));
			return;
		}
		case "allowed-add": {
			const domain = positional[0];
			if (!domain) {
				console.error("allowed-add: expected <domain>");
				process.exit(1);
			}
			emitResult(await apiGet("/api/allowed/add", { domain }));
			return;
		}
		case "allowed-delete": {
			const domain = positional[0];
			if (!domain) {
				console.error("allowed-delete: expected <domain>");
				process.exit(1);
			}
			emitResult(await apiGet("/api/allowed/delete", { domain }));
			return;
		}
		case "allowed-flush": {
			emitResult(await apiGet("/api/allowed/flush"));
			return;
		}
		case "blocklist-update": {
			emitResult(await apiGet("/api/settings/forceUpdateBlockLists"));
			return;
		}
		case "blocking-disable": {
			const minutes = positional[0] ?? "5";
			emitResult(await apiGet("/api/settings/temporaryDisableBlocking", { minutes }));
			return;
		}

		default:
			console.error(`Unknown command: ${command}`);
			process.exit(1);
	}
}

run().catch((e: unknown) => {
	console.error("technitiumApi error:", e instanceof Error ? e.message : e);
	process.exit(1);
});
