/**
 * Session Registry Handler
 *
 * Tracks subagent sessions spawned via Task tool and provides
 * two custom tools for the Algorithm to recover session data
 * after context compaction.
 *
 * TOOLS PROVIDED:
 * - session_registry: Lists all subagent sessions with metadata for current session
 * - session_results: Gets registry metadata for a subagent + resume instructions
 *
 * HOOKS USED:
 * - tool.execute.after (tool === "task"): Captures session_id from Task tool output,
 *   extracts metadata, writes to local registry file
 *
 * @module session-registry
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import { getStateDir } from "../lib/paths";
import { somObjekt, somTekst } from "../lib/payload";

// --- Types ---

interface SubagentEntry {
	sessionId: string;
	agentType: string;
	description: string;
	spawnedAt: string;
	status: "running" | "completed" | "failed";
	/**
	 * Hvor `agent-capture` la subagentens faktiske svar.
	 *
	 * Uten stien kan `session_results` bare returnere metadata og be
	 * brukeren gjenoppta subagenten — som er nøyaktig det OpenCode-verktøyet
	 * gjorde, og som ikke er mulig i Claude Code. Med stien returnerer det
	 * svaret selv.
	 *
	 * Valgfritt: eldre oppføringer har den ikke, og en subagent som svarte
	 * tomt får aldri noen fil.
	 */
	outputPath?: string;
}

export interface SubagentRegistry {
	parentSessionId: string;
	entries: SubagentEntry[];
	updatedAt: string;
	version: number;
}

// --- Registry File Operations ---

export function getRegistryPath(sessionId: string): string {
	return path.join(getStateDir(), `subagent-registry-${sessionId}.json`);
}

function normalizeRegistry(data: unknown, sessionId: string): SubagentRegistry {
	const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
	return {
		parentSessionId: typeof obj.parentSessionId === "string" ? obj.parentSessionId : sessionId,
		entries: Array.isArray(obj.entries)
			? (obj.entries as unknown[]).filter(
					(e): e is SubagentEntry =>
						!!e &&
						typeof e === "object" &&
						typeof (e as Record<string, unknown>).sessionId === "string" &&
						typeof (e as Record<string, unknown>).agentType === "string" &&
						typeof (e as Record<string, unknown>).description === "string" &&
						typeof (e as Record<string, unknown>).spawnedAt === "string" &&
						(["running", "completed", "failed"] as const).includes(
							(e as Record<string, unknown>).status as SubagentEntry["status"]
						)
				)
			: [],
		updatedAt:
			typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
		version: typeof obj.version === "number" ? obj.version : 0,
	};
}

export function readRegistry(sessionId: string): SubagentRegistry {
	const filePath = getRegistryPath(sessionId);
	if (!fs.existsSync(filePath)) {
		return {
			parentSessionId: sessionId,
			entries: [],
			updatedAt: new Date().toISOString(),
			version: 0,
		};
	}

	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (err) {
		// I/O error (e.g. EACCES) — propagate so the caller knows the registry is inaccessible
		fileLog(`[session-registry] Failed to read registry at ${filePath}: ${err}`, "error");
		throw err;
	}

	try {
		const data = JSON.parse(raw);
		return normalizeRegistry(data, sessionId);
	} catch (err) {
		if (err instanceof SyntaxError) {
			fileLog(`[session-registry] Corrupted registry file at ${filePath} — starting fresh`, "warn");
			return {
				parentSessionId: sessionId,
				entries: [],
				updatedAt: new Date().toISOString(),
				version: 0,
			};
		}
		throw err;
	}
}

/** En lås eldre enn dette er etterlatt av en prosess som døde mens den skrev. */
export const REGISTRY_LOCK_STALE_MS = 10_000;

/**
 * Ta låsen `<register>.lock` med `wx`. `false` når en annen prosess har den.
 *
 * Uten låsen var sjekk-og-skriv to steg: to prosesser kunne begge lese
 * versjon N, begge bestå sjekken og begge skrive N+1, og den ene
 * oppføringen forsvant (M-07). Med låsen er sjekken og renamet ett steg.
 */
function acquireRegistryLock(lockPath: string): boolean {
	try {
		fs.closeSync(fs.openSync(lockPath, "wx"));
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	try {
		if (Date.now() - fs.statSync(lockPath).mtimeMs > REGISTRY_LOCK_STALE_MS) {
			fs.unlinkSync(lockPath);
			fileLog(`[session-registry] Fjernet etterlatt lås ${lockPath}`, "warn");
		}
	} catch {
		// Låsen forsvant imens — neste forsøk tar den.
	}
	return false;
}

/**
 * Write registry with compare-and-swap semantics, under a lock file.
 * Returns true if write succeeded, false if version mismatch or the lock is
 * held (caller should retry).
 * Throws on I/O errors (e.g. ENOSPC, EACCES) — these are not retryable CAS conflicts.
 */
function writeRegistryAtomic(
	sessionId: string,
	registry: SubagentRegistry,
	expectedVersion: number
): boolean {
	const filePath = getRegistryPath(sessionId);
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

	const lockPath = `${filePath}.lock`;
	if (!acquireRegistryLock(lockPath)) return false;
	try {
		return writeUnderLock(sessionId, filePath, registry, expectedVersion);
	} finally {
		try {
			fs.unlinkSync(lockPath);
		} catch {}
	}
}

function writeUnderLock(
	sessionId: string,
	filePath: string,
	registry: SubagentRegistry,
	expectedVersion: number
): boolean {
	const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

	// Check current version before writing (compare-and-swap)
	const current = readRegistry(sessionId);
	if (current.version !== expectedVersion) {
		return false; // Version mismatch - caller should retry
	}

	// Increment version for new write
	registry.version = expectedVersion + 1;
	registry.updatedAt = new Date().toISOString();

	try {
		// Write to temp file
		fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2), "utf-8");
		// Atomic rename
		fs.renameSync(tempPath, filePath);
		return true;
	} catch (err) {
		// Cleanup temp file, then rethrow — I/O errors are not CAS conflicts
		try {
			if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
		} catch {}
		throw err;
	}
}

// --- Task Tool Output Parser ---

/**
 * Sanitize text for Markdown display.
 * - Replace newlines with spaces
 * - Collapse consecutive whitespace
 * - Trim
 * - Escape pipe characters (for tables)
 * - Truncate to max length
 */
export function sanitizeForMarkdown(text: string, maxLength = 60, escapePipes = true): string {
	let sanitized = text.replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ").trim();

	if (escapePipes) {
		sanitized = sanitized.replace(/\|/g, "\\|");
	}

	return sanitized.substring(0, maxLength);
}

/**
 * Extract agent type and description from Task tool args.
 */
export function extractTaskInfo(args: unknown): {
	agentType: string;
	description: string;
} {
	const a = somObjekt(args);
	return {
		agentType: somTekst(a.subagent_type) || somTekst(a.agent) || "unknown",
		description: somTekst(a.description) || somTekst(a.prompt).substring(0, 100) || "unknown task",
	};
}

/**
 * Muter registeret under compare-and-swap, med samme retry som v1s
 * Task-fangst alltid brukte.
 *
 * Trukket ut fordi batch 7 ga registeret to skrivere til, og tre kopier av
 * en CAS-løkke er tre steder å glemme et retry-tak. Callbacken returnerer
 * `false` når det ikke er noe å skrive — da hoppes skrivingen over uten at
 * versjonen brennes.
 *
 * SKRIVERNE ER NÅ I ULIKE PROSESSER. Under Claude Code kommer
 * `SubagentStart` og `SubagentStop` fra hver sin hook-prosess, så CAS er
 * ikke lenger en forsiktighet mot samtidighet i én prosess — den er det
 * eneste som holder to ekte prosesser fra å overskrive hverandre.
 */
async function mutateRegistry(
	sessionId: string,
	endre: (registry: SubagentRegistry) => boolean
): Promise<boolean> {
	let retries = 5;
	while (retries > 0) {
		const registry = readRegistry(sessionId);
		const expectedVersion = registry.version;

		if (!endre(registry)) return false;

		if (writeRegistryAtomic(sessionId, registry, expectedVersion)) return true;

		retries--;
		if (retries > 0) {
			fileLog(
				`[SessionRegistry] Registry version conflict, re-reading and retrying... (${retries} left)`,
				"warn"
			);
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	fileLogError(
		"[SessionRegistry] Failed to write registry after retries",
		new Error("Compare-and-swap failed")
	);
	return false;
}

/**
 * Registrer en subagent som NETTOPP startet.
 *
 * Kun Claude Code — se kapabiliteten `subagentEvents`. Dette er forskjellen
 * `SubagentStart` gjør: `captureSubagentSession` kjører først når Task-kallet
 * er ferdig, så en subagent som krasjer underveis kom aldri inn i registeret
 * i det hele tatt. Nå står den der som `running` fra spawn-øyeblikket, og
 * blir stående hvis den aldri fullfører — som er nøyaktig det signalet som
 * manglet.
 *
 * `agentType` kommer fra motoren, ikke fra `args.subagent_type`, og kan
 * derfor ikke bli `unknown`.
 */
export async function registerSubagentStart(
	parentSessionId: string,
	agentId: string,
	agentType: string,
	description = ""
): Promise<void> {
	if (!agentId) {
		fileLog("[SessionRegistry] SubagentStart uten agent_id — hopper over", "warn");
		return;
	}

	try {
		const skrevet = await mutateRegistry(parentSessionId, (registry) => {
			if (registry.entries.some((e) => e.sessionId === agentId)) {
				fileLog(`[SessionRegistry] Subagent ${agentId} allerede registrert`, "debug");
				return false;
			}
			registry.entries.push({
				sessionId: agentId,
				agentType: agentType || "unknown",
				description: description || "subagent",
				spawnedAt: new Date().toISOString(),
				status: "running",
			});
			return true;
		});
		if (skrevet) {
			fileLog(`[SessionRegistry] Subagent ${agentType} startet: ${agentId}`, "info");
		}
	} catch (error) {
		fileLogError("[SessionRegistry] registerSubagentStart feilet", error);
	}
}

/**
 * Sett sluttstatus på en subagent.
 *
 * Oppretter oppføringen hvis `SubagentStart` aldri kom fram — et tapt
 * startsignal skal ikke gi et tomt register, og stoppsignalet bærer de
 * samme feltene.
 */
export async function markSubagentStopped(
	parentSessionId: string,
	agentId: string,
	agentType: string,
	status: "completed" | "failed" = "completed"
): Promise<void> {
	if (!agentId) {
		fileLog("[SessionRegistry] SubagentStop uten agent_id — hopper over", "warn");
		return;
	}

	try {
		await mutateRegistry(parentSessionId, (registry) => {
			const oppføring = registry.entries.find((e) => e.sessionId === agentId);
			if (oppføring) {
				if (oppføring.status === status) return false;
				oppføring.status = status;
				return true;
			}
			registry.entries.push({
				sessionId: agentId,
				agentType: agentType || "unknown",
				description: "subagent",
				spawnedAt: new Date().toISOString(),
				status,
			});
			return true;
		});
		fileLog(`[SessionRegistry] Subagent ${agentId} → ${status}`, "info");
	} catch (error) {
		fileLogError("[SessionRegistry] markSubagentStopped feilet", error);
	}
}

/**
 * Fest stien til subagentens fangede svar på registeroppføringen.
 *
 * Skilt fra `markSubagentStopped` fordi fangsten skjer ETTER at statusen er
 * satt: statusen skal stå selv om fangsten feiler, ellers ville en subagent
 * som svarte tomt blitt stående som `running` for alltid.
 */
export async function setSubagentOutputPath(
	parentSessionId: string,
	agentId: string,
	outputPath: string
): Promise<void> {
	if (!agentId || !outputPath) return;
	try {
		await mutateRegistry(parentSessionId, (registry) => {
			const oppføring = registry.entries.find((e) => e.sessionId === agentId);
			if (!oppføring || oppføring.outputPath === outputPath) return false;
			oppføring.outputPath = outputPath;
			return true;
		});
	} catch (error) {
		fileLogError("[SessionRegistry] setSubagentOutputPath feilet", error);
	}
}

// --- Custom Tools ---


/**
 * Build formatted registry context for compaction injection.
 * Called by WP-N2 compaction intelligence handler.
 */
export function buildRegistryContext(sessionId: string): string | null {
	let registry: SubagentRegistry;
	try {
		registry = readRegistry(sessionId);
	} catch (err) {
		fileLog(`[session-registry] buildRegistryContext: failed to read registry: ${err}`, "error");
		return null;
	}
	if (registry.entries.length === 0) return null;

	const lines = [
		"## Active Subagent Registry",
		"",
		"The following subagent sessions were spawned during this session.",
		"Their data is stored in OpenCode's database and survives compaction.",
		"Use `session_registry` tool to list them, `session_results` to view metadata and resume hints.",
		"",
	];

	for (const e of registry.entries) {
		const sanitizedDesc = sanitizeForMarkdown(e.description, 80, false);
		lines.push(`- **${e.agentType}** (${e.sessionId}): ${sanitizedDesc}`);
	}

	return lines.join("\n");
}
