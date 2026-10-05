/**
 * claude-sti.ts — hvilken `claude` et verktøy skal starte (#247).
 *
 * `Inference.ts` startet `claude` fra PATH. Under cron er PATH `/usr/bin:/bin`,
 * og den offisielle installeren legger `claude` i `~/.local/bin`, så den
 * månedlige MineReflections-kjøringen på `pai` feilet 2026-10-01 med
 * «Executable not found in $PATH: "claude"» (MÅLT i cron-loggen der).
 *
 * Samme rekkefølge som launcherens `resolveClaudeExecutable` (`pai.ts`):
 * `PAI_CLAUDE_BIN`, så installerens `~/.local/bin/claude`, så `claude` fra
 * PATH. `env` er et argument, så en test aldri treffer brukerens egen.
 *
 * @module claude-sti
 */

import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export function claudeSti(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PAI_CLAUDE_BIN) return env.PAI_CLAUDE_BIN;
  if (env.HOME) {
    const lokal = join(env.HOME, ".local", "bin", "claude");
    try {
      accessSync(lokal, constants.X_OK);
      return lokal;
    } catch {
      // ikke installert med installeren: PATH under
    }
  }
  return "claude";
}
