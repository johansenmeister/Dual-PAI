/**
 * PAI Core — etterbehandling av verktøykall
 *
 * Flyttet fra `tool.execute.after` i `plugins/pai-unified.ts`. Kun
 * observasjon: kallet er allerede kjørt, og utfallet kan ikke endres.
 *
 * Importerer ingen motor.
 *
 * @module pai-core/dispatch/tool
 */

import { fileLog, fileLogError } from "../lib/file-logger";
import { erSkriveverktøy, målsti, skrivemål } from "../lib/tool-names";
import type { PaiResult, PaiToolAfterEvent, PaiToolFailedEvent } from "../types";

/**
 * Verktøynavn som utløser PRD-synk.
 *
 * Navnene varierer mellom motorene (`write_file` på OpenCode, `Write` på
 * Claude Code), derfor både eksakte treff og substring-testen under.
 */
const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "str_replace_based_edit_tool"]);

function isWriteTool(tool: string): boolean {
	const lower = tool.toLowerCase();
	return WRITE_TOOL_NAMES.has(tool) || lower.includes("write") || lower.includes("edit");
}

/**
 * POST-TOOL EXECUTION
 *
 * Fanout til agent-fangst, subagent-registeret, algoritmesporing, PRD-synk
 * og spørsmålssporing.
 *
 * Normaliseringen av `args` og `result` er gjort FØR vi kommer hit — den er
 * adapterens jobb, og det er ikke en formalitet: OpenCode legger args i
 * `input` for denne hooken og i `output` for `tool.execute.before`, motsatt
 * av hverandre (målt 2026-09-20), og resultatet ligger i `output.output`,
 * ikke `output.result` (H-16).
 */
export async function onToolAfter(event: PaiToolAfterEvent): Promise<PaiResult> {
	fileLog(`Tool after: ${event.tool}`, "debug");

	const notes: string[] = [];
	const args = event.args ?? {};
	const toolResult = event.result;
	const resultLength = toolResult ? JSON.stringify(toolResult).length : 0;
	const sessionId = event.sessionId || "unknown";

	const { emitToolExecute } = await import("../handlers/observability-emitter");
	emitToolExecute({
		tool: event.tool,
		args,
		success: true,
		result_length: resultLength,
	}).catch(() => {});

	// === AGENT OUTPUT CAPTURE ===
	//
	// Eies av `agent.start`/`agent.stop` i `dispatch/agent.ts`, i begge
	// motorene: Claude Code fyrer `SubagentStart`/`SubagentStop`, og v2 gir
	// barneøkten sin egen `session.created`. Å fange her også ville fanget hver
	// subagent to ganger. Grenen som fanget fra verktøyresultatet, var v1s
	// eneste vei og ble slettet med v1. Noten gjør det ettergåelig i en test at
	// kallet ble sett og bevisst overlatt.
	const { isTaskTool } = await import("../handlers/agent-capture");
	if (isTaskTool(event.tool)) notes.push("agent-capture:egen-hendelse");

	// === ALGORITHM TRACKER (v3.0) ===
	try {
		const { trackAlgorithmState } = await import("../handlers/algorithm-tracker");
		await trackAlgorithmState(event.tool, args, toolResult, sessionId);
	} catch (error) {
		fileLogError("[AlgorithmTracker] Tracking failed (non-blocking)", error);
	}

	// === PRD SYNC (WP-A) ===
	// When AI writes/edits a PRD.md in MEMORY/WORK/, sync frontmatter
	// to prd-registry.json for dashboard and session continuity.
	// See ADR-009.
	//
	// Stiene fra `skrivemål` når verktøyet er et kjent skriveverktøy, ellers
	// `målsti` som før. v2s `patch` har ingen `filePath`, og heter ikke noe med
	// write eller edit: under en `gpt-`-modell traff hverken synken eller
	// plan-fangsten (K58).
	if (isWriteTool(event.tool) || erSkriveverktøy(event.tool)) {
		const stier = (skrivemål(event.tool, args) ?? [målsti(args)]).filter(Boolean);
		try {
			// `målsti` kjenner begge motorenes feltnavn. Her sto
			// `file_path || path`, som er Claudes navn: på OpenCode, der
			// write/edit sender `filePath`, traff synken aldri (M-32) — det
			// motsatte speilbildet av K-09 i sikkerhetsvakten.
			for (const filePath of stier) {
				const { syncPRDToRegistry } = await import("../handlers/prd-sync");
				if ((await syncPRDToRegistry(filePath)).synced) notes.push("prd-synced");

				// Fasesporingen henger på PRD-en, ikke på TodoWrite: under v2
				// og Claude 5 finnes det ikke noe todo-verktøy å høre på.
				const { trackPrdState } = await import("../handlers/algorithm-tracker");
				if (await trackPrdState(filePath, sessionId)) notes.push("prd-tracked");
			}
		} catch (error) {
			fileLogError("[PRDSync] Sync failed (non-blocking)", error);
		}

		// === PLAN CAPTURE ===
		// Plan-modus skriver planen som en fil i begge motorene (MÅLT). Se
		// `handlers/plan-capture.ts`.
		try {
			for (const filePath of stier) {
				const { capturePlan } = await import("../handlers/plan-capture");
				const plan = await capturePlan(filePath, { sessionId, harness: event.harness });
				if (plan?.captured) notes.push("plan-captured");
			}
		} catch (error) {
			fileLogError("[PlanCapture] Capture failed (non-blocking)", error);
		}
	}

	// === QUESTION TRACKING (WP-A) ===
	// When AskUserQuestion tool completes, record the Q&A pair.
	//
	// Inaktiv på OpenCode: binæren har ikke noe AskUserQuestion-verktøy (null
	// treff). Dette er forhåndsarbeid for Claude-adapteren, ikke død kode.
	try {
		const { extractAskUserQuestionAnswer, trackQuestionAnswered } = await import(
			"../handlers/question-tracking"
		);
		const qa = extractAskUserQuestionAnswer(event.tool, args, toolResult);
		if (qa) {
			await trackQuestionAnswered(qa.question, qa.answer, sessionId, event.callId);
			notes.push("question-tracked");
		}
	} catch (error) {
		fileLogError("[QuestionTracking] Track failed (non-blocking)", error);
	}

	return { notes };
}

/**
 * VERKTØYKALL FEILET
 *
 * Bevisst mye tynnere enn `onToolAfter`. Et feilet kall har ingen fil å
 * synke, intet svar å registrere og ingen subagent å fange — å kjøre den
 * samme fanouten med en feilstreng i resultatfeltet ville gitt PRD-synk en
 * sti som ikke ble skrevet og spørsmålssporing et svar som aldri kom.
 *
 * Det som FAKTISK er verdt å vite om et feilet kall, er at det feilet. Det
 * er `emitToolExecute` med `success: false` — den første kilden til den
 * verdien i hele systemet; den har vært hardkodet `true` siden feltet ble
 * innført, fordi OpenCode ikke skiller de to utfallene.
 *
 * Et AVBRUDD er ikke en feil. Brukeren som trykker ESC har tatt et valg, og
 * å telle det som en verktøyfeil ville gjort enhver senere statistikk over
 * feilrate ubrukelig.
 */
export async function onToolFailed(event: PaiToolFailedEvent): Promise<PaiResult> {
	const avbrutt = event.isInterrupt === true;
	fileLog(
		`Tool failed: ${event.tool}${avbrutt ? " (avbrutt av bruker)" : ""} — ${event.error.slice(0, 200)}`,
		avbrutt ? "debug" : "warn"
	);

	const notes: string[] = [avbrutt ? "tool-interrupted" : "tool-failed"];

	if (!avbrutt) {
		try {
			const { emitToolExecute } = await import("../handlers/observability-emitter");
			emitToolExecute({
				tool: event.tool,
				args: event.args ?? {},
				success: false,
				result_length: event.error.length,
			}).catch(() => {});
		} catch (error) {
			fileLogError("[ToolFailed] Emit feilet (non-blocking)", error);
		}
	}

	return { notes };
}
