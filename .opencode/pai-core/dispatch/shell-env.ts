/**
 * PAI Core — miljø til skallprosesser
 *
 * Flyttet fra `shell.env`-hooken i `plugins/pai-unified.ts`.
 *
 * OpenCode-bash er TILSTANDSLØS: hvert kall spawner en frisk prosess, så
 * dette er eneste pålitelige måte å gi et skript kjøretidskontekst på.
 *
 * Nøklene i `.opencode/.env` kommer IKKE herfra, og ikke fra motoren: verken
 * v2, Claude Code eller `pai` laster fila (MÅLT 2026-10-03; Bun laster `.env`
 * bare fra sin egen cwd, og `pai` starter fra repo-roten). Hvert verktøy leser
 * fila selv, eller arbeidsflyten `source`-er den. Det denne funksjonen gir, er
 * KJØRETIDS-kontekst (sesjons-ID, arbeidskatalog) og videreføring av nøkler som
 * er eksportert i skallet `pai` ble startet fra.
 *
 * Claude Code har ingen tilsvarende hook (gap 1). `settings.json.env` får
 * bevisst ingen nøkler (`Tools/PatchClaudeSettings.ts`); de dynamiske verdiene
 * går via en betinget `updatedInput`-omskriving i PreToolUse.
 *
 * Importerer ingen motor.
 *
 * @module pai-core/dispatch/shell-env
 */

import { fileLog } from "../lib/file-logger";
import type { PaiResult, PaiShellEnvEvent } from "../types";

/**
 * Eksplisitt videreføring for nøkler PAI-skript kan trenge i Bash, når de er
 * eksportert i skallet `pai` ble startet fra. Fra `.env` kommer de ikke.
 */
const PASSTHROUGH_KEYS = [
	"PAI_OBSERVABILITY_PORT",
	"PAI_OBSERVABILITY_ENABLED",
	"GOOGLE_API_KEY", // Used by transcription scripts
	"DA", // Agent name (Jeremy)
	"TIME_ZONE", // Timezone for date formatting in scripts
] as const;

export async function buildShellEnv(event: PaiShellEnvEvent): Promise<PaiResult> {
	const sessionId = event.sessionId || "unknown";
	const env: Record<string, string> = {
		// PAI runtime context (not in .env — dynamically computed per call)
		PAI_CONTEXT: "1",
		PAI_SESSION_ID: sessionId,
		PAI_WORK_DIR: event.cwd || "",
		PAI_VERSION: "3.0",
	};

	for (const key of PASSTHROUGH_KEYS) {
		const value = process.env[key];
		if (value) {
			env[key] = value;
		}
	}

	fileLog(`[shell.env] Context injected for session ${sessionId}`, "debug");
	return { env };
}
