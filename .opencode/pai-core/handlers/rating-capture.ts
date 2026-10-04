/**
 * Rating Capture Handler
 *
 * Equivalent to PAI v2.4 ExplicitRatingCapture hook.
 * Detects user ratings (1-10) and persists to MEMORY/LEARNING/
 *
 * @module rating-capture
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import { ensureDir, getLearningDir, getTimestamp, getYearMonth, slugify } from "../lib/paths";
import { currentHarness } from "../runtime";

/**
 * Rating entry structure
 */
export interface RatingEntry {
	score: number;
	comment: string;
	timestamp: string;
	source: "explicit";
	context?: string;
}

/**
 * Capture rating result
 */
export interface CaptureRatingResult {
	success: boolean;
	rating?: RatingEntry;
	learned?: boolean;
	error?: string;
}

/**
 * Rating patterns to detect
 *
 * Matches patterns like:
 * - "8" (just a number)
 * - "8/10"
 * - "8 - good work"
 * - "7: needs improvement"
 * - "10!"
 *
 * NOT "9 excellent": a number followed by plain text is just as often a
 * count — «3 tester feiler», «2 filer mangler» — and was scored 3/10, with a
 * low-rating learning to go with it (M-03). Without a separator the message
 * goes to implicit sentiment instead, which reads the words.
 */
const RATING_PATTERNS = [
	// "8" or "8!" or "10!"
	/^(\d{1,2})!*$/,
	// "8/10" or "9/10"
	/^(\d{1,2})\/10/,
	// "8 - comment" or "8: comment" or "8, comment"
	/^(\d{1,2})\s*[-:,]\s*(.+)$/,
];

/**
 * Detect rating in user message
 *
 * Multi-line aware: checks ONLY the first line for rating patterns.
 * Rest of the message is preserved as context/comment.
 *
 * Examples:
 * - "8" → score: 8, comment: ""
 * - "7\nGut gemacht" → score: 7, comment: "Gut gemacht"
 * - "9 - excellent\n\nNext task..." → score: 9, comment: "excellent", context: "Next task..."
 * - "6: needs work" → score: 6, comment: "needs work"
 *
 * Returns null if no rating detected
 */
export function detectRating(message: string): RatingEntry | null {
	const trimmed = message.trim();

	// Split into lines - only check FIRST line for rating
	const lines = trimmed.split("\n");
	const firstLine = lines[0].trim();

	// Skip if first line is too long (likely not a rating)
	if (firstLine.length > 50) return null;

	// Skip if first line starts with common non-rating patterns
	if (/^(the|a|an|i|we|it|this|that|please|can|could|would|should|let)/i.test(firstLine)) {
		return null;
	}

	for (const pattern of RATING_PATTERNS) {
		const match = firstLine.match(pattern);
		if (match) {
			const score = parseInt(match[1], 10);

			// Valid score range: 1-10
			if (score >= 1 && score <= 10) {
				// Get inline comment from the pattern match (e.g., "9 - excellent")
				const inlineComment = match[2]?.trim() || "";

				// Get rest of message (lines after first) as additional context
				const restOfMessage = lines.slice(1).join("\n").trim();

				// Comment = inline comment OR first non-empty line of rest
				// Context = full rest of message (for reference)
				let comment = inlineComment;
				if (!comment && restOfMessage) {
					// Use first line of rest as comment
					const firstRestLine = restOfMessage.split("\n")[0].trim();
					comment = firstRestLine;
				}

				return {
					score,
					comment,
					timestamp: new Date().toISOString(),
					source: "explicit",
					context: restOfMessage || undefined,
				};
			}
		}
	}

	return null;
}

/**
 * Capture and persist rating
 *
 * Writes to:
 * - MEMORY/LEARNING/SIGNALS/ratings.jsonl (all ratings)
 * - MEMORY/LEARNING/ALGORITHM/{YYYY-MM}/*.md (for low ratings, learnings)
 */
export async function captureRating(
	message: string,
	context?: string
): Promise<CaptureRatingResult> {
	try {
		const rating = detectRating(message);

		if (!rating) {
			return { success: true, rating: undefined };
		}

		rating.context = context;

		// Ensure directories exist
		const learningDir = getLearningDir();
		const signalsDir = path.join(learningDir, "SIGNALS");
		await ensureDir(signalsDir);

		// Append to ratings.jsonl
		const ratingsFile = path.join(signalsDir, "ratings.jsonl");
		const line = `${JSON.stringify({ ...rating, harness: currentHarness() })}\n`;
		await fs.promises.appendFile(ratingsFile, line);

		fileLog(`Rating captured: ${rating.score}/10`, "info");

		// For low ratings (< 7) AND not neutral (≠ 5), create a learning file
		// 5/10 is "meh" — no actionable feedback, creates noise in LEARNING/ (upstream 84bbce8)
		let learned = false;
		if (rating.score < 7 && rating.score !== 5 && rating.comment) {
			learned = await createLearningFromRating(rating);
		}

		return { success: true, rating, learned };
	} catch (error) {
		fileLogError("Failed to capture rating", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Create learning file from low rating
 */
async function createLearningFromRating(rating: RatingEntry): Promise<boolean> {
	try {
		const learningDir = getLearningDir();
		const yearMonth = getYearMonth();
		const timestamp = getTimestamp();

		// Determine category based on comment
		const category = inferCategory(rating.comment);
		const categoryDir = path.join(learningDir, category, yearMonth);
		await ensureDir(categoryDir);

		const slug = slugify(rating.comment.slice(0, 30));
		const filename = `${timestamp}_rating_${slug}.md`;
		const filepath = path.join(categoryDir, filename);

		const content = `# Learning from Rating: ${rating.score}/10

**Timestamp:** ${rating.timestamp}
**Score:** ${rating.score}/10
**Feedback:** ${rating.comment}
**Source:** explicit rating

---

## Context

${rating.context || "No context available"}

---

## What to Improve

Based on this feedback, consider:
- ${rating.comment}

---

*Auto-generated from explicit rating capture*
`;

		await fs.promises.writeFile(filepath, content);
		fileLog(`Learning created from low rating: ${filename}`, "info");
		return true;
	} catch (error) {
		fileLogError("Failed to create learning from rating", error);
		return false;
	}
}

/**
 * Infer learning category from comment
 */
function inferCategory(comment: string): string {
	const lower = comment.toLowerCase();

	if (/algorithm|process|workflow|method/i.test(lower)) {
		return "ALGORITHM";
	}
	if (/system|infra|config|setup/i.test(lower)) {
		return "SYSTEM";
	}
	if (/code|bug|error|fix/i.test(lower)) {
		return "CODE";
	}
	if (/response|format|output/i.test(lower)) {
		return "RESPONSE";
	}

	return "GENERAL";
}

/**
 * Get recent ratings
 */
export async function getRecentRatings(limit = 10): Promise<RatingEntry[]> {
	try {
		const signalsDir = path.join(getLearningDir(), "SIGNALS");
		const ratingsFile = path.join(signalsDir, "ratings.jsonl");

		const content = await fs.promises.readFile(ratingsFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);

		return lines
			.slice(-limit)
			.map((line) => JSON.parse(line) as RatingEntry)
			.reverse();
	} catch {
		return [];
	}
}

/**
 * Calculate average rating
 */
export async function getAverageRating(): Promise<number | null> {
	const ratings = await getRecentRatings(100);
	if (ratings.length === 0) return null;

	const sum = ratings.reduce((acc, r) => acc + r.score, 0);
	return sum / ratings.length;
}
