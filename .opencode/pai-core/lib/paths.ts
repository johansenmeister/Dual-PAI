/**
 * PAI-OpenCode Path Utilities
 *
 * Canonical path construction for MEMORY, WORK, LEARNING directories.
 * Mirrors PAI v2.4 hooks/lib/paths.ts
 *
 * @module paths
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { currentHarness, sessionKeyFor } from "../runtime";
import { fileLog } from "./file-logger";

/**
 * Read the PAI_HOME override.
 *
 * Single point of control for where PAI keeps its tree. Empty/whitespace is
 * treated as unset so an exported-but-blank variable can't silently redirect
 * MEMORY. Returns null when the caller should fall back to its own default.
 */
function paiHomeOverride(): string | null {
	const raw = process.env.PAI_HOME;
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Get the PAI home directory — cwd-anchored.
 *
 * Resolution: PAI_HOME → cwd/.opencode → $HOME/.opencode → cwd/.opencode.
 * The last step is deliberate: callers create the tree when it's missing.
 *
 * NOTE: this repo has TWO historical resolution strategies. This one prefers
 * cwd; getHomePaiDir() is anchored to $HOME. They are kept apart on purpose —
 * unifying them is a behaviour change, not a refactor, and belongs with the
 * state hygiene in batch 5. Setting PAI_HOME collapses them to one path.
 */
export function getPaiHome(): string {
	const override = paiHomeOverride();
	if (override) return override;

	const cwdPath = path.join(process.cwd(), ".opencode");
	if (fs.existsSync(cwdPath)) {
		return cwdPath;
	}

	const homePath = path.join(os.homedir(), ".opencode");
	if (fs.existsSync(homePath)) {
		return homePath;
	}

	// Default to cwd even if doesn't exist (will be created)
	return cwdPath;
}

/**
 * Get the PAI home directory — $HOME-anchored, no cwd probing.
 *
 * For readers that have always resolved against $HOME/.opencode regardless of
 * where the process was started: identity.ts (settings.json) and db-utils.ts
 * (conversations.db). Honours PAI_HOME so the override still reaches them.
 */
export function getHomePaiDir(): string {
	return paiHomeOverride() ?? path.join(os.homedir(), ".opencode");
}

/**
 * Get the OpenCode directory path
 * Tries cwd first, then home directory
 *
 * @deprecated Bruk getPaiHome(). Beholdt som alias for eksisterende kallsteder.
 */
export function getOpenCodeDir(): string {
	return getPaiHome();
}

/**
 * Get MEMORY directory path
 */
export function getMemoryDir(): string {
	return path.join(getOpenCodeDir(), "MEMORY");
}

/**
 * Get WORK directory path (for session tracking)
 */
export function getWorkDir(): string {
	return path.join(getMemoryDir(), "WORK");
}

/**
 * Get LEARNING directory path
 */
export function getLearningDir(): string {
	return path.join(getMemoryDir(), "LEARNING");
}

/**
 * Get RESEARCH directory path (for agent outputs)
 */
export function getResearchDir(): string {
	return path.join(getMemoryDir(), "RESEARCH");
}

/**
 * Get STATE directory path
 */
export function getStateDir(): string {
	return path.join(getMemoryDir(), "STATE");
}

/**
 * Get current year-month string (YYYY-MM)
 */
export function getYearMonth(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	return `${year}-${month}`;
}

/**
 * Get ISO timestamp for filenames
 */
export function getTimestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * Get date string (YYYY-MM-DD)
 */
export function getDateString(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Generate session ID from timestamp
 */
export function generateSessionId(): string {
	const now = new Date();
	const timestamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const random = Math.random().toString(36).substring(2, 6);
	return `${timestamp}_${random}`;
}

/**
 * Ensure directory exists
 */
export async function ensureDir(dirPath: string): Promise<void> {
	await fs.promises.mkdir(dirPath, { recursive: true });
}

/**
 * Filename patterns for session-scoped state files.
 *
 * Centralized here so readers (compaction-intelligence.ts, session-cleanup.ts,
 * response-capture.ts, algorithm-tracker.ts) and writers
 * (this module, algorithm-tracker.ts) can never drift apart again — that drift
 * (readers expecting `current-work-${sessionId}.json` / `algorithm-state-${sessionId}.json`
 * while nothing wrote them) is what commit 68cfb0a's session-isolation fix left behind.
 */
/**
 * Hvor gammel en pid-løs arbeidsøkt må være før den regnes som forlatt.
 *
 * Gjelder KUN tilstand skrevet før `pid`-feltet fantes. Seks timer er
 * rikelig for en reell økt og kort nok til at etterslepet ryddes.
 */
const LEGACY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Les `starttime` (felt 22) fra `/proc/<pid>/stat`.
 *
 * Feltet er antall klokketikk siden oppstart og er det som skiller en ekte
 * prosess fra en som har arvet PID-en. `comm` (felt 2) kan inneholde både
 * mellomrom og parenteser, så parsingen starter etter SISTE `)`.
 *
 * Returnerer null utenfor Linux eller når prosessen ikke finnes — kallere
 * må tåle at vakten ikke er tilgjengelig.
 */
export function readProcessStart(pid: number): string | null {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
		const etterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		// Etter `)` er indeks 0 felt 3 (state), så starttime (felt 22) er indeks 19.
		return etterComm[19] ?? null;
	} catch {
		return null;
	}
}

/**
 * Lever prosessen som eide denne arbeidsøkten fortsatt?
 *
 * Fail-safe mot å drepe levende tilstand: er vi i tvil, svarer vi «lever».
 * En arbeidsøkt som fullføres for sent er en kosmetisk feil; én som
 * fullføres mens den er i bruk ødelegger brukerens pågående arbeid.
 */
export function isOwnerAlive(
	pid: number | undefined,
	pidStart: string | undefined,
	startedAt?: string
): boolean {
	if (typeof pid !== "number" || pid <= 0) {
		// Tilstand uten pid. `setCurrentWorkPath` skriver alltid feltet, så
		// dette er enten en fil fra før feltet fantes, eller en skriver som
		// har glemt det. Alderen avgjør: en arbeidsøkt som ble startet for
		// mer enn LEGACY_MAX_AGE_MS siden og fortsatt har en tilstandsfil,
		// er forlatt. Fallbacken pensjonerer seg selv — nye filer har pid.
		const start = startedAt ? Date.parse(startedAt) : Number.NaN;
		if (Number.isNaN(start)) return true;
		return Date.now() - start < LEGACY_MAX_AGE_MS;
	}

	try {
		// Signal 0 tester kun eksistens og rettigheter, sender ingenting.
		process.kill(pid, 0);
	} catch {
		return false;
	}

	// Prosessen finnes. Er det den SAMME prosessen?
	const nåværende = readProcessStart(pid);
	if (pidStart === undefined || nåværende === null) {
		// Ingen vakt tilgjengelig. PID-en finnes, så vi antar levende.
		return true;
	}
	return nåværende === pidStart;
}

/**
 * Prosessen som EIER arbeidsøkten — den reaperen sjekker liveness på.
 *
 * `process.pid` er riktig svar under OpenCode, der pluginen lever i
 * motorprosessen hele økten. Det er FEIL svar under Claude Code, som kjører
 * én prosess per hook-event: hook-prosessen er død millisekunder etter at
 * den skrev fila, og neste `SessionStart` ville da reapet en økt brukeren
 * fortsatt sitter i. Det er den dyreste feilen reaperen kan gjøre — derfor
 * er retningen på fail-safe i `isOwnerAlive` som den er.
 *
 * Adapteren vet hvilken prosess som eier økten; kjernen gjør det ikke. Så
 * adapteren sier fra gjennom miljøet, på linje med `PAI_HOME`,
 * `PAI_HARNESS` og `PAI_ENABLED`:
 *
 *   uvalgt       `process.pid` — OpenCode-oppførselen, bit for bit uendret
 *   et tall      den PID-en, med `starttime` lest fra /proc
 *   noe annet    INGEN pid skrives
 *
 * Det siste tilfellet er ikke en feilsti, men adapterens måte å si «jeg fant
 * ingen eier jeg stoler på». Uten pid faller `isOwnerAlive` tilbake på
 * alderen (`LEGACY_MAX_AGE_MS`), som er treg men trygg. Å skrive en PID vi
 * vet er død ville vært verre enn å ikke skrive noen.
 */
export function ownerProcess(): { pid?: number; start?: string } {
	const rå = process.env.PAI_OWNER_PID;
	if (typeof rå !== "string" || rå.trim().length === 0) {
		return { pid: process.pid, start: readProcessStart(process.pid) ?? undefined };
	}

	const pid = Number.parseInt(rå.trim(), 10);
	if (!Number.isInteger(pid) || pid <= 0) {
		return {};
	}

	// `starttime` leses fortrinnsvis fra /proc nå. Adapteren kan ha målt den
	// på et tidligere tidspunkt og sendt den med i PAI_OWNER_PID_START; den
	// brukes kun hvis /proc ikke svarer, slik at verdien aldri blir eldre enn
	// nødvendig.
	const fraProc = readProcessStart(pid);
	const fraMiljø = process.env.PAI_OWNER_PID_START?.trim();
	return { pid, start: fraProc ?? (fraMiljø && fraMiljø.length > 0 ? fraMiljø : undefined) };
}

export function getCurrentWorkStateFile(sessionId: string): string {
	return path.join(getStateDir(), `current-work-${sessionId}.json`);
}

export function getAlgorithmStateFile(sessionId: string): string {
	return path.join(getStateDir(), `algorithm-state-${sessionId}.json`);
}

/**
 * Skjemaet i `current-work-${sessionId}.json`.
 *
 * Det finnes ingen uskopet variant lenger. `current-work.json` var en felles
 * skuff alle økter skrev i, og lesere uten sesjons-ID kunne få en annens
 * arbeidskatalog i retur — en garantert kollisjon når to harness deler
 * MEMORY-treet.
 */
export interface CurrentWorkState {
	session_id: string;
	/** WORK-dir-relative path, e.g. "2026-03/20260311143522_fix-something". */
	work_dir: string;
	/** Alias of work_dir kept for readers that only know the `session_dir` key. */
	session_dir: string;
	current_task: string;
	started_at: string;
	/**
	 * PID-en til motorprosessen som eier denne arbeidsøkten.
	 *
	 * Grunnlaget for reaperen. OpenCode har ingen sesjonsslutt-hendelse
	 * (`session.ended` finnes ikke i binæren), så det eneste pålitelige
	 * svaret på «lever økten fortsatt?» er om prosessen gjør det.
	 */
	pid?: number;
	/**
	 * `starttime` fra `/proc/<pid>/stat`, som vakt mot PID-gjenbruk.
	 *
	 * Uten den ville en ny prosess som tilfeldigvis arver PID-en få en
	 * foreldreløs arbeidsøkt til å se levende ut — og den ville aldri blitt
	 * fullført. Mangler feltet (eller er vi ikke på Linux), faller
	 * liveness-sjekken tilbake på PID alene.
	 */
	pid_start?: string;
	/**
	 * `sessionKeyFor(harness, session_id)` — nøkkelen meldingsbufferne og
	 * dedupe-tilstanden ligger under.
	 *
	 * Reaperen trenger den. Den finner økten via FILNAVNET, som bærer rå
	 * sessionId, og vet ikke hvilken motor som skrev det; uten nøkkelen kunne
	 * den verken hente meldingene til RELATIONSHIP-uttrekket eller rydde
	 * `msgbuf-`/`dedupe-`, som da ble liggende til `pruneStaleState` tok dem
	 * etter 24 t. Skrives av prosessen som eier økten, så den er riktig per
	 * konstruksjon — ikke gjettet i ettertid. Mangler på eldre filer.
	 */
	session_key?: string;
}

/**
 * Resolve a stored work/session dir to an absolute path.
 *
 * Historically `work_dir` was written as an ABSOLUTE path by setCurrentWorkPath,
 * which every reader *except* this module's own getCurrentWorkPath() joined with
 * getWorkDir() again (a latent double-join bug — see
 * session-cleanup.ts). New writes store a WORK-dir-relative path instead, which is
 * what those readers actually expect. Accepting both keeps pre-existing on-disk
 * state (written before this fix) working.
 */
export function resolveSessionDir(workDirOrRelative: string): string | null {
	const root = getWorkDir();
	const resolved = path.isAbsolute(workDirOrRelative)
		? path.resolve(workDirOrRelative)
		: path.resolve(root, workDirOrRelative);
	if (liggerUnder(root, resolved)) return resolved;
	fileLog(`[paths] work_dir utenfor ${root}, ignorert: ${workDirOrRelative}`, "warn");
	return null;
}

/**
 * Er `sti` WORK-roten selv eller noe under den?
 *
 * Tilstandsfila er data, ikke kode, og `work_dir` fra den ble brukt rett i
 * skrivinger: `../../..` eller en absolutt sti et annet sted ga META-, PRD- og
 * THREAD-skrivinger utenfor MEMORY (M-09). Sammenlignes først som tekst, så
 * med symlenkene løst, fordi `~/.opencode` er en symlenke til repoet og de to
 * formene av samme sti begge er gyldige.
 */
function liggerUnder(root: string, sti: string): boolean {
	const under = (r: string, s: string): boolean => {
		const rel = path.relative(r, s);
		return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	};
	if (under(path.resolve(root), sti)) return true;
	try {
		return under(fs.realpathSync(root), fs.realpathSync(sti));
	} catch {
		return false;
	}
}

async function readCurrentWorkState(sessionId?: string): Promise<CurrentWorkState | null> {
	// Kun den sesjons-scopede fila. Legacy-speilet `current-work.json` er
	// fjernet: uten sesjons-ID kunne en leser få en annen økts arbeidskatalog
	// i retur, og med to harness på samme MEMORY-tre var det uunngåelig.
	if (!sessionId) return null;
	try {
		const content = await fs.promises.readFile(getCurrentWorkStateFile(sessionId), "utf-8");
		return JSON.parse(content) as CurrentWorkState;
	} catch {
		return null;
	}
}

export async function getCurrentWorkPath(sessionId?: string): Promise<string | null> {
	const state = await readCurrentWorkState(sessionId);
	const rel = state?.work_dir || state?.session_dir;
	return rel ? resolveSessionDir(rel) : null;
}

/**
 * Set current work session path in state file.
 *
 * @param sessionDir - WORK-dir-relative path of the session directory.
 * @param sessionId - OpenCode session ID. When provided, a session-scoped file is
 *   written (so compaction-intelligence.ts and algorithm-tracker.ts readers can
 *   find it) in addition to the legacy mirror. When omitted, only the legacy
 *   mirror is written — identical to the pre-fix behavior.
 * @param extra - Additional fields required by response-capture.ts.
 */
export async function setCurrentWorkPath(
	sessionDir: string,
	sessionId?: string,
	extra?: { currentTask?: string }
): Promise<void> {
	const stateDir = getStateDir();
	await ensureDir(stateDir);

	const eier = ownerProcess();
	const state: CurrentWorkState = {
		session_id: sessionId ?? "",
		work_dir: sessionDir,
		session_dir: sessionDir,
		current_task: extra?.currentTask ?? "main",
		started_at: new Date().toISOString(),
		pid: eier.pid,
		pid_start: eier.start,
		session_key: sessionId ? sessionKeyFor(currentHarness(), sessionId) : undefined,
	};

	const payload = JSON.stringify(state, null, 2);

	// INGEN legacy-speiling. `current-work.json` uten sesjonssuffiks var en
	// felles skuff to samtidige økter skrev i etter tur, og en leser uten
	// sesjons-ID kunne dermed høste fra feil arbeidskatalog. Med to harness
	// som deler MEMORY-tre var det en garantert kollisjon.
	//
	// Skrivingen er atomisk: temp + rename. Et delvis skrevet
	// `current-work`-dokument ville gjort at reaperen så en økt uten
	// arbeidskatalog og «fullførte» den.
	if (!sessionId) {
		// Uten ID finnes det ingen fil å skrive. Tidligere traff dette
		// legacy-speilet; nå er det en reell feil kalleren må se.
		throw new Error("setCurrentWorkPath krever sessionId — legacy-speilet er fjernet");
	}
	const målfil = getCurrentWorkStateFile(sessionId);
	const temp = `${målfil}.tmp.${process.pid}`;
	await fs.promises.writeFile(temp, payload);
	await fs.promises.rename(temp, målfil);
}

/**
 * Clear current work session.
 *
 * @param sessionId - When provided, removes this session's own scoped file, and
 *   only removes the legacy mirror if it belongs to this session (or to no
 *   session at all) — never another session's active state.
 */
export async function clearCurrentWork(sessionId?: string): Promise<void> {
	if (!sessionId) return;
	try {
		await fs.promises.unlink(getCurrentWorkStateFile(sessionId));
	} catch {
		// File doesn't exist, that's fine
	}
}

/**
 * Slugify text for filenames
 */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
}
