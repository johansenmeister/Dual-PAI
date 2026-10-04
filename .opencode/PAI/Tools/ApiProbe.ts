#!/usr/bin/env bun
/**
 * ============================================================================
 * APIPROBE — establish an API's contract as fact before any skill is written
 * ============================================================================
 *
 * PURPOSE:
 * Version-first, read-only probe of an API. Fetches the version endpoint,
 * smoke-tests the endpoints you name, reports the actual response shapes, and
 * emits a dated "verified facts" block to paste into the skill's docs.
 *
 * WHY THIS EXISTS:
 * Integrations here have started from an assumed protocol and converged by
 * trial-and-error on error codes: 10+ rounds of 403 debugging before noticing
 * TrueNAS Fangtooth deprecated REST for WebSocket JSON-RPC; two hours against
 * PAM before reading the version's docs; guessed JSON field names for an
 * endpoint that takes multipart/form-data. The one session that probed first
 * (Proxmox, 6 endpoints) finished with zero rework.
 *
 * READ-ONLY BY DESIGN:
 * This tool only ever sends GET and HEAD. It will not permute HTTP methods to
 * find a working one, because a read-only API key is a preserved safety
 * mechanism, not an obstacle — POST against system endpoints has halted a
 * firewall here before. If a GET returns 404, read the API contract (OpenAPI,
 * handler source, version docs); do not start guessing verbs. Write calls are
 * made deliberately, by a human decision, never by a probe.
 *
 * USAGE:
 *   bun ApiProbe.ts --base-url https://truenas.lan/api/v2.0 \
 *     --auth-env TRUENAS_API_KEY --auth-scheme Bearer \
 *     --version-path /system/info \
 *     --endpoints /pool,/pool/dataset,/service \
 *     [--header "X-Custom: value"] [--insecure] [--timeout 10000] [--json]
 *
 * EXIT CODES: 0 every probe succeeded · 1 at least one probe failed · 2 bad arguments
 *
 * ============================================================================
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const PAI_DIR =
	process.env.PAI_DIR || path.join(homedir(), ".opencode");

interface ProbeResult {
	endpoint: string;
	url: string;
	status: number | null;
	ok: boolean;
	contentType: string;
	shape: string;
	note: string;
	latencyMs: number;
	/** Raw body, kept for version extraction; never printed in full. */
	body: string;
}

// ─── Environment ─────────────────────────────────────────────────────────────

function loadEnv(): void {
	const envPath = path.join(PAI_DIR, ".env");
	if (!fs.existsSync(envPath)) return;
	const content = fs.readFileSync(envPath, "utf-8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx <= 0) continue;
		const key = trimmed.substring(0, eqIdx).trim();
		const val = trimmed.substring(eqIdx + 1).trim();
		if (!process.env[key]) process.env[key] = val;
	}
}

function parseArgs(argv: string[]): Record<string, string[]> {
	const args: Record<string, string[]> = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = argv[i + 1];
		const value = next === undefined || next.startsWith("--") ? "true" : next;
		if (value !== "true") i++;
		args[key] ??= [];
		args[key].push(value);
	}
	return args;
}

function first(args: Record<string, string[]>, key: string): string {
	return args[key]?.[0] ?? "";
}

// ─── Response inspection ─────────────────────────────────────────────────────

/**
 * What a downstream skill actually needs to know: is it JSON, is it an array
 * or an object, and is the payload wrapped (Proxmox wraps everything in
 * `data`, and a skill that assumes otherwise breaks on the first call).
 */
function describeShape(body: string, contentType: string): string {
	if (!contentType.includes("json")) {
		return contentType || "unknown content-type";
	}

	try {
		const parsed = JSON.parse(body) as unknown;

		if (Array.isArray(parsed)) {
			const sample = parsed[0];
			const keys =
				sample && typeof sample === "object"
					? Object.keys(sample as Record<string, unknown>).slice(0, 6).join(", ")
					: typeof sample;
			return `array[${parsed.length}] of { ${keys} }`;
		}

		if (parsed && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			const keys = Object.keys(record);
			const wrapped = keys.length === 1 && Array.isArray(record[keys[0]]);
			const prefix = wrapped ? `wrapped in "${keys[0]}" -> ` : "";
			const inner = wrapped ? (record[keys[0]] as unknown[]) : null;

			if (inner) {
				const sample = inner[0];
				const innerKeys =
					sample && typeof sample === "object"
						? Object.keys(sample as Record<string, unknown>).slice(0, 6).join(", ")
						: typeof sample;
				return `${prefix}array[${inner.length}] of { ${innerKeys} }`;
			}

			return `object { ${keys.slice(0, 8).join(", ")} }`;
		}

		return typeof parsed;
	} catch {
		return "invalid JSON body";
	}
}

/** Version strings are the single most valuable fact a probe can return. */
function extractVersion(body: string): string {
	const match = body.match(/\d+\.\d+(\.\d+)?([-\w.]*)?/);
	return match ? match[0] : "";
}

function guidanceFor(status: number): string {
	if (status === 401 || status === 403) {
		return "auth rejected — verify the credential's scope and whether this version still supports this transport, before trying other headers";
	}
	if (status === 404) {
		return "not found — read the OpenAPI spec or handler source for the real path. Do NOT permute HTTP methods";
	}
	if (status === 400) {
		return "bad request — the payload encoding is probably wrong (form-data vs JSON). Read the handler signature";
	}
	if (status === 405) {
		return "method not allowed — this endpoint is not readable; a write call is a human decision, not a probe";
	}
	if (status >= 500) {
		return "server error — the endpoint exists but failed; retry once, then check service logs";
	}
	return "";
}

// ─── Probing ─────────────────────────────────────────────────────────────────

async function probe(
	url: string,
	endpoint: string,
	headers: Record<string, string>,
	timeout: number,
): Promise<ProbeResult> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);

	try {
		// GET only. See READ-ONLY BY DESIGN in the header.
		const response = await fetch(url, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		const body = await response.text();
		const contentType = response.headers.get("content-type") ?? "";

		return {
			endpoint,
			url,
			status: response.status,
			ok: response.ok,
			contentType: contentType.split(";")[0],
			shape: response.ok ? describeShape(body, contentType) : body.slice(0, 160).replace(/\s+/g, " "),
			note: response.ok ? "" : guidanceFor(response.status),
			latencyMs: Date.now() - started,
			body,
		};
	} catch (error) {
		return {
			endpoint,
			url,
			status: null,
			ok: false,
			contentType: "",
			shape: error instanceof Error ? error.message : String(error),
			note: "transport failed — check host, port, TLS (try --insecure for self-signed) and reachability",
			latencyMs: Date.now() - started,
			body: "",
		};
	} finally {
		clearTimeout(timer);
	}
}

function usage(): void {
	console.error(
		[
			"Usage: bun ApiProbe.ts --base-url <url> --endpoints </a,/b,/c>",
			"         [--version-path /system/info]",
			"         [--auth-env ENV_VAR] [--auth-header Authorization] [--auth-scheme Bearer]",
			"         [--header \"X-Key: value\"] [--insecure] [--timeout 10000] [--json]",
			"",
			"Sends GET only. It will never permute HTTP methods to find a working one.",
		].join("\n"),
	);
}

async function main(): Promise<void> {
	loadEnv();
	const args = parseArgs(process.argv.slice(2));

	const baseUrl = first(args, "base-url").replace(/\/+$/, "");
	const endpoints = first(args, "endpoints")
		.split(",")
		.map((e) => e.trim())
		.filter(Boolean);
	const versionPath = first(args, "version-path");

	if (!baseUrl || (endpoints.length === 0 && !versionPath)) {
		usage();
		process.exit(2);
	}

	const headers: Record<string, string> = { Accept: "application/json" };

	const authEnv = first(args, "auth-env");
	if (authEnv) {
		const token = process.env[authEnv];
		if (!token) {
			console.error(`Environment variable ${authEnv} is empty — checked process env and ${PAI_DIR}/.env`);
			process.exit(2);
		}
		const headerName = first(args, "auth-header") || "Authorization";
		const scheme = first(args, "auth-scheme");
		headers[headerName] = scheme ? `${scheme} ${token}` : token;
	}

	for (const raw of args.header ?? []) {
		const idx = raw.indexOf(":");
		if (idx <= 0) {
			console.error(`Malformed --header "${raw}" — expected "Name: value"`);
			process.exit(2);
		}
		headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
	}

	if (args.insecure) {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		console.error("TLS verification disabled (--insecure) — acceptable for a self-signed homelab host, never for a probe over the internet.\n");
	}

	const timeout = Number(first(args, "timeout")) || 10_000;

	console.log(`Probing ${baseUrl} (GET only)\n`);

	const results: ProbeResult[] = [];
	let version = "";

	// Version first: it predicts the transport and the breaking changes.
	if (versionPath) {
		const result = await probe(`${baseUrl}${versionPath}`, versionPath, headers, timeout);
		results.push(result);
		if (result.ok) version = extractVersion(result.body);
	}

	for (const endpoint of endpoints) {
		results.push(await probe(`${baseUrl}${endpoint}`, endpoint, headers, timeout));
	}

	if (args.json) {
		const redacted = results.map(({ body: _body, ...rest }) => rest);
		console.log(JSON.stringify({ baseUrl, version, results: redacted }, null, 2));
	} else {
		for (const r of results) {
			const status = r.status === null ? "ERR" : String(r.status);
			console.log(`${r.ok ? "✓" : "✗"} ${status.padEnd(4)} ${r.endpoint}  (${r.latencyMs}ms)`);
			console.log(`     ${r.shape}`);
			if (r.note) console.log(`     → ${r.note}`);
		}
	}

	const failed = results.filter((r) => !r.ok);
	const today = new Date().toISOString().slice(0, 10);

	console.log("");
	if (failed.length === 0) {
		console.log("─── Verified facts (paste into the skill doc) ───");
		console.log(`<!-- Probed ${today} with ApiProbe.ts, GET only -->`);
		console.log(`- Base URL: \`${baseUrl}\``);
		if (version) console.log(`- Version: \`${version}\` (verified ${today})`);
		console.log(`- Auth: ${authEnv ? `\`${authEnv}\` via \`${first(args, "auth-header") || "Authorization"}\`` : "none"}`);
		for (const r of results) {
			console.log(`- \`GET ${r.endpoint}\` → ${r.status}, ${r.contentType}, ${r.shape}`);
		}
	} else {
		console.log(`${failed.length} of ${results.length} probe(s) failed. Do not write the skill yet —`);
		console.log("read the API contract (OpenAPI, handler source, version-specific docs) and probe again.");
		process.exit(1);
	}
}

if (import.meta.main) {
	main().catch((error) => {
		console.error("Fatal error:", error);
		process.exit(1);
	});
}
