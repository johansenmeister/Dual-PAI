/**
 * Secrets: find and mask them before they reach the model or PAI's own files.
 *
 * Tokens kept leaking into sessions: a `grep -n` over `.git/config` printed a
 * PAT from a remote URL, a `docker inspect` printed an `Env` block, and each
 * time the token had to be rotated because it now lived in the model
 * provider's copy of the conversation, the transcript and sometimes PAI's
 * logs. The security guard only looked at commands before they ran.
 *
 * This module is the one place that knows what a secret looks like. Both
 * engines' adapters use it to mask tool output before the model sees it
 * (Claude Code: PostToolUse `updatedToolOutput`; OpenCode v2: `execute.after`
 * rewriting `result`; both MEASURED 2026-10-07 on 2.1.283 and 2.0.22), and
 * PAI's own writers use it before anything is stored.
 *
 * Two sources:
 *
 * - **Known values**: the values in `~/.opencode/.env` whose names say they
 *   are secret (`…TOKEN`, `…KEY`, `…PASSWORD`, …), and the same names in the
 *   process environment. Exact matches are masked as `[MASKED:<NAME>]`. The
 *   values are held in memory only, never logged or returned.
 * - **Shapes**: credentials in URLs, Authorization headers, private keys,
 *   JWTs, vendor token formats, and env-style `NAME=value` assignments.
 *
 * Deliberately NOT a shape: a bare 40-character hex string. A Gitea token
 * looks exactly like a git commit hash, and masking every hash would make
 * the assistant useless in a repository. Your Gitea token is still caught,
 * because its value is in `.env`.
 *
 * @module pai-core/lib/secrets
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `getHomePaiDir()` from `paths.ts`, repeated here on purpose: `file-logger`
 * masks every line with this module, and `paths` imports `file-logger`, so
 * importing `paths` here would make a cycle.
 */
function paiHome(): string {
	const override = process.env.PAI_HOME?.trim();
	return override || join(homedir(), ".opencode");
}

/** One thing that was masked. Never carries the value. */
export interface SecretHit {
	/** `known` for a value from `.env` or the environment, otherwise the shape's name. */
	kind: string;
	/** The variable name for `known`, otherwise the same as `kind`. */
	label: string;
}

export interface MaskResult {
	text: string;
	hits: SecretHit[];
}

export interface KnownSecret {
	name: string;
	value: string;
}

/**
 * Names whose values are secret. `GITEA_API_URL` and `GMAIL_USER` are not, and
 * neither is `PWD`: in the environment that is the current directory.
 */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|_PAT|_AUTH)$|^(PAT|AUTH)_|(?:^|_)KEY$/i;

/** Shorter values are too likely to occur by chance ("true", "8080", a user name). */
const MIN_KNOWN_LENGTH = 8;

const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** The secret-named values in a `.env` text. */
export function parseEnvSecrets(text: string): KnownSecret[] {
	const out: KnownSecret[] = [];
	for (const line of text.split("\n")) {
		const m = line.trim().match(ENV_LINE);
		if (!m || !SECRET_NAME.test(m[1])) continue;
		const value = m[2].trim().replace(/^(["'])(.*)\1$/, "$2").trim();
		if (value.length >= MIN_KNOWN_LENGTH) out.push({ name: m[1], value });
	}
	return out;
}

let cache: { file: string; mtimeMs: number; secrets: KnownSecret[] } | null = null;

/**
 * The known secret values: `<PAI home>/.env`, then the process environment.
 * The file is read again only when it changes (OpenCode keeps the plugin
 * alive for the whole session). A missing or unreadable file gives none.
 */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env): KnownSecret[] {
	const file = join(paiHome(), ".env");
	let fromFile: KnownSecret[] = [];
	try {
		const { mtimeMs } = statSync(file);
		if (cache && cache.file === file && cache.mtimeMs === mtimeMs) fromFile = cache.secrets;
		else {
			fromFile = parseEnvSecrets(readFileSync(file, "utf-8"));
			cache = { file, mtimeMs, secrets: fromFile };
		}
	} catch {
		cache = null;
	}
	const seen = new Set(fromFile.map((s) => s.value));
	const fromEnv: KnownSecret[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (!value || value.length < MIN_KNOWN_LENGTH || !SECRET_NAME.test(name) || seen.has(value)) continue;
		seen.add(value);
		fromEnv.push({ name, value });
	}
	// Longest first, so a value that contains another is masked whole.
	return [...fromFile, ...fromEnv].sort((a, b) => b.value.length - a.value.length);
}

interface Shape {
	kind: string;
	pattern: RegExp;
	/** The replacement, given the match and its groups. */
	replace: (m: string, ...groups: string[]) => string;
}

const mask = (kind: string) => `[MASKED:${kind}]`;

/** Uppercase env-style names: `GITEA_TOKEN=…`, `POSTGRES_PASSWORD: …`, `- API_KEY=…`. */
const ENV_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY))(\s*[=:]\s*)(["']?)([^\s"'$`{}()<>]{8,})\3/g;

/** Lowercase keys with a quoted value: `password: "…"`, `"api_key": "…"`. Unquoted lowercase is code too often. */
const QUOTED_ASSIGNMENT = /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?\s*[:=]\s*)(["'])([^"'\s$`{}]{8,})\3/gi;

const SHAPES: Shape[] = [
	{
		kind: "private-key",
		pattern: /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g,
		replace: (_m, begin, end) => `${begin}\n${mask("private-key")}\n${end}`,
	},
	{
		// scheme://user:password@host — keeps the user, masks the password.
		kind: "url-credential",
		pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
		replace: (_m, scheme, user) => `${scheme}${user}:${mask("url-credential")}@`,
	},
	{
		kind: "auth-header",
		pattern: /\b(Authorization\s*[:=]\s*["']?(?:Bearer|token|Basic)\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
		replace: (_m, prefix) => `${prefix}${mask("auth-header")}`,
	},
	{
		kind: "bearer-token",
		pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{20,})/g,
		replace: (_m, prefix) => `${prefix}${mask("bearer-token")}`,
	},
	{ kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: () => mask("jwt") },
	{ kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: () => mask("anthropic-key") },
	{ kind: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, replace: () => mask("openai-key") },
	{ kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g, replace: () => mask("github-token") },
	{ kind: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, replace: () => mask("gitlab-token") },
	{ kind: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: () => mask("slack-token") },
	{ kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, replace: () => mask("aws-access-key") },
	{ kind: "groq-key", pattern: /\bgsk_[A-Za-z0-9]{40,}/g, replace: () => mask("groq-key") },
	{ kind: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{30,}/g, replace: () => mask("huggingface-token") },
	{ kind: "fireworks-key", pattern: /\bfw_[A-Za-z0-9]{20,}/g, replace: () => mask("fireworks-key") },
	{
		kind: "assignment",
		pattern: ENV_ASSIGNMENT,
		replace: (_m, name, sep, quote) => `${name}${sep}${quote}${mask("assignment")}${quote}`,
	},
	{
		kind: "assignment",
		pattern: QUOTED_ASSIGNMENT,
		replace: (_m, name, sep, quote) => `${name}${sep}${quote}${mask("assignment")}${quote}`,
	},
];

/** A value already masked is not masked again (`[MASKED:…]` contains no secret). */
const ALREADY = /^\[MASKED:[^\]]+\]$/;

/**
 * Documentation placeholders: `your_api_key_here`, `xxxx-xxxx`, `sk-ant-...`,
 * `ChangeMe`, `process.env.X`. Skills and `.env.example` files are full of
 * them; masking them tells the model a secret was hidden when none was, and
 * the autosync guard (#370) would refuse every commit that adds one.
 */
const PLACEHOLDER = /your|(?:^|[-_.])x{4,}(?:$|[-_.])|\.\.\.|…|change|example|placeholder|^process\.env\./i;

/**
 * Masks every secret in `text`. Known values first, so a token from `.env`
 * is labelled with its name even when it also has a recognisable shape.
 */
export function maskSecrets(text: string, known: KnownSecret[] = knownSecrets()): MaskResult {
	if (!text) return { text, hits: [] };
	const hits: SecretHit[] = [];
	let out = text;
	for (const { name, value } of known) {
		if (!out.includes(value)) continue;
		out = out.split(value).join(mask(name));
		hits.push({ kind: "known", label: name });
	}
	for (const shape of SHAPES) {
		shape.pattern.lastIndex = 0;
		out = out.replace(shape.pattern, (...args) => {
			const m = args[0] as string;
			const groups = args.slice(1, -2) as string[];
			// The secret part of every shape is its last group, or the whole match.
			const secret = groups.length ? groups[groups.length - 1] : m;
			if (ALREADY.test(secret ?? "") || (secret ?? "").startsWith("[MASKED:") || PLACEHOLDER.test(secret ?? "")) return m;
			if (!hits.some((h) => h.kind === shape.kind)) hits.push({ kind: shape.kind, label: shape.kind });
			return shape.replace(m, ...groups);
		});
	}
	return { text: out, hits };
}

/**
 * Masks every string inside a structured value (a tool result object, an
 * array of content parts). Returns the same reference when nothing was masked,
 * so a caller can tell cheaply whether to replace it.
 */
export function maskDeep<T>(value: T, known: KnownSecret[] = knownSecrets()): { value: T; hits: SecretHit[] } {
	const hits: SecretHit[] = [];
	const add = (found: SecretHit[]) => {
		for (const h of found) if (!hits.some((x) => x.kind === h.kind && x.label === h.label)) hits.push(h);
	};
	const walk = (v: unknown, depth: number): unknown => {
		if (typeof v === "string") {
			const r = maskSecrets(v, known);
			if (!r.hits.length) return v;
			add(r.hits);
			return r.text;
		}
		if (depth > 12 || v === null || typeof v !== "object") return v;
		if (Array.isArray(v)) {
			let changed = false;
			const arr = v.map((x) => {
				const y = walk(x, depth + 1);
				if (y !== x) changed = true;
				return y;
			});
			return changed ? arr : v;
		}
		let changed = false;
		const obj: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
			const y = walk(x, depth + 1);
			if (y !== x) changed = true;
			obj[k] = y;
		}
		return changed ? obj : v;
	};
	return { value: walk(value, 0) as T, hits };
}

/** Text safe to store: masked, without the hit list. For logs and memory writers. */
export function forStorage(text: string): string {
	return maskSecrets(text).text;
}

/** A one-line note for the model about what was masked, naming kinds, never values. */
export function maskNotice(hits: SecretHit[]): string {
	const labels = [...new Set(hits.map((h) => h.label))].join(", ");
	return `[PAI Security] Secrets in this output were masked before you saw them (${labels}). Do not try to reveal or reconstruct them; refer to them by name.`;
}
