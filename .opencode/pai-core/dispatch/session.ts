/**
 * PAI Core — sesjonens livssyklus
 *
 * Flyttet fra `event`-kroppen i `plugins/pai-unified.ts`. Grenene som kun
 * loggførte OpenCodes egen buss (`session.error`, `permission.asked`,
 * `command.executed`, `installation.update-available`, `session.updated`)
 * ble IKKE med: de er ren observasjon av én motors buss uten PAI-tilstand,
 * og hører derfor hjemme i adapteren.
 *
 * Importerer ingen motor.
 *
 * @module pai-core/dispatch/session
 */

import { ownerProcess } from "../lib/paths";
import { fileLog, fileLogError } from "../lib/file-logger";
import type {
	PaiResult,
	PaiSessionCompactedEvent,
	PaiSessionEndEvent,
	PaiSessionStartEvent,
} from "../types";
import { clearMessages, pruneStaleState, readMessages } from "./state";
import {
	fjernSesjonsPeker,
	ryddPekere,
	skrivSesjonsPeker,
} from "../lib/session-pointer";

/**
 * SESSION START
 *
 * Nullstiller meldingsbuffere, gjenoppretter SKILL-filer og sjekker versjon.
 *
 * MERK at arbeidssporing IKKE henger her. Den henger på `user.message`, og
 * det er med vilje: OpenCodes `session.created` fyrer ikke ved resume, mens
 * Claude Codes `SessionStart` gjør det. Knyttes sporingen hit, får de to
 * motorene ulik oppførsel på gjenopptatte økter (M-14).
 */
export async function onSessionStart(event: PaiSessionStartEvent): Promise<PaiResult> {
	fileLog("=== Session Started ===", "info");

	const notes: string[] = [];
	const sessionId = event.sessionId || "unknown";

	// Ingen nullstilling av buffere: de ligger på disk under denne øktens
	// egen nøkkel, og en ny økt har ingen. Å «nullstille» ville betydd å
	// slette en fil som ikke er vår.
	//
	// Derimot ryddes transiente filer ingen ryddet etter. Dedupe og buffere
	// er caching, og en prosess som dør uten teardown etterlater dem.
	const ryddet = await pruneStaleState();
	if (ryddet > 0) {
		fileLog(`[State] Ryddet ${ryddet} foreldede øktfil(er)`, "debug");
		notes.push(`pruned:${ryddet}`);
	}

	// SESJONSPEKER FOR MCP-SERVEREN
	//
	// MCP-protokollen bærer ingen sesjons-ID, og Claude Code sender ingen.
	// Men serveren er et DIREKTE barn av motoren (målt 2026-09-22), og HER
	// kjenner vi både sesjons-ID-en og motorens pid. Pekeren er dermed det
	// eneste stedet de to møtes.
	//
	// En fil og ikke en miljøvariabel: serveren startes av motoren på et
	// tidspunkt vi ikke styrer, og en variabel satt her ville aldri nådd den.
	const { pid: motorPid } = ownerProcess();
	skrivSesjonsPeker(sessionId, motorPid, event.cwd || process.cwd());
	const pekereRyddet = ryddPekere();
	if (pekereRyddet > 0) notes.push(`pekere-ryddet:${pekereRyddet}`);

	const { emitSessionStart } = await import("../handlers/observability-emitter");
	// Emit session start (backup emit, primary is in context injection)
	emitSessionStart({ sessionId: sessionId !== "unknown" ? sessionId : undefined }).catch(() => {});

	return { notes };
}

/**
 * Teardown-kjeden. Rekkefølgen er bindende, ikke tilfeldig.
 *
 * `cleanupSession` nullstiller tilstanden `extractLearningsFromWork` leser,
 * så læringen MÅ hentes ut først (ADR-009).
 *
 * Alt er sesjons-scopet. Det er nytt: `extractLearningsFromWork` leste
 * tidligere legacy-speilet `current-work.json` uten ID, og pekte dermed på
 * feil arbeidskatalog så snart to økter var i sving. Reaperen kunne ikke
 * fungere uten at dette ble rettet — den kjører per definisjon for en økt
 * speilet ikke peker på.
 *
 * @param sessionId Motorens sesjons-ID. `undefined` gir legacy-oppførsel.
 * @param sessionKey Nøkkelen meldingsbufferne ligger under, eller `null`
 *   når den ikke er kjent. Reaperen leser den fra `session_key` i
 *   `current-work-*.json`, som eierprosessen skrev. Tilstand skrevet før
 *   feltet fantes gir `null`: å GJETTE nøkkelen ville i verste fall lest og
 *   SLETTET en annen økts buffer, så da hoppes det over.
 */
async function runTeardown(
	sessionId: string | undefined,
	sessionKey: string | null,
	notes: string[]
): Promise<void> {
	// K5: arbeidsøkten slås opp FØR `cleanupSession` nullstiller tilstanden, og
	// effektene merkes til slutt, når alle notene er samlet.
	const { getCurrentWorkPath } = await import("../lib/paths");
	const arbeid = await getCurrentWorkPath(sessionId).catch(() => null);
	try {
		await teardownSteg(sessionId, sessionKey, notes, arbeid);
	} finally {
		const { merkEffekter } = await import("../lib/effekter");
		merkEffekter(arbeid, "session.end", notes);
	}
}

async function teardownSteg(
	sessionId: string | undefined,
	sessionKey: string | null,
	notes: string[],
	arbeid: string | null
): Promise<void> {
	// WORK COMPLETION LEARNING
	try {
		const { extractLearningsFromWork } = await import("../handlers/learning-capture");
		const { emitLearningCaptured } = await import("../handlers/observability-emitter");
		const learningResult = await extractLearningsFromWork(sessionId);
		if (learningResult.success && learningResult.learnings.length > 0) {
			fileLog(`Extracted ${learningResult.learnings.length} learnings`, "info");
			notes.push(`learnings:${learningResult.learnings.length}`);

			// `LearningEntry` er typet. Her sto `learning: any` og et
			// `filepath`-felt som oppføringen aldri har hatt — verdien var
			// alltid "unknown", og typen var det eneste som kunne sagt fra.
			learningResult.learnings.forEach((learning) => {
				emitLearningCaptured({ category: learning.category || "unknown" }).catch(() => {});
			});
		}
	} catch (error) {
		fileLogError("Learning extraction failed", error);
	}

	// === INTEGRITY CHECK (v3.0) ===
	try {
		const { runIntegrityCheck } = await import("../handlers/integrity-check");
		const healthResult = await runIntegrityCheck();
		if (!healthResult.healthy) {
			fileLog(`[IntegrityCheck] Issues found: ${healthResult.issues.join(", ")}`, "warn");
		} else {
			fileLog("[IntegrityCheck] System healthy", "info");
		}
	} catch (error) {
		fileLogError("[IntegrityCheck] Check failed (non-blocking)", error);
	}

	// SESSION SUMMARY
	try {
		const { completeWorkSession } = await import("../handlers/work-tracker");
		const completeResult = await completeWorkSession(sessionId);
		// `success` er også sant når det ikke fantes noen økt å fullføre. Bare
		// `completed_at` betyr at noe faktisk ble fullført (M-13).
		if (completeResult.completed_at) {
			notes.push("work-completed");
		}
	} catch (error) {
		fileLogError("Work session completion failed", error);
	}

	// UPDATE COUNTS
	try {
		const { handleUpdateCounts } = await import("../handlers/update-counts");
		await handleUpdateCounts();
	} catch (error) {
		fileLogError("Update counts failed (non-blocking)", error);
	}

	// === SESSION CLEANUP (WP-A) ===
	// Marks the PRD COMPLETED and clears state. Runs AFTER learning
	// extraction, which uses that state (ADR-009), and after
	// `completeWorkSession`, which already cleared it: the work dir comes from
	// the lookup at the top of `runTeardown` (M-48).
	try {
		const { cleanupSession } = await import("../handlers/session-cleanup");
		await cleanupSession(sessionId, arbeid);
	} catch (error) {
		fileLogError("[SessionCleanup] Cleanup failed (non-blocking)", error);
	}

	// === ØKTENS EGNE STATE-FILER ===
	// Etter `cleanupSession` og læringsuttrekket, som begge kan lese dem.
	// Ingen annen rydder tar disse, så uten steget ble de liggende for alltid.
	if (sessionId) {
		try {
			const { clearAlgorithmState } = await import("../handlers/algorithm-tracker");
			const { clearLastResponse } = await import("../handlers/last-response-cache");
			await clearAlgorithmState(sessionId);
			await clearLastResponse(sessionId);
		} catch (error) {
			fileLogError("[Teardown] Kunne ikke rydde øktens state-filer (non-blocking)", error);
		}
	}

	// === RELATIONSHIP MEMORY (WP-A) ===
	if (sessionKey) {
		try {
			const { captureRelationshipMemory } = await import("../handlers/relationship-memory");
			const meldinger = await readMessages(sessionKey);
			await captureRelationshipMemory(meldinger.user, meldinger.assistant);
			await clearMessages(sessionKey);
		} catch (error) {
			fileLogError("[RelationshipMemory] Capture failed (non-blocking)", error);
		}
	} else {
		notes.push("relationship-skipped:ukjent-sessionKey");
	}
}

/**
 * SESSION END
 *
 * Utløses av prosess-avslutning (`exit`) eller av reaperen (`reaped`) —
 * ALDRI av `session.idle`. Idle fyrer etter hver assistenttur, og å
 * behandle den som slutt var årsaken til H-17: `completeWorkSession`
 * nullstilte tilstanden, så neste prompt ble «første melding» igjen og
 * fikk sin egen arbeidskatalog.
 *
 * H-13: på OpenCode fullfører kjeden kun når prosessen lever lenge nok.
 * `opencode run` avslutter før bussen drenerer. Reaperen er nettopp
 * sikringen mot det.
 */
export async function onSessionEnd(event: PaiSessionEndEvent): Promise<PaiResult> {
	fileLog(
		`=== Session Ending (${event.reason}${event.detail ? `/${event.detail}` : ""}) ===`,
		"info"
	);

	const notes: string[] = [`reason:${event.reason}`];
	// Motorens egen begrunnelse er diagnostikk, ikke styring. Den forgrenes
	// aldri på — se `detail` i types.ts — men uten den i loggen er det umulig
	// å se om en rar teardown kom av /clear, av resume eller av at brukeren
	// gikk ut av promptet.
	if (event.detail) notes.push(`detail:${event.detail}`);
	// Handlerne tar `sessionId?` og faller tilbake på legacy-speil når den
	// mangler. Tom streng er ikke det samme som fraværende.
	// Pekeren fjernes FØR teardown: går teardown galt, skal ikke en død
	// motors peker bli stående og sende MCP-serveren til feil økt.
	// Reaperen tar den uansett, men den kjører først ved neste oppstart.
	fjernSesjonsPeker(ownerProcess().pid);

	await runTeardown(event.sessionId || undefined, event.sessionKey || null, notes);

	const { emitSessionEnd } = await import("../handlers/observability-emitter");
	emitSessionEnd({ sessionId: event.sessionId || undefined }).catch(() => {});

	return { notes };
}

/**
 * REAPER — fullfør arbeidsøkter hvis motorprosess er borte
 *
 * Dette er korrekthetsgarantien i hele livssyklusen. OpenCode har ingen
 * sesjonsslutt-hendelse, og ingen motor varsler ved SIGKILL, så «kjørte
 * teardown?» kan ikke besvares av et signal alene. Det kan besvares av om
 * prosessen som eide økten fortsatt lever.
 *
 * Kjøres ved oppstart. Finner den en `current-work-*.json` hvis eier er
 * død, kjøres full teardown for den økten — sent, men ikke tapt.
 *
 * FAIL-SAFE: `isOwnerAlive` svarer «lever» ved enhver tvil (manglende
 * pid-felt, ikke-Linux, uleselig `/proc`). En arbeidsøkt som fullføres for
 * sent er kosmetisk; én som fullføres mens den er i bruk ødelegger
 * pågående arbeid.
 */
export async function reapOrphanedWorkSessions(): Promise<string[]> {
	const reapet: string[] = [];

	try {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const { getStateDir, isOwnerAlive } = await import("../lib/paths");

		const stateDir = getStateDir();
		let filer: string[];
		try {
			filer = fs.readdirSync(stateDir);
		} catch {
			// STATE/ finnes ikke ennå — første oppstart.
			return reapet;
		}

		for (const fil of filer) {
			const treff = fil.match(/^current-work-(.+)\.json$/);
			if (!treff) continue;
			const sessionId = treff[1];

			let state: { pid?: number; pid_start?: string; started_at?: string; session_key?: unknown };
			try {
				state = JSON.parse(fs.readFileSync(path.join(stateDir, fil), "utf-8"));
			} catch {
				// Uleselig tilstand. Å gjette på innholdet er verre enn å la den stå.
				fileLog(`[Reaper] Hopper over uleselig tilstandsfil: ${fil}`, "warn");
				continue;
			}

			if (isOwnerAlive(state.pid, state.pid_start, state.started_at)) continue;

			if (typeof state.pid === "number") {
				// EKTE FORELDRELØS: skrevet av dagens kode, prosessen er borte.
				// Full teardown — arbeidet er ferskt nok til at læringen teller.
				fileLog(
					`[Reaper] Foreldreløs arbeidsøkt ${sessionId} (pid ${state.pid}) — full teardown`,
					"info"
				);
				const notes: string[] = [];
				// Nøkkelen eieren selv skrev, men kun hvis den faktisk hører til
				// denne ID-en. Eldre filer har den ikke; da `null`, som før — en
				// gjettet nøkkel kunne lest og slettet en annen økts buffer.
				const { erSessionKeyFor } = await import("../runtime");
				const sessionKey = erSessionKeyFor(state.session_key, sessionId) ? state.session_key : null;
				await runTeardown(sessionId, sessionKey, notes);
			} else {
				// LEGACY-ETTERSLEP: tilstand fra før pid-feltet fantes, eldre enn
				// seks timer. Her kjøres KUN fullføring, ikke full teardown.
				//
				// Begrunnelsen er at innholdet er dagegammelt: å hente læring ut
				// av det nå ville injisert foreldet materiale i LEARNING-treet,
				// og `handleUpdateCounts` ville kjørt én gang per etterslepsfil
				// ved oppstart. Meldingsbufferne finnes uansett ikke.
				fileLog(`[Reaper] Legacy-tilstand ${sessionId} uten pid — kun fullføring`, "info");
				try {
					const { completeWorkSession } = await import("../handlers/work-tracker");
					await completeWorkSession(sessionId);
				} catch (error) {
					fileLogError(`[Reaper] Fullføring feilet for ${sessionId}`, error);
				}
			}
			reapet.push(sessionId);
		}
	} catch (error) {
		fileLogError("[Reaper] Feilet (non-blocking)", error);
	}

	return reapet;
}

/**
 * SESSION COMPACTED — kun en logglinje
 *
 * Her sto en «læringsredning» som kalte `extractLearningsFromWork()` uten
 * økt. Etter at legacy-speilet ble fjernet (5a) fant den aldri noe (M-35), og
 * den trengs ikke: kompaktering sletter ikke arbeidsfilene, og teardown (også
 * via reaperen) trekker ut læringene fra de samme filene. Koblet opp ville den
 * skrevet hver læring to ganger, fordi `persistLearning` ikke dedupliserer.
 *
 * Det som påvirker kompakteringen, skjer FØR den, i adapteren
 * (`buildCompactionContext`).
 */
export async function onSessionCompacted(event: PaiSessionCompactedEvent): Promise<PaiResult> {
	fileLog(
		`[Compaction:Post] Context compaction detected (${event.trigger ?? "ukjent utløser"}` +
			`${event.summary ? `, sammendrag ${event.summary.length} tegn` : ""})`,
		"info"
	);
	return { notes: event.trigger ? [`trigger:${event.trigger}`] : [] };
}
