/**
 * Work Tracker Handler
 *
 * Equivalent to PAI v2.4 AutoWorkCreation + SessionSummary hooks.
 * Creates and manages work sessions in MEMORY/WORK/
 *
 * @module work-tracker
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import {
	clearCurrentWork,
	ensureDir,
	getCurrentWorkPath,
	getTimestamp,
	getWorkDir,
	getYearMonth,
	setCurrentWorkPath,
	slugify,
} from "../lib/paths";
import { currentHarness } from "../runtime";

// ============================================================================
// TRIVIAL MESSAGE FILTERING
// ============================================================================

/**
 * Ord som alene ikke er arbeid: hilsener, kvitteringer og avskjeder.
 * Aligned with PAI Algorithm depth classification:
 *   MINIMAL depth (greetings, ratings, acknowledgments) = no session.
 */
const TRIVIELLE_ORD = [
	// hilsener
	"h(?:i|ey|ello|owdy)|yo|sup|guten\\s*(?:morgen|tag|abend)|moin|servus|hallo|morning|evening",
	// kvitteringer
	"ok(?:ay)?|thanks?|thx|got\\s*it|sounds?\\s*good|alright|sure|yep|yeah|yes|no|nope|klar|danke|passt|ja|nein|cool|nice|great|perfect|awesome",
	// avskjeder
	"bye|goodbye|ciao|tsch[uü]ss?|see\\s*you|good\\s*night|gn|later",
].join("|");

/**
 * Triviell bare når HELE meldingen er slike ord, med skilletegn imellom
 * («Thanks, sounds good, perfect!»). Mønstrene var forankret bare i starten,
 * så «Ja, kjør gjennom hele kandidatlista» ga ingen arbeidsøkt (M-54).
 * Skillet mellom ordene er alt som ikke er en bokstav eller et tall, og æøå
 * er bokstaver. Et ord må derfor stå helt: «jaså» og «nok» er ikke «ja» og «no».
 */
const BARE_TRIVIELLE_ORD = new RegExp(
	`^(?:${TRIVIELLE_ORD})(?:[^\\p{L}\\p{N}]+(?:${TRIVIELLE_ORD}))*[^\\p{L}\\p{N}]*$`,
	"iu"
);

/** En karakter, med en valgfri kommentar etter: «8», «9/10 - bra». */
const KARAKTER = /^\d{1,2}\s*(\/\s*10)?(\s*[-–—]\s*.{0,80})?$/;

/** Minimum character length for a message to be considered meaningful work */
const MIN_MEANINGFUL_LENGTH = 25;

/**
 * Check if a message is too trivial to warrant a work session.
 *
 * Returns true if the message should NOT create a session.
 * Returns false if the message is meaningful work.
 */
export function isTrivialMessage(content: string): boolean {
	const trimmed = content.trim();

	// Empty or very short messages are trivial
	if (trimmed.length < MIN_MEANINGFUL_LENGTH) {
		// Exception: commands (/) and code snippets should still create sessions
		if (trimmed.startsWith("/") || trimmed.startsWith("!") || trimmed.includes("```")) {
			return false;
		}
		return true;
	}

	// Også over terskelen: en karakter med kommentar, eller bare trivielle ord.
	return KARAKTER.test(trimmed) || BARE_TRIVIELLE_ORD.test(trimmed);
}

// ============================================================================
// WORK SESSION TYPES
// ============================================================================

/**
 * Work session metadata
 */
export interface WorkSession {
	id: string;
	path: string;
	title: string;
	started_at: string;
	status: "ACTIVE" | "COMPLETED";
}

/**
 * Create work session result
 */
export interface CreateWorkResult {
	success: boolean;
	session?: WorkSession;
	error?: string;
}

/**
 * Complete work session result
 */
export interface CompleteWorkResult {
	success: boolean;
	completed_at?: string;
	error?: string;
}

// INGEN modulvariabel for den aktive arbeidsøkten.
//
// Den lå her og var planens «harde blokker». Observert tre ganger i drift:
//   1. To prompts i én TUI-økt delte katalog bare når de delte PROSESS.
//      Startet brukeren TUI-en på nytt imellom, fikk hver sin katalog.
//   2. Variabelen lekket mellom testfiler — bun kjører dem i én prosess, og
//      en fil som etterlot en økt fikk neste til å hoppe over sin egen.
//   3. Claude Code kjører ÉN PROSESS PER HOOK-EVENT. Der ville den alltid
//      vært null, og hver brukermelding hadde fått sin egen arbeidskatalog.
//
// Sannheten ligger nå i `MEMORY/STATE/current-work-<sessionId>.json`.

/**
 * Infer title from user prompt
 * Simple heuristic - first 6 words, cleaned
 *
 * Unicode-klassene, ikke `\w`: den kjenner bare ASCII, så «Kjør» ble «Kj r»
 * i META og THREAD (M-41). Katalognavnet er `slugify` sitt og er fortsatt ASCII.
 */
export function inferTitle(prompt: string): string {
	const words = prompt
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((w) => w.length > 0)
		.slice(0, 6);

	if (words.length === 0) {
		return "work-session";
	}

	return words.join(" ");
}

/**
 * Create a new work session
 *
 * Called on first user prompt if no active session exists.
 * Creates MEMORY/WORK/{timestamp}_{title}/ structure.
 *
 * @param prompt - The user prompt that triggered session creation.
 * @param sessionId - OpenCode session ID. Pass this so the resulting state is
 *   session-scoped (required for compaction-intelligence.ts and
 *   algorithm-tracker.ts to find it, and for session-cleanup.ts's cross-session
 *   guard to be meaningful). Omitting it preserves the pre-fix legacy-only
 *   behavior — nothing breaks, but the state stays unscoped.
 */
export async function createWorkSession(
	prompt: string,
	sessionId?: string
): Promise<CreateWorkResult> {
	try {
		// Gjenbruk når tilstandsfila sier at en økt er i gang.
		//
		// Betingelsen var `existingPath && currentSession`. Minnedelen gjorde
		// at en ny prosess ikke så en helt gyldig arbeidsøkt på disk og
		// opprettet en ny ved siden av. Nå avgjør disken alene.
		const existingPath = await getCurrentWorkPath(sessionId);
		if (existingPath) {
			const eksisterende = await readSessionAt(existingPath);
			if (eksisterende) {
				fileLog("Work session already exists, reusing", "debug");
				return { success: true, session: eksisterende };
			}
			// Tilstanden peker på noe som ikke lenger er lesbart. Å gjenbruke
			// den ville gitt en økt uten META; å falle gjennom lager en ny.
			fileLog(`Work state peker på uleselig økt (${existingPath}) — lager ny`, "warn");
		}

		// Create session directory
		const workRoot = getWorkDir();
		const yearMonth = getYearMonth();
		const timestamp = getTimestamp();
		const title = inferTitle(prompt);
		const slug = slugify(title);
		// NOTE: this is the *work session's own* id (timestamp_slug, used for the
		// directory name) — distinct from the OpenCode `sessionId` parameter above,
		// which scopes the current-work state file.
		const workSessionId = `${timestamp}_${slug}`;

		const relativeDir = path.join(yearMonth, workSessionId);
		const sessionPath = path.join(workRoot, relativeDir);
		await ensureDir(sessionPath);

		// Create subdirectories
		await ensureDir(path.join(sessionPath, "tasks"));
		await ensureDir(path.join(sessionPath, "scratch"));

		// Single default task per session. response-capture.ts's updateTaskISC
		// expects a real folder at tasks/{current_task}/ containing ISC.json, and
		// teardown's markThreadsCompleted flips the task's THREAD.md.
		const currentTask = "main";
		const taskPath = path.join(sessionPath, "tasks", currentTask);
		await ensureDir(taskPath);

		// Create META.yaml
		const meta = {
			status: "ACTIVE",
			started_at: new Date().toISOString(),
			title: title,
			session_id: workSessionId,
		};

		// `harness` er ADDITIVT. MEMORY-treet deles mellom motorene, og uten
		// feltet er det umulig å se i ettertid hvilken som produserte en
		// arbeidsøkt. Lagt sist, så eksisterende parsing er upåvirket.
		await fs.promises.writeFile(
			path.join(sessionPath, "META.yaml"),
			`status: ${meta.status}\nstarted_at: ${meta.started_at}\ntitle: "${meta.title}"\nsession_id: ${meta.session_id}\nharness: ${currentHarness()}\n`
		);

		// Create empty ISC.json (session-level, read by isc-validator.ts, and
		// task-level, updated by response-capture.ts's updateTaskISC)
		const emptyIsc = JSON.stringify({ criteria: [], anti_criteria: [] }, null, 2);
		await fs.promises.writeFile(path.join(sessionPath, "ISC.json"), emptyIsc);
		await fs.promises.writeFile(path.join(taskPath, "ISC.json"), emptyIsc);

		// Create THREAD.md (session-level and task-level, same reasoning as above)
		const threadHeader = `# ${title}\n\n**Started:** ${meta.started_at}\n**Status:** ACTIVE\n\n---\n\n`;
		await fs.promises.writeFile(path.join(sessionPath, "THREAD.md"), threadHeader);
		await fs.promises.writeFile(path.join(taskPath, "THREAD.md"), threadHeader);

		// Update state — session-scoped when sessionId is known (see lib/paths.ts)
		await setCurrentWorkPath(relativeDir, sessionId, { currentTask });

		const session: WorkSession = {
			id: workSessionId,
			path: sessionPath,
			title: title,
			started_at: meta.started_at,
			status: "ACTIVE",
		};

		fileLog(`Work session created: ${workSessionId}`, "info");

		return { success: true, session };
	} catch (error) {
		fileLogError("Failed to create work session", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Les META.yaml for en arbeidskatalog og bygg en WorkSession.
 *
 * Bevisst enkel parsing: META.yaml skrives av `createWorkSession` én linje
 * per felt, og å dra inn en YAML-parser for fire nøkler ville vært å bytte
 * en kjent form mot en ukjent avhengighet.
 */
async function readSessionAt(sessionPath: string): Promise<WorkSession | null> {
	try {
		const innhold = await fs.promises.readFile(path.join(sessionPath, "META.yaml"), "utf-8");
		const felt = (navn: string): string => {
			const treff = innhold.match(new RegExp(`^${navn}:\\s*"?([^"\\n]*)"?\\s*$`, "m"));
			return treff?.[1]?.trim() ?? "";
		};
		const id = felt("session_id") || path.basename(sessionPath);
		return {
			id,
			path: sessionPath,
			title: felt("title") || id,
			started_at: felt("started_at"),
			status: felt("status") === "COMPLETED" ? "COMPLETED" : "ACTIVE",
		};
	} catch {
		// Katalogen eller META er borte. Kalleren behandler det som «ingen økt».
		return null;
	}
}

/**
 * Hent den aktive arbeidsøkten for en motorsesjon.
 *
 * ASYNC OG FILBASERT, ikke et minneoppslag. Det er hele poenget med batch 5:
 * svaret må være det samme uansett hvilken prosess som spør, fordi Claude
 * Code kjører én prosess per hook-event og OpenCode kan starte på nytt midt
 * i en økt.
 *
 * @param sessionId Motorens sesjons-ID. Utelates den, leses legacy-speilet —
 *   og det er nettopp tvetydigheten batch 5 fjerner. Alle kallsteder i
 *   kjernen sender den.
 */
export async function getCurrentSession(sessionId?: string): Promise<WorkSession | null> {
	const sessionPath = await getCurrentWorkPath(sessionId);
	if (!sessionPath) return null;
	return await readSessionAt(sessionPath);
}

/**
 * Complete the current work session
 *
 * Called at session end. Updates META.yaml with completion timestamp.
 *
 * @param sessionId - OpenCode session ID, to locate the right session-scoped
 *   state (see createWorkSession). Omit to fall back to the legacy global state.
 */
export async function completeWorkSession(sessionId?: string): Promise<CompleteWorkResult> {
	try {
		const sessionPath = await getCurrentWorkPath(sessionId);
		if (!sessionPath) {
			fileLog("No active work session to complete", "debug");
			return { success: true };
		}

		// Arbeidskatalogen er borte — tilstanden er foreldreløs.
		//
		// Uten denne vakten kaster META-skrivingen, `clearCurrentWork` nås
		// aldri, og tilstandsfila blir liggende. Reaperen kjører ved hver
		// oppstart, så den ville prøvd på den samme døde fila for alltid.
		// Observert: ni slike filer pekte på testkataloger som var slettet.
		if (!fs.existsSync(sessionPath)) {
			fileLog(`Work dir gone, clearing orphaned state: ${sessionPath}`, "warn");
			await clearCurrentWork(sessionId);
			return { success: true };
		}

		const metaPath = path.join(sessionPath, "META.yaml");
		const completed_at = new Date().toISOString();

		// Read existing meta. Bare «finnes ikke» gir tomt innhold. En annen
		// lesefeil (EACCES, EIO, EMFILE) kastes videre: med tomt innhold ville
		// skrivingen under ha erstattet hele META.yaml med én `completed_at`-linje
		// (M-05). Tilstanden blir da stående, og reaperen prøver igjen.
		let metaContent = "";
		try {
			metaContent = await fs.promises.readFile(metaPath, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		// Allerede fullført? Rydd tilstanden, men IKKE skriv på nytt.
		//
		// Uten denne vakten appendes en ny `completed_at` for hvert kall, og
		// `status: ACTIVE`-erstatningen treffer ingenting. H-12 kalte denne
		// funksjonen etter hver assistenttur, og resultatet står i treet: 13
		// META.yaml med dobbel `completed_at`. Reaperen kan møte det samme,
		// siden den per definisjon kjører på økter ingen ryddet etter.
		if (/^completed_at:/m.test(metaContent)) {
			fileLog(`Work session already completed: ${sessionPath}`, "debug");
			await clearCurrentWork(sessionId);
			return { success: true };
		}

		// Update status
		metaContent = metaContent.replace(/status: ACTIVE/, "status: COMPLETED").trim();
		metaContent += `\ncompleted_at: ${completed_at}\n`;

		await fs.promises.writeFile(metaPath, metaContent);
		await markThreadsCompleted(sessionPath);

		// Clear state
		await clearCurrentWork(sessionId);

		fileLog(`Work session completed: ${sessionPath}`, "info");

		return { success: true, completed_at };
	} catch (error) {
		fileLogError("Failed to complete work session", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Sett headeren i THREAD.md til COMPLETED, på øktnivå og for hver oppgave.
 *
 * Headeren skrives én gang ved opprettelse. Uten dette sto den på ACTIVE for
 * alltid, og en leser av THREAD alene trodde økten pågikk (M-18). Bare den
 * FØRSTE forekomsten byttes: det er headeren, og samme tekst lenger ned er
 * innhold. Best effort — en THREAD som mangler, stopper ikke fullføringen.
 */
async function markThreadsCompleted(sessionPath: string): Promise<void> {
	const tråder = [path.join(sessionPath, "THREAD.md")];
	try {
		for (const oppgave of await fs.promises.readdir(path.join(sessionPath, "tasks"))) {
			tråder.push(path.join(sessionPath, "tasks", oppgave, "THREAD.md"));
		}
	} catch {
		// Ingen tasks/ — bare øktnivået.
	}
	for (const tråd of tråder) {
		try {
			const innhold = await fs.promises.readFile(tråd, "utf-8");
			const ny = innhold.replace("**Status:** ACTIVE", "**Status:** COMPLETED");
			if (ny !== innhold) await fs.promises.writeFile(tråd, ny);
		} catch {
			// Finnes ikke eller uleselig: META er sannheten, THREAD er visning.
		}
	}
}

/**
 * Append to THREAD.md
 *
 * @param sessionId - OpenCode session ID, to locate the right session-scoped
 *   state (see createWorkSession). Omit to fall back to the legacy global state.
 */
export async function appendToThread(content: string, sessionId?: string): Promise<void> {
	const sessionPath = await getCurrentWorkPath(sessionId);
	if (!sessionPath) return;

	const threadPath = path.join(sessionPath, "THREAD.md");

	try {
		await fs.promises.appendFile(threadPath, `\n${content}\n`);
	} catch (error) {
		fileLogError("Failed to append to THREAD.md", error);
	}
}

/**
 * Update ISC.json with criteria from the Algorithm's TaskCreate/TodoWrite.
 *
 * Called by algorithm-tracker.ts when ISC criteria are created/updated.
 * Bridges the gap between the Algorithm's working memory (TodoWrite) and
 * the persistent work session (ISC.json on disk).
 *
 * @param sessionId - OpenCode session ID, to locate the right session-scoped
 *   state (see createWorkSession). Omit to fall back to the legacy global state.
 */
export async function updateISC(
	criteria: { description: string; status: string; priority?: string }[],
	sessionId?: string
): Promise<void> {
	const sessionPath = await getCurrentWorkPath(sessionId);
	if (!sessionPath) return;

	const iscPath = path.join(sessionPath, "ISC.json");

	try {
		// Separate criteria from anti-criteria based on ISC naming convention
		const regular = criteria.filter((c) => !c.description.includes("ISC-A"));
		const anti = criteria.filter((c) => c.description.includes("ISC-A"));

		const isc = {
			criteria: regular,
			anti_criteria: anti,
			total: criteria.length,
			completed: criteria.filter((c) => c.status === "completed").length,
			updated_at: new Date().toISOString(),
		};
		await fs.promises.writeFile(iscPath, JSON.stringify(isc, null, 2));
	} catch (error) {
		fileLogError("Failed to update ISC.json", error);
	}
}
