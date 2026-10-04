/**
 * Question Tracking Handler
 *
 * Inspired by PAI v4.0.3 QuestionAnswered.hook.ts
 * Triggered by: message.updated (event bus), tool.execute.after (AskUserQuestion)
 *
 * NOTE: The upstream QuestionAnswered hook is Kitty-terminal specific (tab color reset).
 * This OpenCode port focuses on the SEMANTIC value: tracking Q&A pairs for memory.
 *
 * PURPOSE:
 * Detects when the AI asked a question (via AskUserQuestion tool) and the user
 * answered it. Stores Q&A pairs in MEMORY/STATE/questions.jsonl for:
 * - Session continuity (what was asked/answered)
 * - Learning patterns (what kinds of clarifications are needed)
 * - Context for future sessions
 *
 * STORAGE: MEMORY/STATE/questions.jsonl (append-only log)
 *
 * @module question-tracking
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import { ensureDir, getStateDir } from "../lib/paths";
import { somObjekt } from "../lib/payload";
import { currentHarness } from "../runtime";

interface QAPair {
	timestamp: string;
	sessionId: string;
	question: string;
	answer: string;
	tool_call_id?: string;
}

const QUESTIONS_LOG = "questions.jsonl";

/**
 * Record a question-answer pair when AskUserQuestion tool is used.
 *
 * @param question - The question that was asked
 * @param answer - The user's answer
 * @param sessionId - Current session ID
 * @param toolCallId - Optional tool call ID for correlation
 */
export async function trackQuestionAnswered(
	question: string,
	answer: string,
	sessionId: string,
	toolCallId?: string
): Promise<void> {
	if (!question || !answer) return;

	try {
		const stateDir = getStateDir();
		await ensureDir(stateDir);

		const entry: QAPair = {
			timestamp: new Date().toISOString(),
			sessionId,
			question: question.slice(0, 500),
			answer: answer.slice(0, 500),
			...(toolCallId ? { tool_call_id: toolCallId } : {}),
		};

		const logPath = path.join(stateDir, QUESTIONS_LOG);
		await fs.promises.appendFile(
			logPath,
			`${JSON.stringify({ ...entry, harness: currentHarness() })}\n`,
			"utf-8"
		);

		fileLog(`[QuestionTracking] Q&A recorded: "${question.slice(0, 60)}..."`, "info");
	} catch (error) {
		fileLogError("[QuestionTracking] Failed to record Q&A (non-blocking)", error);
	}
}

/**
 * Detect if a tool result is an answer to an AskUserQuestion call.
 * Returns the answer text if detected, null otherwise.
 */
export function extractAskUserQuestionAnswer(
	tool: string,
	args: Record<string, unknown>,
	result: unknown
): { question: string; answer: string } | null {
	// Only process AskUserQuestion tool results — whitelist to prevent false positives
	// tool.includes("question") is too broad (matches unrelated tools like "list_questions")
	const ALLOWED_QUESTION_TOOLS = new Set(["askuserquestion", "ask_user_question", "ask_user"]);
	const normalizedTool = tool.toLowerCase().replace(/[^a-z0-9_]/g, "");
	if (!ALLOWED_QUESTION_TOOLS.has(normalizedTool)) {
		return null;
	}

	// Safely extract question — must be a string
	const question = typeof args.question === "string" ? args.question : "";

	// Safely extract answer — check known shapes before falling back to stringify
	// Svarformen fra AskUserQuestion er umålt; hver gren typesjekkes.
	const svar = somObjekt(result);
	let answer: string;
	if (typeof result === "string") {
		answer = result;
	} else if (typeof svar.answer === "string") {
		answer = svar.answer;
	} else if (typeof svar.response === "string") {
		answer = svar.response;
	} else {
		// Last resort: stringify with safety net
		try {
			answer = JSON.stringify(result ?? "");
		} catch {
			answer = "[unserializable]";
		}
	}

	if (!question || !answer) return null;

	return {
		question: question.slice(0, 500),
		answer: answer.slice(0, 500),
	};
}
