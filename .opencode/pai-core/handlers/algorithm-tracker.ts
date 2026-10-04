/**
 * Algorithm Tracker Handler (v3.0)
 *
 * Tracks Algorithm execution state — which phase is active,
 * validates phase transitions, tracks ISC criteria and agent spawns.
 *
 * Ported from PAI v3.0 AlgorithmTracker.hook.ts
 *
 * TO KILDER TIL FASE OG ISC, og den ene er ikke der lenger:
 *
 *   `PRD.md`     `trackPrdState`, når modellen skriver eller redigerer en PRD
 *                under `MEMORY/WORK/`. Motoruavhengig, og den eneste kilden
 *                under OpenCode v2, som ikke har noe todo-verktøy (MÅLT, M2),
 *                og under Claude 5, der TaskCreate/TodoWrite er slått av bak
 *                en modell-allowlist (MÅLT 2026-09-22). `SKILL.md` gjør PRD-en
 *                til system of record for ISC.
 *   TodoWrite    `trackAlgorithmState`, bare på OpenCode v1.
 *
 * @module algorithm-tracker
 */

import * as fs from "node:fs";
import { fileLog, fileLogError } from "../lib/file-logger";
import { somObjekt, somTekst } from "../lib/payload";
import { isSubagentTool } from "../lib/tool-names";
import { getAlgorithmStateFile, getStateDir } from "../lib/paths";
import { erPrdSti, parseFrontmatter } from "./prd-sync";
import { updateISC } from "./work-tracker";

/** Algorithm phases in order */
const PHASES = ["OBSERVE", "THINK", "PLAN", "BUILD", "EXECUTE", "VERIFY", "LEARN"] as const;

type Phase = (typeof PHASES)[number];

interface AlgorithmState {
	sessionId: string;
	active: boolean;
	currentPhase: Phase | null;
	phaseHistory: { phase: Phase; timestamp: string }[];
	criteriaCount: number;
	criteriaCompleted: number;
	agentCount: number;
	effortLevel: string | null;
	startedAt: string;
	updatedAt: string;
}

/**
 * Read current algorithm state from disk.
 *
 * Prefers the session-scoped file (what compaction-intelligence.ts reads).
 * Falls back to the legacy global file for state written before this fix —
 * guarded by the existing sessionId match check, which already prevented
 * cross-session bleed on this path even before session-scoped files existed.
 */
export function readState(sessionId: string): AlgorithmState | null {
	try {
		const scopedPath = getAlgorithmStateFile(sessionId);
		if (fs.existsSync(scopedPath)) {
			return JSON.parse(fs.readFileSync(scopedPath, "utf-8"));
		}

		// Ingen legacy-fallback. `algorithm-state.json` uten sesjonssuffiks
		// var felles for alle økter, og sjekken `data.sessionId === sessionId`
		// gjorde den uansett verdiløs: traff den, fantes den scopede fila
		// allerede; traff den ikke, var dataene en annen økts.
		return null;
	} catch {
		return null;
	}
}

/**
 * Write algorithm state to disk.
 *
 * Skriver KUN den sesjons-scopede fila (`algorithm-state-${sessionId}.json`),
 * som compaction-intelligence.ts sin buildAlgorithmContext() leser.
 *
 * Atomisk (temp + rename): algoritmetilstanden leses av en annen prosess enn
 * den som skriver den, og et halvskrevet JSON-dokument ville gitt en
 * parse-feil som handleren svelger i stillhet.
 */
export function writeState(state: AlgorithmState): void {
	try {
		const stateDir = getStateDir();
		if (!fs.existsSync(stateDir)) {
			fs.mkdirSync(stateDir, { recursive: true });
		}
		state.updatedAt = new Date().toISOString();
		const payload = JSON.stringify(state, null, 2);
		const målfil = getAlgorithmStateFile(state.sessionId);
		const temp = `${målfil}.tmp.${process.pid}`;
		fs.writeFileSync(temp, payload);
		fs.renameSync(temp, målfil);
	} catch (error) {
		fileLogError("[AlgorithmTracker] Failed to write state", error);
	}
}

/**
 * Fjern øktens algoritmetilstand. Kalles sist i teardown.
 *
 * Uten dette ble én fil liggende per økt med et verktøykall — ingen annen
 * rydder rører den, og `pruneStaleState` holder seg med vilje unna. `unknown`
 * er felles skuff for kall uten sesjons-ID og slettes aldri herfra.
 */
export async function clearAlgorithmState(sessionId: string): Promise<void> {
	if (!sessionId || sessionId === "unknown") return;
	await fs.promises.rm(getAlgorithmStateFile(sessionId), { force: true });
}

function nyTilstand(sessionId: string): AlgorithmState {
	return {
		sessionId,
		active: false,
		currentPhase: null,
		phaseHistory: [],
		criteriaCount: 0,
		criteriaCompleted: 0,
		agentCount: 0,
		effortLevel: null,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

/** Kjenner vi fasen igjen? PRD-en er skrevet av modellen, så store og små bokstaver varierer. */
function somFase(verdi: string | undefined): Phase | null {
	const opp = (verdi ?? "").trim().toUpperCase();
	return (PHASES as readonly string[]).includes(opp) ? (opp as Phase) : null;
}

/**
 * ISC-linjene i en PRD: `- [ ] ISC-…` og `- [x] ISC-…`.
 *
 * Samme mønster som `compaction-intelligence` bruker når den bærer
 * kriteriene gjennom en kompaktering, men med stor `X` i tillegg: PRD-en er
 * skrevet av en modell, og `[X]` er like avkrysset.
 */
export function iscFraPrd(innhold: string): { description: string; status: "completed" | "pending" }[] {
	return (innhold.match(/^- \[[ xX]\] ISC-[^\n]+/gm) ?? []).map((linje) => ({
		description: linje.slice(6).trim(),
		status: /^- \[[xX]\]/.test(linje) ? "completed" : "pending",
	}));
}

/**
 * Fase, ISC og effort fra en PRD modellen nettopp skrev.
 *
 * Kalles etter HVER skriving og redigering av en `PRD.md` under
 * `MEMORY/WORK/`, og leser fila på disk framfor verktøyets argumenter: en
 * `edit` bærer bare den endrede biten, og det er hele fila som er
 * kontrakten.
 *
 * Fasen kommer fra `last_phase` (malen) eller `phase`, og registreres i
 * historikken bare når den ENDRES — en PRD redigeres mange ganger i samme
 * fase. En verdi som ikke er en algoritmefase (`null`, `COMPLETE`), endrer
 * ingenting. ISC-tellingen erstattes bare når PRD-en har kriterier: en PRD
 * som ennå ikke har fått dem, skal ikke nulle ut det som er talt fra før.
 */
export async function trackPrdState(filePath: string, sessionId: string): Promise<AlgorithmState | null> {
	if (!erPrdSti(filePath)) return null;
	try {
		let innhold: string;
		try {
			innhold = await fs.promises.readFile(filePath, "utf-8");
		} catch {
			return null;
		}
		const fm = parseFrontmatter(innhold);
		const state = readState(sessionId) ?? nyTilstand(sessionId);
		state.active = true;

		const fase = somFase(fm?.phase);
		if (fase && fase !== state.currentPhase) {
			state.currentPhase = fase;
			state.phaseHistory.push({ phase: fase, timestamp: new Date().toISOString() });
			fileLog(`[AlgorithmTracker] Phase fra PRD: ${fase}`, "info");
		}
		if (fm?.effort_level && fm.effort_level !== "null") state.effortLevel = fm.effort_level;

		const kriterier = iscFraPrd(innhold);
		if (kriterier.length > 0) {
			state.criteriaCount = kriterier.length;
			state.criteriaCompleted = kriterier.filter((k) => k.status === "completed").length;
			fileLog(`[AlgorithmTracker] ISC fra PRD: ${state.criteriaCompleted}/${state.criteriaCount}`, "info");
			try {
				await updateISC(kriterier, sessionId);
			} catch (error) {
				fileLogError("[AlgorithmTracker] ISC bridge fra PRD failed (non-blocking)", error);
			}
		}

		writeState(state);
		return state;
	} catch (error) {
		fileLogError("[AlgorithmTracker] PRD-sporing feilet", error);
		return null;
	}
}

/**
 * Detect which Algorithm phase is being entered based on tool output
 */
function detectPhaseFromOutput(text: string): Phase | null {
	if (!text) return null;
	const str = typeof text === "string" ? text : JSON.stringify(text);

	// Check for phase headers in voice curls or output
	if (str.includes("Observe phase") || str.includes("━━━ 👁️ OBSERVE")) return "OBSERVE";
	if (str.includes("Think phase") || str.includes("━━━ 🧠 THINK")) return "THINK";
	if (str.includes("Plan phase") || str.includes("━━━ 📋 PLAN")) return "PLAN";
	if (str.includes("Build phase") || str.includes("━━━ 🔨 BUILD")) return "BUILD";
	if (str.includes("Execute phase") || str.includes("━━━ ⚡ EXECUTE")) return "EXECUTE";
	if (str.includes("Verify phase") || str.includes("━━━ ✅ VERIFY")) return "VERIFY";
	if (str.includes("Learn phase") || str.includes("━━━ 📚 LEARN")) return "LEARN";

	return null;
}

/**
 * Main tracking function — called from pai-unified.ts after tool execution
 */
export async function trackAlgorithmState(
	toolName: string,
	toolArgs: unknown,
	toolResult: unknown,
	sessionId: string
): Promise<AlgorithmState | null> {
	try {
		let state = readState(sessionId);

		// Initialize state if needed
		if (!state) state = nyTilstand(sessionId);

		const resultStr =
			typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult ?? "");

		// Detect phase from Bash output (voice curls)
		if (toolName.toLowerCase().includes("bash") || toolName === "mcp_bash") {
			const phase = detectPhaseFromOutput(resultStr);
			if (phase) {
				state.active = true;
				state.currentPhase = phase;
				state.phaseHistory.push({
					phase,
					timestamp: new Date().toISOString(),
				});
				fileLog(`[AlgorithmTracker] Phase: ${phase}`, "info");
			}
		}

		// Track ISC criteria via TodoWrite. Bare OpenCode v1 har et
		// todo-verktøy; de andre motorene spores fra PRD-en (`trackPrdState`).
		if (toolName === "mcp_todowrite" || toolName.toLowerCase().includes("todo")) {
			const rå = somObjekt(toolArgs).todos;
			if (Array.isArray(rå)) {
				// Oppføringene er motorens form, ikke vår. Hver leses som et
				// objekt, og et felt som ikke er en streng teller som fraværende.
				const todos = rå.map(somObjekt);
				state.criteriaCount = todos.length;
				state.criteriaCompleted = todos.filter((t) => t.status === "completed").length;
				state.active = true;
				fileLog(
					`[AlgorithmTracker] ISC: ${state.criteriaCompleted}/${state.criteriaCount}`,
					"info"
				);

				// === ISC BRIDGE (Phase 3 — Issue #24) ===
				// Write criteria to the active work session's ISC.json
				try {
					const criteria = todos.map((t) => ({
						description: somTekst(t.content) || somTekst(t.description),
						status: somTekst(t.status) || "pending",
						priority: somTekst(t.priority) || "medium",
					}));
					await updateISC(criteria, sessionId);
					fileLog(`[AlgorithmTracker] ISC.json updated with ${criteria.length} criteria`, "info");
				} catch (error) {
					fileLogError("[AlgorithmTracker] ISC bridge failed (non-blocking)", error);
				}
			}
		}

		// Track agent spawns via subagent-verktøyet.
		//
		// `isSubagentTool`, ikke en lokal navnetest: verktøyet heter `Agent` på
		// Claude Code og `mcp_task` på OpenCode, og den gamle testen her traff
		// kun det siste. Telleren sto derfor på null i hele Claude-økter uten
		// at noe feilet.
		if (isSubagentTool(toolName)) {
			state.agentCount++;
			fileLog(`[AlgorithmTracker] Agent spawned (#${state.agentCount})`, "info");
		}

		writeState(state);
		return state;
	} catch (error) {
		fileLogError("[AlgorithmTracker] Tracking failed", error);
		return null;
	}
}
