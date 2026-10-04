/**
 * OpenCode-adapteren — det PAIs egne verktøy svarer
 *
 * `session_registry`, `session_results` og `code_review`. Skilt ut da v1 og v2
 * registrerte verktøyene hver på sin måte (v1 med `tool()` og zod, v2 med
 * `tool.transform` og JSON Schema, MÅLT M10) og skulle svare det samme. v1 er
 * slettet; v2-adapterens `verktoy.ts` er nå eneste innpakning. Katalogen står
 * for at vakten «adapteren er tynn» fortsatt teller registreringen, ikke
 * svarteksten.
 *
 * Importerer ingen motor. Claude-siden har sine egne, norske varianter i
 * `claude-plugin/mcp/pai-mcp.ts`; de er ikke flyttet hit, fordi det ville
 * endret teksten modellen får der.
 *
 * @module pai-adapters/opencode-felles/verktoy
 */

import { readFileSync } from "node:fs";
import {
	isRoborevAvailable,
	type ReviewMode,
	runRoborev,
} from "../../pai-core/handlers/roborev-trigger";
import {
	readRegistry,
	sanitizeForMarkdown,
	type SubagentRegistry,
} from "../../pai-core/handlers/session-registry";
import { fileLog, fileLogError } from "../../pai-core/lib/file-logger";

export const SESSION_REGISTRY_BESKRIVELSE =
	"List all subagent sessions spawned in this session. Returns session IDs, agent types, and descriptions. " +
	"Use this after context compaction to recover information about previously spawned subagents. " +
	"The results are always available — subagent data survives compaction.";

export const SESSION_RESULTS_BESKRIVELSE =
	"Get what a subagent session produced, by session_id from session_registry. " +
	"Returns agent type, description, status, and the captured final answer when one exists. " +
	"Use this to recover a subagent's result after compaction.";

export const SESSION_ID_ARG_BESKRIVELSE =
	"The session ID of the subagent (e.g., ses_abc123). Get IDs from session_registry.";

export const CODE_REVIEW_BESKRIVELSE =
	"Run roborev AI code review on current changes. " +
	"Use during VERIFY phase or after BUILD to catch quality issues before committing. " +
	"Modes: 'dirty' reviews uncommitted changes, 'last-commit' reviews the last commit, " +
	"'fix' feeds findings to agent for fixes, 'refine' runs auto-fix loop. " +
	"Requires roborev to be installed: brew install roborev-dev/tap/roborev";

export const CODE_REVIEW_MODE_BESKRIVELSE =
	"Review mode: 'dirty' for uncommitted changes (most common), " +
	"'last-commit' for the last commit, " +
	"'fix' to apply findings, 'refine' for auto-fix loop.";

export const CODE_REVIEW_PATH_BESKRIVELSE =
	"Optional file path or glob to focus the review on specific files. " +
	"Only valid for mode 'dirty' and 'last-commit'. " +
	"Not supported for mode 'fix' or 'refine' (those operate on roborev's internal state).";

export const REVIEW_MODES: readonly ReviewMode[] = ["dirty", "last-commit", "fix", "refine"];

const REGISTER_UTILGJENGELIG =
	"Registry unavailable: could not read session data (I/O error). Check file permissions on the state directory.";

function lesRegister(sessionId: string, kaller: string): SubagentRegistry | undefined {
	try {
		return readRegistry(sessionId);
	} catch (err) {
		fileLog(`[session-registry] ${kaller}: failed to read registry: ${err}`, "error");
		return undefined;
	}
}

/** Svaret fra `session_registry` for økten. */
export function sessionRegistrySvar(sessionId: string): string {
	const registry = lesRegister(sessionId, "session_registry");
	if (!registry) return REGISTER_UTILGJENGELIG;

	if (registry.entries.length === 0) {
		return "No subagent sessions found for this session. No subagents have been spawned yet.";
	}

	const lines = [
		`## Subagent Registry (${registry.entries.length} sessions)`,
		"",
		"| # | Agent Type | Session ID | Description | Status | Spawned At |",
		"|---|-----------|-----------|-------------|--------|------------|",
	];
	registry.entries.forEach((e, i) => {
		lines.push(
			`| ${i + 1} | ${e.agentType} | ${e.sessionId} | ${sanitizeForMarkdown(e.description, 60, true)} | ${e.status} | ${e.spawnedAt} |`
		);
	});
	lines.push("", "Use `session_results` with any session_id above to retrieve what that subagent produced.");
	return lines.join("\n");
}

/**
 * Svaret fra `session_results`.
 *
 * Det FANGEDE svaret når registeroppføringen har en `outputPath`, som
 * Claude-varianten gjør. Uten det, det motoren kan tilby: `utenFangst` er
 * adapterens egen tekst, fordi bare v1 kan gjenoppta en subagent
 * (`Task({session_id})`). v2s `subagent` tar `{agent, description, prompt}`
 * og ingen sesjons-ID (MÅLT, M2).
 */
export function sessionResultsSvar(
	sessionId: string,
	ønsket: string,
	utenFangst: (subagentId: string) => string[] = () => []
): string {
	const id = ønsket.trim();
	if (!id) return "Missing `session_id`. Run `session_registry` first.";

	const registry = lesRegister(sessionId, "session_results");
	if (!registry) return REGISTER_UTILGJENGELIG;

	const entry = registry.entries.find((e) => e.sessionId === id);
	if (!entry) {
		return `Session ${id} not found in the registry for this session. Use session_registry to see available sessions.`;
	}

	const hode = [
		`## Subagent Session: ${id}`,
		"",
		`**Agent:** ${entry.agentType}`,
		`**Description:** ${entry.description}`,
		`**Spawned:** ${entry.spawnedAt}`,
		`**Status:** ${entry.status}`,
		"",
	];

	if (entry.outputPath) {
		try {
			return [...hode, "---", "", readFileSync(entry.outputPath, "utf-8")].join("\n");
		} catch (error) {
			fileLogError("[session-registry] session_results: could not read captured output", error);
			return [...hode, `Captured output should be at \`${entry.outputPath}\`, but the file could not be read.`].join("\n");
		}
	}

	const reserve = utenFangst(id);
	if (reserve.length > 0) return [...hode, ...reserve].join("\n");
	return [
		...hode,
		entry.status === "running"
			? "The subagent is still running — its answer is captured when it finishes."
			: "No captured output for this subagent.",
	].join("\n");
}

/** Er verdien en av roborevs moduser? Argumentene kommer ubehandlet fra v2. */
export function erReviewMode(verdi: unknown): verdi is ReviewMode {
	return typeof verdi === "string" && (REVIEW_MODES as readonly string[]).includes(verdi);
}

/** Svaret fra `code_review`. */
export async function codeReviewSvar(args: { mode?: ReviewMode; path?: string }): Promise<string> {
	const mode = args.mode ?? "dirty";

	// Validate: path is only supported for "dirty" and "last-commit" modes.
	// "fix" and "refine" operate on roborev's own internal state and do not
	// accept a file filter — passing path would be silently ignored otherwise.
	if (args.path && (mode === "fix" || mode === "refine")) {
		return [
			`## Invalid Combination: path + mode="${mode}"`,
			"",
			`The \`path\` argument is not supported for mode \`"${mode}"\`.`,
			"",
			`**Why:** \`roborev ${mode}\` operates on roborev's internal review state, not on a file filter.`,
			"Specifying a path would be silently ignored.",
			"",
			"**Options:**",
			`- Remove the \`path\` argument and run \`code_review\` with \`mode: "${mode}"\` to ${mode === "fix" ? "apply findings from the last review" : "run the auto-fix loop"}.`,
			`- Or run \`code_review\` with \`mode: "dirty"\` and \`path: "${args.path}"\` to review specific files.`,
		].join("\n");
	}

	if (!(await isRoborevAvailable())) {
		return [
			"## roborev Not Found",
			"",
			"roborev is not installed or not in your PATH.",
			"",
			"**Install roborev:**",
			"```bash",
			"# macOS / Linux (Homebrew)",
			"brew install roborev-dev/tap/roborev",
			"",
			"# Or via Go",
			"go install github.com/roborev-dev/roborev@latest",
			"```",
			"",
			"**One-time setup:**",
			"```bash",
			"roborev init            # installs git post-commit hook",
			"roborev skills install  # installs OpenCode skill",
			"```",
			"",
			"After installation, re-run `code_review` to review your changes.",
		].join("\n");
	}

	let roborevArgs: string[];
	switch (mode) {
		case "dirty":
			roborevArgs = ["review", "--dirty"];
			if (args.path) roborevArgs.push("--", args.path);
			break;
		case "last-commit":
			roborevArgs = ["review"];
			if (args.path) roborevArgs.push("--", args.path);
			break;
		case "fix":
			roborevArgs = ["fix"];
			break;
		case "refine":
			roborevArgs = ["refine"];
			break;
		default:
			roborevArgs = ["review", "--dirty"];
	}

	fileLog(`[roborev] Starting ${mode} review...`, "info");

	const result = await runRoborev(roborevArgs);

	if (!result.success && result.output.includes("no changes")) {
		return [
			"## roborev: No Changes to Review",
			"",
			"No uncommitted changes found. Use `mode: 'last-commit'` to review the last commit,",
			"or make some changes first.",
		].join("\n");
	}

	const status = result.success ? "✅ PASSED" : "⚠️ FINDINGS";

	return [
		`## roborev Code Review — ${status}`,
		`**Mode:** ${mode}`,
		`**Exit code:** ${result.exitCode}`,
		"",
		"### Output",
		"",
		result.output,
		"",
		result.success
			? "_No issues found. Code review passed._"
			: [
					"_Review complete. Address findings above._",
					"",
					"**Next steps:**",
					"- Fix issues manually, then re-run `code_review`",
					"- Or run `code_review` with `mode: 'fix'` to let the agent apply fixes",
					"- Or run `code_review` with `mode: 'refine'` for an auto-fix loop",
				].join("\n"),
	].join("\n");
}
