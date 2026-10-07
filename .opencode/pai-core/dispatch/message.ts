/**
 * PAI Core — brukermeldinger og assistentsvar
 *
 * Flyttet fra `chat.message`-hooken og `message.updated`-grenen i
 * `plugins/pai-unified.ts`.
 *
 * Importerer ingen motor.
 *
 * @module pai-core/dispatch/message
 */

import { forStorage } from "../lib/secrets";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import type { PaiAssistantMessageEvent, PaiResult, PaiUserMessageEvent } from "../types";
import { appendMessage, wasMessageRecentlyProcessed } from "./state";

/** Under denne lengden regnes et assistentsvar som for tynt til å analysere. */
const ASSISTANT_MIN_LENGTH = 100;

/**
 * Hvor hardt ISC-avvik skal håndheves.
 *
 * `warn` er default, og det er et bevisst valg framfor en overgangsordning:
 * `isc-validator` har kun kunnet logge fram til nå, og å slå på blokkering
 * i samme endring som ga den en kanal ville gjort en ny mekanisme og en ny
 * atferd til ett udelelig hopp. Med `warn` er kanalen i drift og målbar før
 * noen setter `block`.
 *
 * Ukjente verdier leses som `warn`. En skrivefeil i miljøet skal ikke kunne
 * slå på håndhevelse.
 */
function iscEnforcement(): "warn" | "block" {
	return process.env.PAI_ISC_ENFORCE?.trim() === "block" ? "block" : "warn";
}

/**
 * Append effort level to a session's META.yaml
 *
 * Adds effort_level and effort_budget fields to the session metadata.
 * Called after work session creation (Phase 4 — Issue #24).
 */
async function appendEffortToMeta(
	sessionPath: string,
	level: string,
	budget: string
): Promise<void> {
	const metaPath = path.join(sessionPath, "META.yaml");
	let content = await fs.promises.readFile(metaPath, "utf-8");
	// Only append if not already present
	if (!content.includes("effort_level:")) {
		content = `${content.trimEnd()}\neffort_level: ${level}\neffort_budget: ${budget}\n`;
		await fs.promises.writeFile(metaPath, content);
	}
}

/**
 * BRUKERMELDING — arbeidssporing, rating, innsatsnivå
 *
 * Dette er stien Claude Codes `UserPromptSubmit` og OpenCodes `chat.message`
 * deler.
 *
 * Dedupe-sjekken ligger her, ikke i adapteren, fordi den er en egenskap ved
 * behandlingen: OpenCode har to kilder til samme melding, Claude Code én.
 * Nøkkelen er sessionKey-scopet (H-08) slik at to samtidige økter ikke kan
 * dedupe hverandres meldinger — uten den mistet den andre økten arbeidsøkt,
 * rating og THREAD-innslag i stillhet.
 *
 * De to stiene gjorde ikke helt det samme før K-08 ble ryddet. Denne
 * handleren er unionen av dem: `chat.message`-stien, som var den eneste som
 * faktisk kjørte, pluss rating-emitteringen, implicit-sentiment og
 * `emitUserMessage` fra den døde grenen.
 *
 * SENTIMENT VENTES IKKE PÅ. `handleImplicitSentiment` spawner en CLI og
 * racer mot `ANALYSIS_TIMEOUT = 25000` — awaitet her ville hver eneste
 * brukermelding kunne stanset i 25 sekunder før arbeidsøkten ble opprettet.
 * Den slippes løs og får leve sitt eget liv. Batch 12 gjør den til en ekte
 * detached worker med jobbfil og `unref()`; dette er samme prinsipp uten
 * infrastrukturen.
 */
export async function onUserMessage(event: PaiUserMessageEvent): Promise<PaiResult> {
	// Masked before anything stores it (#367): THREAD.md, the captures and
	// the learning notes keep the prompt, and a pasted token would live there.
	const content = forStorage(event.text);

	// Guard: skip empty/whitespace-only content before any further processing
	if (!content || content.trim().length === 0) return {};

	// === DEDUPLICATION CHECK ===
	if (await wasMessageRecentlyProcessed(event.sessionKey, content)) {
		fileLog(`[user.message] Skipping duplicate message: ${content.substring(0, 50)}...`, "debug");
		return { notes: ["duplicate"] };
	}

	fileLog(`[user.message] User: ${content.substring(0, 100)}...`, "debug");

	const notes: string[] = [];
	const sessionId = event.sessionId || undefined;
	// `handleImplicitSentiment` skriver sesjons-ID-en inn i ratings.jsonl, som
	// er en delt logg. Motorens rå ID er riktig der — det er den brukeren
	// finner igjen i transkriptet.

	const { appendToThread, createWorkSession, getCurrentSession, isTrivialMessage } = await import(
		"../handlers/work-tracker"
	);
	const { detectEffortLevel } = await import("../handlers/format-reminder");

	// === AUTO-WORK CREATION ===
	// Create work session on first user prompt if none exists
	// Skip trivial messages (greetings, ratings, acknowledgments) — Issue #24
	if (!(await getCurrentSession(sessionId)) && !isTrivialMessage(content)) {
		const workResult = await createWorkSession(content, sessionId);
		if (workResult.success && workResult.session) {
			fileLog(`Work session started: ${workResult.session.id}`, "info");
			notes.push("work-created");

			// === EFFORT LEVEL IN META (Phase 4 — Issue #24) ===
			// Detect effort level and write to session META.yaml
			try {
				const effortResult = await detectEffortLevel(content);
				await appendEffortToMeta(workResult.session.path, effortResult.level, effortResult.budget);
				fileLog(
					`[EffortLevel] Written to META: ${effortResult.level} (${effortResult.budget})`,
					"info"
				);
			} catch (error) {
				fileLogError("[EffortLevel] META write failed (non-blocking)", error);
			}
		}
	}

	// THREAD får meldingen uansett om økten nettopp ble opprettet eller
	// fantes fra før (H-17). Før lå dette i en `else if`-gren, så meldingen
	// som OPPRETTET arbeidsøkten aldri havnet i THREAD — og siden H-12 gjorde
	// hver prompt til «første melding», ble THREAD tom i praksis.
	//
	// `appendToThread` er et no-op uten arbeidskatalog, så en triviell melding
	// uten økt går stille gjennom.
	await appendToThread(`**User:** ${content}`, sessionId);

	// Buffer user message for relationship memory (økt-scopet, på disk)
	if (content.length >= 10) {
		await appendMessage(event.sessionKey, "user", content.slice(0, 300));
	}

	// === EXPLICIT RATING CAPTURE ===
	// Check if message is a rating (e.g., "8", "7 - needs work", "9/10")
	const { captureRating, detectRating } = await import("../handlers/rating-capture");
	const rating = detectRating(content);
	if (rating) {
		const ratingResult = await captureRating(content, "user message");
		if (ratingResult.success && ratingResult.rating) {
			fileLog(`Rating captured: ${ratingResult.rating.score}/10`, "info");
			notes.push("rating-captured");

			const { emitExplicitRating } = await import("../handlers/observability-emitter");
			emitExplicitRating({
				score: ratingResult.rating.score,
				comment: ratingResult.rating.comment,
			}).catch(() => {});
		}
	}

	// === IMPLICIT SENTIMENT ===
	// Kun når meldingen IKKE er en eksplisitt rating — da eier
	// rating-fangsten den, og to kilder ville gitt to innslag for samme svar.
	if (!rating) {
		// Ikke awaitet, med vilje. Se modulkommentaren: opptil 25 s.
		void (async () => {
			const { readLastResponse } = await import("../handlers/last-response-cache");
			const { handleImplicitSentiment } = await import("../handlers/implicit-sentiment");
			const lastResponse = (await readLastResponse(sessionId).catch(() => null)) ?? undefined;
			const sentiment = await handleImplicitSentiment(content, event.sessionId || "unknown", lastResponse);
			// `handleImplicitSentiment` returnerer { rating, sentiment, confidence } —
			// ikke { score, indicators }. Feltnavnene har vært feil her før.
			if (sentiment && sentiment.rating !== null) {
				const { emitImplicitSentiment } = await import("../handlers/observability-emitter");
				emitImplicitSentiment({
					score: sentiment.rating,
					confidence: sentiment.confidence || 0,
					sentiment: sentiment.sentiment,
				}).catch(() => {});
			}
		})().catch((error) => fileLogError("[ImplicitSentiment] Feilet (non-blocking)", error));
	}

	const { emitUserMessage } = await import("../handlers/observability-emitter");
	emitUserMessage({ content_length: content.length, has_rating: !!rating }).catch(() => {});

	// === FORMAT REMINDER ===
	// For non-trivial prompts, nudge towards Algorithm format
	// (Not blocking, just logging for awareness)
	if (content.length > 100 && !content.toLowerCase().includes("trivial")) {
		fileLog("Non-trivial prompt detected, Algorithm format recommended", "debug");
	}

	// Hvor PRD-en hører hjemme (M-47). Under Claude når denne modellen via
	// `UserPromptSubmit`; v2 får den samme linja fra `context.build`.
	const { arbeidsøktKontekst } = await import("./arbeidsokt");
	const arbeidsøkt = await arbeidsøktKontekst(event.sessionId);
	return arbeidsøkt ? { notes, additionalContext: [arbeidsøkt] } : { notes };
}

/**
 * ASSISTENTSVAR — ISC, tab-state, respons-fangst, THREAD, last-response-cache
 *
 * INGEN OPENCODE-KILDE PER I DAG. Målt 2026-09-21: `message.updated` bærer
 * kun metadata, så teksten finnes ikke på hendelsen (K-08). OpenCode-
 * adapteren emitterer derfor ikke denne. Handleren står likevel her, fullt
 * testbar, fordi Claude Codes `Stop` gir `last_assistant_message` direkte —
 * og fordi batch 4b skal koble OpenCode på igjen via delbuffring.
 *
 * Voice-varsling er FJERNET. Den hadde aldri virket på noen maskin i dette
 * oppsettet (ingen TTS-binær, ingen nøkler), var holdt utenfor
 * paritetskravet, og bar H-07 — `execFileAsync("say")` uten timeout i varm
 * sti. Talelinja den parset lever videre i `lib/response-format.ts`, fordi
 * terminalfanen og observability bruker den.
 */
export async function onAssistantMessage(event: PaiAssistantMessageEvent): Promise<PaiResult> {
	// Masked for the same reason as the prompt (#367).
	const responseText = forStorage(event.text);
	if (!responseText || responseText.length <= ASSISTANT_MIN_LENGTH) return {};

	const notes: string[] = [];
	const sessionId = event.sessionId || "unknown";

	// Hva vi eventuelt nekter turen å avslutte med. Settes kun av
	// ISC-grenen under, og kun når håndhevelsen står på `block`.
	let block: PaiResult["block"];

	// Run ISC validation on non-trivial assistant responses
	try {
		const { validateISC } = await import("../handlers/isc-validator");
		const iscResult = await validateISC(responseText, sessionId);

		// === ISC-HÅNDHEVELSE (PAI_ISC_ENFORCE) ===
		//
		// Fram til nå kunne validatoren bare loggføre at LEARN-fasen manglet
		// refleksjonen sin — og en advarsel ingen leser, er ingen kontroll.
		// Claude Codes `Stop` tar toppnivå `decision: "block"` + `reason`, så
		// avviket kan nå nå MODELLEN, som er den eneste som kan rette det.
		//
		// TRE VILKÅR, og alle tre må holde:
		//
		//   1. `PAI_ISC_ENFORCE=block`. Default `warn` endrer ingenting.
		//   2. Det finnes noe å si fra om — en advarsel fra validatoren.
		//   3. `continuedAfterBlock` er ikke sann.
		//
		// Punkt 3 er løkkevakten, og den er ikke teoretisk: blokkerer vi, får
		// modellen beskjeden og svarer på nytt. Er det nye svaret like
		// mangelfullt — helt normalt når advarselen gjelder en fil som skulle
		// vært skrevet tidligere i turen — blokkerer vi igjen, og de to står i
		// ring til brukeren griper inn. Motoren sier fra via
		// `stop_hook_active`; maks én blokkering per tur er hele regelen.
		if (
			iscResult.warnings.length > 0 &&
			iscEnforcement() === "block" &&
			!event.continuedAfterBlock
		) {
			block = {
				message:
					`[PAI ISC] Turen er ikke ferdig: ${iscResult.warnings.join(" | ")}. ` +
					"Rett dette før du avslutter.",
			};
			notes.push("isc-blocked");
			fileLog(`[ISC Validation] BLOKKERER turen: ${iscResult.warnings.join(" | ")}`, "error");
		} else if (iscResult.warnings.length > 0 && event.continuedAfterBlock) {
			// Synlig, ikke taus. En vakt som slår til uten å si fra, ser ut
			// som en håndhevelse som ikke virker.
			notes.push("isc-block-undertrykt:loop-vakt");
			fileLog(
				"[ISC Validation] Avvik står, men turen er allerede en fortsettelse — blokkerer ikke igjen",
				"warn"
			);
		}

		if (iscResult.algorithmDetected) {
			fileLog(
				`[ISC Validation] Algorithm detected, ${iscResult.criteriaCount} criteria found`,
				"info"
			);
			notes.push("isc-detected");
			if (iscResult.warnings.length > 0) {
				fileLog(`[ISC Validation] Warnings: ${iscResult.warnings.join(", ")}`, "warn");
			}

			const { emitISCValidated } = await import("../handlers/observability-emitter");
			emitISCValidated({
				criteriaCount: iscResult.criteriaCount || 0,
				all_passed: iscResult.warnings.length === 0,
				warnings: iscResult.warnings || [],
			}).catch(() => {});
		}
	} catch (error) {
		fileLogError("[ISC Validation] Failed", error);
	}

	// === TALELINJE → TERMINALFANE ===
	//
	// Linja het «voice completion» og drev TTS. Voice er fjernet — den hadde
	// aldri virket på noen maskin her, og bar H-07. Men parsingen hadde to
	// konsumenter til, og denne er den synlige: fanens tittel.
	//
	// Kallet lå INNE i voice-grenen, så en naiv sletting ville tatt
	// tab-state med seg uten at noe feilet.
	const { extractSpokenLine } = await import("../lib/response-format");
	const spokenLine = extractSpokenLine(responseText);
	if (spokenLine) {
		try {
			const { handleTabState } = await import("../handlers/tab-state");
			await handleTabState(spokenLine, "completed");
			notes.push("tab-state");
		} catch (error) {
			fileLogError("[TabState] Failed to update tab state (non-blocking)", error);
		}
	}

	// Emit assistant message
	const { emitAssistantMessage } = await import("../handlers/observability-emitter");
	const hasVoiceLine = spokenLine !== null;
	const hasISC = responseText.includes("🤖") || responseText.includes("OBSERVE");
	emitAssistantMessage({
		content_length: responseText.length,
		has_voice_line: hasVoiceLine,
		has_isc: hasISC,
	}).catch(() => {});

	// === RESPONSE CAPTURE ===
	// Capture response for work tracking and learning
	try {
		const { handleResponseCapture } = await import("../handlers/response-capture");
		await handleResponseCapture(responseText, sessionId);
	} catch (error) {
		fileLogError("[Capture] Response capture failed (non-blocking)", error);
	}

	// === ASSISTANT THREAD CAPTURE (Phase 2 — Issue #24) ===
	// Append full assistant response to THREAD.md for session completeness
	try {
		const { appendToThread, getCurrentSession } = await import("../handlers/work-tracker");
		const currentSess = await getCurrentSession(sessionId);
		if (currentSess) {
			await appendToThread(`**Assistant:** ${responseText}`, sessionId);
			fileLog(`[Thread] Assistant response appended (${responseText.length} chars)`, "debug");
		}
	} catch (error) {
		fileLogError("[Thread] Assistant capture failed (non-blocking)", error);
	}

	// Buffer assistant response for relationship memory (økt-scopet, på disk)
	await appendMessage(event.sessionKey, "assistant", responseText.slice(0, 500));

	// === LAST RESPONSE CACHE (WP-A) ===
	// Cache response so ImplicitSentiment has context on next user message.
	// OpenCode-native replacement for Claude-Code transcript_path pattern.
	// See ADR-009.
	try {
		const { cacheLastResponse } = await import("../handlers/last-response-cache");
		await cacheLastResponse(responseText, sessionId);
	} catch (error) {
		fileLogError("[LastResponseCache] Cache write failed (non-blocking)", error);
	}

	return block ? { notes, block } : { notes };
}
