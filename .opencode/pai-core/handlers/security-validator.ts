/**
 * PAI-OpenCode Security Validator
 *
 * Validates tool executions for security threats.
 * Equivalent to PAI's security-validator.ts hook.
 *
 * Enhanced in WP-B:
 * - Comprehensive injection pattern detection (7 categories)
 * - Input sanitization before pattern matching
 * - Security audit logging to security-audit.jsonl
 * - Multi-field scanning (not just args.content)
 * - Fire-and-forget audit logging (non-blocking)
 * - Secrets redaction in audit logs
 *
 * @module security-validator
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PermissionInput, SecurityResult, ToolInput } from "../adapters/types";
import { DANGEROUS_PATTERNS, WARNING_PATTERNS } from "../adapters/types";
import { fileLog, fileLogError } from "../lib/file-logger";
import { detectInjections, type InjectionCategory } from "../lib/injection-patterns";
import { getStateDir } from "../lib/paths";
import { utenData } from "../lib/skalldata";
import { lesSkrivebeskyttet, skrivebeskyttetRot } from "../lib/skrivebeskyttet";
import { INJECTION_SCAN_FIELDS, sanitizeForSecurityCheck } from "../lib/sanitizer";
import { isShellTool, kanoniskeArgs, skrivemål } from "../lib/tool-names";
import { currentHarness } from "../runtime";

/**
 * Security audit log entry
 */
interface SecurityAuditEntry {
	timestamp: string;
	tool: string;
	action: "blocked" | "confirmed" | "allowed";
	reason: string;
	pattern?: string;
	category?: InjectionCategory;
	commandPreview?: string; // First 100 chars, sanitized
}

/**
 * Append to security audit log
 *
 * SYNKRONT (M-43). Under Claude Code er hvert hook-kall sin egen prosess, og
 * den avslutter med `process.exit(0)` så snart svaret er skrevet. Den gamle
 * fire-and-forget-skrivingen rakk aldri fram der: null linjer med `harness:
 * claude` fra ekte økter, bare fra `bun test` (MÅLT 2026-09-27). Én linje
 * med `appendFileSync` koster under et millisekund.
 *
 * @param entry - The audit entry to log
 */
function logSecurityEvent(entry: SecurityAuditEntry): void {
	try {
		const stateDir = getStateDir();
		fs.mkdirSync(stateDir, { recursive: true });
		const line = `${JSON.stringify({ ...entry, harness: currentHarness() })}\n`;
		fs.appendFileSync(path.join(stateDir, "security-audit.jsonl"), line, "utf-8");
	} catch {
		// Revisjonen skal aldri velte avgjørelsen.
		fileLog("Failed to write security audit entry", "warn");
	}
}

/**
 * Redact sensitive values from command text
 * Masks API keys, tokens, and credentials
 *
 * @param command - The command to redact
 * @returns Redacted command
 */
function redactSecrets(command: string): string {
	// API Keys and tokens
	const redacted = command
		// Anthropic API keys
		.replace(/sk-ant-[A-Za-z0-9\-_]{20,}/g, "sk-ant-[REDACTED]")
		// OpenAI API keys
		.replace(/sk-[a-zA-Z0-9]{32,}/g, "sk-[REDACTED]")
		// GitHub PATs
		.replace(/gh[pousr]_[a-zA-Z0-9]{36,}/g, "gh[REDACTED]")
		// AWS Access Keys
		.replace(/\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g, "$1[REDACTED]")
		// Groq API keys
		.replace(/gsk_[a-zA-Z0-9]{52}/g, "gsk-[REDACTED]")
		// HuggingFace tokens
		.replace(/hf_[a-zA-Z0-9]{34,}/g, "hf-[REDACTED]")
		// PEM private keys (redact content between headers)
		.replace(
			/(-----BEGIN\s+(?:[A-Z0-9]+\s+)?PRIVATE\s+KEY-----)[\s\S]*?(-----END\s+(?:[A-Z0-9]+\s+)?PRIVATE\s+KEY-----)/g,
			"$1\n[REDACTED]\n$2"
		)
		// Generic high-entropy tokens ( heuristic: 40+ alphanumeric chars)
		.replace(/\b[a-zA-Z0-9_-]{40,}\b/g, "[REDACTED]");

	return redacted;
}

/**
 * Check if a command matches any dangerous pattern
 *
 * @param command - The command to check
 * @returns The matching pattern or null
 */
function matchesDangerousPattern(command: string): RegExp | null {
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(command)) {
			return pattern;
		}
	}
	return null;
}

/**
 * Check if a command matches any warning pattern
 *
 * @param command - The command to check
 * @returns The matching pattern or null
 */
function matchesWarningPattern(command: string): RegExp | null {
	for (const pattern of WARNING_PATTERNS) {
		if (pattern.test(command)) {
			return pattern;
		}
	}
	return null;
}

/**
 * Hard-block path patterns: precise, unambiguous credential locations.
 *
 * Anchored to path segments (never a bare substring anywhere in the path),
 * so legitimate files like `docs/secrets-oversikt.md` or
 * `runbooks/howto-secret-rotasjon.md` are never caught here. Matched against
 * the full (slash-normalized) path.
 */
const HARD_BLOCK_PATH_PATTERNS: RegExp[] = [
	/(^|\/)\.ssh\//, // .ssh/ directory (authorized_keys, id_*, known_hosts, config, ...)
	/(^|\/)\.aws\/(credentials|config)$/, // AWS credentials/config files specifically
	/(^|\/)\.gnupg\//, // GnuPG keyring directory
	/(^|\/)\.kube\/config$/, // Kubernetes config (cluster credentials/tokens)
	/(^|\/)\.docker\/config\.json$/, // Docker registry auth tokens
	/^\/etc\//, // Absolute /etc/ at the root only, not any nested "/etc/" segment
];

/**
 * Hard-block basename patterns: same precision, but matched against just the
 * file's basename so a relative path like ".opencode/.env" matches as
 * reliably as an absolute one.
 */
const HARD_BLOCK_BASENAME_PATTERNS: RegExp[] = [
	/^\.env(\..+)?$/, // .env, .env.local, .env.production, ... (see exemptions below)
	/^\.netrc$/,
	/\.(pem|key)$/i, // Private key files
	/^id_(rsa|ed25519)$/, // Common SSH private key basenames outside .ssh/
];

// Basenames that would otherwise match a hard-block basename pattern above
// but are known-safe and must never be blocked.
const HARD_BLOCK_BASENAME_EXEMPTIONS = new Set<string>([".env.example"]);

/**
 * Warn-only path patterns: broad heuristics kept purely as signal (logged,
 * non-blocking). These match on loose substrings and would false-positive on
 * legitimate files (e.g. "secret" appears in `runbooks/howto-secret-rotasjon.md`),
 * so they must never hard-block.
 */
const WARN_ONLY_PATH_PATTERNS: RegExp[] = [/\/var\/log\//, /credentials/i, /secret/i];

/**
 * Check a file path against the hard-block patterns.
 *
 * @param filePath - The file path to check (write/edit target)
 * @returns The matching pattern or null
 */
function matchesHardBlockPath(filePath: string): RegExp | null {
	const normalized = filePath.replace(/\\/g, "/");

	for (const pattern of HARD_BLOCK_PATH_PATTERNS) {
		if (pattern.test(normalized)) {
			return pattern;
		}
	}

	const basename = path.basename(normalized);
	if (!HARD_BLOCK_BASENAME_EXEMPTIONS.has(basename)) {
		for (const pattern of HARD_BLOCK_BASENAME_PATTERNS) {
			if (pattern.test(basename)) {
				return pattern;
			}
		}
	}

	return null;
}

/**
 * Check a file path against the warn-only (non-blocking) heuristics.
 *
 * @param filePath - The file path to check (write/edit target)
 * @returns The matching pattern or null
 */
function matchesWarnOnlyPath(filePath: string): RegExp | null {
	const normalized = filePath.replace(/\\/g, "/");
	for (const pattern of WARN_ONLY_PATH_PATTERNS) {
		if (pattern.test(normalized)) {
			return pattern;
		}
	}
	return null;
}

/**
 * Verbet i begrunnelsen per skrivende verktøy. `write`/`edit` har de samme
 * ordene som før K58; et verktøy som mangler her, får `write`s.
 */
const SKRIVEETIKETT: Readonly<Record<string, readonly [string, string]>> = {
	write: ["Write", "Writing to"],
	edit: ["Edit", "Editing"],
	multiedit: ["Edit", "Editing"],
	notebookedit: ["NotebookEdit", "Editing"],
	patch: ["Patch", "Patching"],
};

/**
 * Extract command from tool input
 *
 * Forventer kjernens feltnavn (`kanoniskeArgs`), slik `validateSecurity` gir
 * dem. Eksportert for de gyldne payloadene (K25), som går den samme veien.
 *
 * @param input - The tool or permission input
 * @returns The extracted command or null
 */
export function extractCommand(input: PermissionInput | ToolInput): string | null {
	// Normalize tool name to lowercase for comparison
	const toolName = input.tool.toLowerCase();

	// Skallverktøyet: `bash`/`Bash` i v1 og Claude, `shell` i OpenCode v2
	if (isShellTool(toolName) && typeof input.args?.command === "string") {
		let command = input.args.command;

		// Strip env var assignment prefixes to avoid false positives (upstream #620)
		// e.g., "export AWS_SECRET=xyz" → "AWS_SECRET=xyz" so patterns match the value, not the keyword
		command = command.replace(/^(export|set|declare|readonly)\s+/gm, "");

		return command;
	}

	// Skrivende verktøy (K58): `write:<sti>`, `patch:<sti> <sti>`. Uten sti er
	// det ingenting å sjekke, og da returneres null som før.
	const stier = skrivemål(toolName, input.args);
	if (stier && stier.length > 0) {
		return `${toolName}:${stier.join(" ")}`;
	}

	return null;
}

/**
 * Check all text fields in args for prompt injection patterns
 *
 * Scans all fields listed in INJECTION_SCAN_FIELDS, not just args.content.
 * Sanitizes input before pattern matching to catch obfuscated attacks.
 *
 * @param args - The tool arguments to check
 * @returns Match info if injection detected, null otherwise
 */
function checkAllFieldsForInjection(args: Record<string, unknown>): {
	field: string;
	matches: ReturnType<typeof detectInjections>;
} | null {
	for (const field of INJECTION_SCAN_FIELDS) {
		const value = args[field];
		if (typeof value !== "string") continue;

		// Sanitize before pattern matching (catches obfuscated attacks)
		const sanitized = sanitizeForSecurityCheck(value);

		// Check original and sanitized versions
		const matches = detectInjections(value);
		const sanitizedMatches = sanitized !== value ? detectInjections(sanitized) : [];

		const allMatches = [...matches, ...sanitizedMatches];
		if (allMatches.length > 0) {
			return { field, matches: allMatches };
		}
	}
	return null;
}

/**
 * Validate security for a tool execution
 *
 * @param input - The tool or permission input to validate
 * @returns SecurityResult indicating what action to take
 */
export async function validateSecurity(
	rå: PermissionInput | ToolInput
): Promise<SecurityResult> {
	// Kjernens feltnavn uansett motor (K-09). Resten av funksjonen leser
	// `filePath`/`oldString`/`newString`, og Claude sender snake_case.
	const input = { ...rå, args: kanoniskeArgs(rå.args) };
	try {
		fileLog(`Security check for tool: ${input.tool}`);
		fileLog(`Args: ${redactSecrets(JSON.stringify(input.args ?? {})).substring(0, 300)}`, "debug");

		const command = extractCommand(input);

		// Check for prompt injection in ALL text fields FIRST (even if no command)
		const injectionResult = input.args ? checkAllFieldsForInjection(input.args) : null;

		if (injectionResult) {
			const firstMatch = injectionResult.matches[0];
			fileLog(`BLOCKED: Prompt injection detected in field '${injectionResult.field}'`, "error");
			fileLog(`Category: ${firstMatch.category}, Pattern: ${firstMatch.pattern}`, "error");
			logSecurityEvent({
				timestamp: new Date().toISOString(),
				tool: input.tool,
				action: "blocked",
				reason: `Prompt injection in ${injectionResult.field}`,
				category: firstMatch.category,
				pattern: firstMatch.pattern.toString(),
				commandPreview: command
					? redactSecrets(command).slice(0, 100)
					: redactSecrets(
							`${injectionResult.field}:${input.args?.[injectionResult.field]}`
						).slice(0, 100),
			});
			return {
				action: "block",
				reason: `Potential prompt injection detected in field '${injectionResult.field}'`,
				message: "Content appears to contain prompt injection patterns and has been blocked.",
			};
		}

		if (!command) {
			fileLog(`No command extracted from input`, "warn");
			// No command to validate - allow by default (injection check already passed)
			logSecurityEvent({
				timestamp: new Date().toISOString(),
				tool: input.tool,
				action: "allowed",
				reason: "No command extracted",
			});
			return {
				action: "allow",
				reason: "No command to validate",
			};
		}

		fileLog(`Extracted command: ${command}`, "info");

		// Mønstrene matches mot det skallet kjører, ikke mot tekst det bare
		// lagrer (#322): en heredoc-kropp til en fil, argumentene til
		// WriteReflection. Revisjonslinja viser hele kommandoen.
		const kjøres = isShellTool(input.tool.toLowerCase()) ? utenData(command) : command;

		// Check for dangerous patterns (BLOCK)
		const dangerousMatch = matchesDangerousPattern(kjøres);
		if (dangerousMatch) {
			fileLog(`BLOCKED: Dangerous pattern matched: ${dangerousMatch}`, "error");
			logSecurityEvent({
				timestamp: new Date().toISOString(),
				tool: input.tool,
				action: "blocked",
				reason: `Dangerous pattern: ${dangerousMatch}`,
				pattern: dangerousMatch.toString(),
				commandPreview: redactSecrets(command).slice(0, 100),
			});
			return {
				action: "block",
				reason: `Dangerous command pattern detected: ${dangerousMatch}`,
				// Mønsteret står i meldingen, så økten ser hva som slo til
				// i stedet for å gjette og omformulere (#322).
				message: `This command has been blocked for security reasons. It matches a known dangerous pattern: ${dangerousMatch}`,
			};
		}

		// Check for warning patterns (CONFIRM)
		const warningMatch = matchesWarningPattern(kjøres);
		if (warningMatch) {
			fileLog(`CONFIRM: Warning pattern matched: ${warningMatch}`, "warn");
			logSecurityEvent({
				timestamp: new Date().toISOString(),
				tool: input.tool,
				action: "confirmed",
				reason: `Warning pattern: ${warningMatch}`,
				pattern: warningMatch.toString(),
				commandPreview: redactSecrets(command).slice(0, 100),
			});
			return {
				action: "confirm",
				reason: `Potentially dangerous command: ${warningMatch}`,
				message: "This command may have unintended consequences. Please confirm.",
			};
		}

		// Check for sensitive file writes/edits — alle skrivende verktøy og alle
		// stiene de rører (K58): v2s `patch` kan røre flere filer i ett kall.
		// Hvert nivå går gjennom ALLE stiene før det neste, så en advarsel for
		// den første stien ikke skjuler en blokkering for den andre.
		const lowerTool = input.tool.toLowerCase();
		const stier = skrivemål(lowerTool, input.args) ?? [];
		const [verb, verbIng] = SKRIVEETIKETT[lowerTool] ?? ["Write", "Writing to"];

		// Tier 1: precise, unambiguous credential locations - hard block.
		// The user has decided these must be changed by hand, never by an
		// agent, so this is not something to retry another way.
		for (const filePath of stier) {
			const hardBlockMatch = matchesHardBlockPath(filePath);
			if (!hardBlockMatch) continue;
			fileLog(`BLOCKED: Sensitive file ${lowerTool}: ${filePath}`, "error");
			logSecurityEvent({
				timestamp: new Date().toISOString(),
				tool: input.tool,
				action: "blocked",
				reason: `Sensitive file ${lowerTool}: ${filePath}`,
				pattern: hardBlockMatch.toString(),
				commandPreview: `${lowerTool}:${filePath}`.slice(0, 100),
			});
			return {
				action: "block",
				reason: `${verb} target is a credential/secret file: ${filePath}`,
				message:
					"This path stores credentials or secrets. It has been blocked and will not be retried. The user must make this change by hand.",
			};
		}

		// K57: stier brukeren har erklært skrivebeskyttet (et synket speil).
		// Meldingen sier hvor endringen skal gjøres, ellers prøver modellen Bash.
		if (stier.length > 0) {
			const beskyttet = lesSkrivebeskyttet();
			for (const filePath of stier) {
				const beskyttetRot = skrivebeskyttetRot(filePath, beskyttet.stier);
				if (!beskyttetRot) continue;
				fileLog(`BLOCKED: Read-only path ${lowerTool}: ${filePath}`, "error");
				logSecurityEvent({
					timestamp: new Date().toISOString(),
					tool: input.tool,
					action: "blocked",
					reason: `Read-only path ${lowerTool}: ${filePath}`,
					pattern: beskyttetRot,
					commandPreview: `${lowerTool}:${filePath}`.slice(0, 100),
				});
				const kilde = beskyttet.kilde ? ` Kilden: ${beskyttet.kilde}.` : "";
				return {
					action: "block",
					reason: `${verb} target is under a read-only path: ${beskyttetRot}`,
					message: `\`${beskyttetRot}\` er skrivebeskyttet: det er output fra en synk, ikke en arbeidsflate, og lokale endringer der gir konflikter ved neste synk. Ikke skriv dit på en annen måte heller (Bash, cp, sed -i). Endre kilden i stedet; endringen kommer tilbake ved neste synk.${kilde}`,
				};
			}
		}

		// Tier 2: broad heuristics (loose substrings) - signal only, never block.
		for (const filePath of stier) {
			const warnMatch = matchesWarnOnlyPath(filePath);
			if (!warnMatch) continue;
			fileLog(`CONFIRM: Sensitive file ${lowerTool} (heuristic): ${filePath}`, "warn");
			logSecurityEvent({
				timestamp: new Date().toISOString(),
				tool: input.tool,
				action: "confirmed",
				reason: `Sensitive file ${lowerTool} (heuristic): ${filePath}`,
				pattern: warnMatch.toString(),
				commandPreview: `${lowerTool}:${filePath}`.slice(0, 100),
			});
			return {
				action: "confirm",
				reason: `${verbIng} a path matching a broad secret-related heuristic: ${filePath}`,
				message: "This path loosely matches a secret-related pattern. Please confirm.",
			};
		}

		// All checks passed - allow
		fileLog("Security check passed", "debug");
		logSecurityEvent({
			timestamp: new Date().toISOString(),
			tool: input.tool,
			action: "allowed",
			reason: "All security checks passed",
			commandPreview: redactSecrets(command).slice(0, 100),
		});
		return {
			action: "allow",
			reason: "All security checks passed",
		};
	} catch (error) {
		fileLogError("Security validation error", error);
		// Fail-open: on error, allow the operation
		// This is a design decision - fail-closed would be safer but more disruptive
		logSecurityEvent({
			timestamp: new Date().toISOString(),
			tool: input.tool,
			action: "allowed",
			reason: "Security check error - fail-open",
		});
		return {
			action: "allow",
			reason: "Security check error - allowing by default",
		};
	}
}
