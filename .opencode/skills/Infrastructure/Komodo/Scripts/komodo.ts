#!/usr/bin/env bun
/**
 * komodo.ts — read-only access to Komodo Core, with the secrets kept out (#380)
 *
 * Komodo's read API hands out secrets to anyone who may read: the deploy log's
 * "Compose Config" stage prints the resolved compose with values from `.env`,
 * `GetStack` returns the compose files (`remote_contents`, `deployed_contents`,
 * `deployed_config`) and the stack's `environment`, an update carries the
 * resource TOML (`prev_toml`, `current_toml`), and container labels can hold
 * anything. A rule in the skill text is not enough, so this tool is the only
 * way the model reads Komodo, and it prints an ALLOWLIST: each command copies
 * the fields it knows into a new object. A field Komodo adds later is dropped,
 * not passed through.
 *
 * Read-only by construction: every call goes to `POST {host}/read/<Type>`
 * (the 2.x client's form, komodo_client 2.3.2). Deploy, sync, exec and
 * permissions are done by a person in the UI.
 *
 * The environment comes from `KOMODO_CLI_HOST`, `KOMODO_CLI_KEY` and
 * `KOMODO_CLI_SECRET`, the names `km` reads too. When they are not set, the
 * tool reads them from `.env` in the PAI tree itself, so a session never has
 * to source it.
 *
 * Usage:
 *   bun komodo.ts stacks
 *   bun komodo.ts stack <name|id>
 *   bun komodo.ts servers
 *   bun komodo.ts updates [--stack <name|id>] [--page <n>]
 *   bun komodo.ts update <id>
 *   bun komodo.ts syncs
 *   bun komodo.ts sync <name|id>
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Projections: what may leave this tool -----------------------------------

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const time = (v: unknown): string | undefined => {
	const n = num(v);
	return n ? new Date(n).toISOString() : undefined;
};

/** A stage whose output is the resolved compose, secrets included. Never printed. */
export const SECRET_STAGE = /compose\s*config/i;

/** Lines kept from the end of a log stream. Long enough for an error. */
export const LOG_TAIL = 40;

function tail(text: unknown): string | undefined {
	const s = str(text);
	if (!s) return undefined;
	const lines = s.trimEnd().split("\n");
	return lines.length > LOG_TAIL ? [`… (${lines.length - LOG_TAIL} lines cut)`, ...lines.slice(-LOG_TAIL)].join("\n") : lines.join("\n");
}

function target(v: unknown) {
	const t = obj(v);
	return { type: str(t.type), id: str(t.id) };
}

function service(v: unknown) {
	const s = obj(v);
	return {
		service: str(s.service),
		image: str(s.image),
		latest_image: str(s.latest_image),
		update_available: bool(s.update_available),
	};
}

function container(v: unknown) {
	const c = obj(v);
	if (!str(c.name)) return undefined;
	return { name: str(c.name), state: str(c.state), status: str(c.status), image: str(c.image) };
}

export function projectStacks(raw: unknown) {
	return list(raw).map((item) => {
		const s = obj(item);
		const info = obj(s.info);
		return {
			id: str(s.id),
			name: str(s.name),
			tags: list(s.tags).filter((t) => typeof t === "string"),
			server: str(info.server_name) ?? str(info.server_id),
			state: str(info.state),
			status: str(info.status),
			repo: str(info.repo),
			branch: str(info.branch),
			deployed_hash: str(info.deployed_hash),
			latest_hash: str(info.latest_hash),
			missing_files: list(info.missing_files).filter((f) => typeof f === "string"),
			services: list(info.services).map(service),
		};
	});
}

export function projectStack(raw: unknown, services: unknown) {
	const s = obj(raw);
	const config = obj(s.config);
	const info = obj(s.info);
	const names = (v: unknown) => list(v).map((n) => str(obj(n).service_name)).filter(Boolean);
	return {
		id: str(obj(s._id).$oid) ?? str(s.id),
		name: str(s.name),
		server_id: str(config.server_id),
		repo: str(config.repo),
		branch: str(config.branch),
		run_directory: str(config.run_directory),
		file_paths: list(config.file_paths).filter((f) => typeof f === "string"),
		auto_update: bool(config.auto_update),
		deployed_hash: str(info.deployed_hash),
		deployed_message: str(info.deployed_message),
		latest_hash: str(info.latest_hash),
		latest_message: str(info.latest_message),
		deployed_services: names(info.deployed_services),
		latest_services: names(info.latest_services),
		missing_files: list(info.missing_files).filter((f) => typeof f === "string"),
		remote_errors: list(info.remote_errors).map((e) => str(obj(e).path)).filter(Boolean),
		services: list(services).map((v) => ({ ...service(v), container: container(obj(v).container) })),
	};
}

export function projectServers(raw: unknown) {
	return list(raw).map((item) => {
		const s = obj(item);
		const info = obj(s.info);
		return {
			id: str(s.id),
			name: str(s.name),
			state: str(info.state),
			version: str(info.version),
			region: str(info.region),
		};
	});
}

export function projectUpdates(raw: unknown) {
	const r = obj(raw);
	return {
		next_page: num(r.next_page),
		updates: list(r.updates).map((item) => {
			const u = obj(item);
			return {
				id: str(u.id),
				operation: str(u.operation),
				status: str(u.status),
				success: bool(u.success),
				start: time(u.start_ts),
				operator: str(u.username) ?? str(u.operator),
				target: target(u.target),
			};
		}),
	};
}

export function projectUpdate(raw: unknown) {
	const u = obj(raw);
	return {
		id: str(obj(u._id).$oid),
		operation: str(u.operation),
		status: str(u.status),
		success: bool(u.success),
		start: time(u.start_ts),
		end: time(u.end_ts),
		operator: str(u.operator),
		target: target(u.target),
		commit_hash: str(u.commit_hash),
		logs: list(u.logs).map((entry) => {
			const l = obj(entry);
			const stage = str(l.stage) ?? "";
			const base = { stage, success: bool(l.success), start: time(l.start_ts), end: time(l.end_ts) };
			if (SECRET_STAGE.test(stage)) return { ...base, output: "withheld: this stage prints the resolved compose, with secrets" };
			return { ...base, command: str(l.command), stdout: tail(l.stdout), stderr: tail(l.stderr) };
		}),
	};
}

export function projectSyncs(raw: unknown) {
	return list(raw).map((item) => {
		const s = obj(item);
		const info = obj(s.info);
		return {
			id: str(s.id),
			name: str(s.name),
			state: str(info.state),
			managed: bool(info.managed),
			repo: str(info.repo),
			branch: str(info.branch),
			last_sync: time(info.last_sync_ts),
			last_sync_message: str(info.last_sync_message),
		};
	});
}

/** The pending diff as a summary: what would change, never the TOML or the values. */
export function projectSync(raw: unknown) {
	const s = obj(raw);
	const config = obj(s.config);
	const info = obj(s.info);
	return {
		name: str(s.name),
		delete: bool(config.delete),
		managed: bool(config.managed),
		last_sync: time(info.last_sync_ts),
		last_sync_message: str(info.last_sync_message),
		pending_hash: str(info.pending_hash),
		pending_message: str(info.pending_message),
		pending_error: str(info.pending_error),
		pending_deploy_error: str(info.pending_deploy_error),
		resource_updates: list(info.resource_updates).map((d) => ({
			...target(obj(d).target),
			change: str(obj(obj(d).data).type),
		})),
		variable_updates: list(info.variable_updates).length,
		user_group_updates: list(info.user_group_updates).length,
		pending_deploys: list(info.pending_deploys).map((d) => target(obj(d).target)),
	};
}

// --- The API ------------------------------------------------------------------

export interface Env {
	host: string;
	key: string;
	secret: string;
}

/** `KEY=value` lines, as `.env` holds them; quotes stripped. */
export function parseDotenv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!m) continue;
		out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
	}
	return out;
}

/** The `.env` files to look in: the PAI tree's, then the default install's. */
function dotenvFiles(): string[] {
	const files: string[] = [];
	for (const dir of [process.env.PAI_HOME, process.env.PAI_DIR, join(homedir(), ".opencode")]) {
		if (dir) files.push(join(dir, ".env"));
	}
	return files;
}

export function loadEnv(env: Record<string, string | undefined> = process.env, files = dotenvFiles()): Env {
	const merged: Record<string, string | undefined> = {};
	for (const file of [...files].reverse()) {
		if (existsSync(file)) Object.assign(merged, parseDotenv(readFileSync(file, "utf-8")));
	}
	for (const k of ["KOMODO_CLI_HOST", "KOMODO_CLI_KEY", "KOMODO_CLI_SECRET"]) if (env[k]) merged[k] = env[k];
	const missing = ["KOMODO_CLI_HOST", "KOMODO_CLI_KEY", "KOMODO_CLI_SECRET"].filter((k) => !merged[k]);
	if (missing.length > 0) {
		throw new Error(`missing ${missing.join(", ")} (in the environment or ${files.join(" / ")})`);
	}
	return {
		host: (merged.KOMODO_CLI_HOST as string).replace(/\/+$/, ""),
		key: merged.KOMODO_CLI_KEY as string,
		secret: merged.KOMODO_CLI_SECRET as string,
	};
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** One read call. The path is fixed to `/read/`: this tool cannot write. */
export async function read(env: Env, type: string, params: Raw, fetchFn: Fetch = fetch): Promise<unknown> {
	if (!/^[A-Z][A-Za-z]+$/.test(type)) throw new Error(`not a read request: ${type}`);
	const res = await fetchFn(`${env.host}/read/${type}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": env.key, "x-api-secret": env.secret },
		body: JSON.stringify(params),
	});
	if (res.status !== 200) {
		// The body is Komodo's error text; it does not echo the request.
		throw new Error(`${type}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
	}
	return res.json();
}

const USAGE = `usage: komodo.ts <command>
  stacks                          stacks with state and update flags
  stack <name|id>                 one stack, its services and containers
  servers                         servers with state and version
  updates [--stack <s>] [--page n] the update history (newest first)
  update <id>                     one update with its logs ("Compose Config" withheld)
  syncs                           resource syncs
  sync <name|id>                  a sync's pending changes, as a summary`;

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

export async function run(args: string[], env: Env, fetchFn: Fetch = fetch): Promise<unknown> {
	const [command, arg] = args;
	const r = (type: string, params: Raw = {}) => read(env, type, params, fetchFn);
	switch (command) {
		case "stacks":
			return projectStacks(await r("ListStacks"));
		case "stack": {
			if (!arg) throw new Error(USAGE);
			const [stack, services] = await Promise.all([r("GetStack", { stack: arg }), r("ListStackServices", { stack: arg })]);
			return projectStack(stack, services);
		}
		case "servers":
			return projectServers(await r("ListServers"));
		case "updates": {
			const stack = flag(args, "--stack");
			const page = Number(flag(args, "--page") ?? 0);
			const query: Raw = {};
			if (stack) {
				const id = str(obj(obj(await r("GetStack", { stack }))._id).$oid);
				if (!id) throw new Error(`no stack ${stack}`);
				Object.assign(query, { "target.type": "Stack", "target.id": id });
			}
			return projectUpdates(await r("ListUpdates", { query, page }));
		}
		case "update":
			if (!arg) throw new Error(USAGE);
			return projectUpdate(await r("GetUpdate", { id: arg }));
		case "syncs":
			return projectSyncs(await r("ListResourceSyncs"));
		case "sync":
			if (!arg) throw new Error(USAGE);
			return projectSync(await r("GetResourceSync", { sync: arg }));
		default:
			throw new Error(USAGE);
	}
}

if (import.meta.main) {
	try {
		const out = await run(process.argv.slice(2), loadEnv());
		console.log(JSON.stringify(out, null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
