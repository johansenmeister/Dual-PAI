/**
 * Preload for hele `bun test` — lastes via `bunfig.toml` før første testfil
 *
 * Tre ting, i denne rekkefølgen (K1):
 *
 *   1. Øyeblikksbilde av de ekte MEMORY-trærne, FØR `PAI_HOME` flyttes.
 *   2. `PAI_HOME` til en temp-katalog. Filene som isolerer seg selv, lagrer
 *      og gjenoppretter denne verdien, så også en skriving som kommer etter
 *      at fila er ferdig, havner her og ikke i det ekte treet.
 *   3. `inference()` stubbet. `bun test` skal aldri gjøre et modellkall.
 *
 * Den globale `afterAll` kjører én gang etter alle filene. Har noe i de ekte
 * trærne endret seg, kaster den, og bun teller det som en feilet test med
 * exit 1 (MÅLT 2026-09-26, bun 1.4.2). Det som da er igjen å fange, er kode
 * som går utenom `PAI_HOME`, for eksempel en hardkodet `~/.opencode`.
 *
 * @module tests/preload
 */

import { afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ekteMemoryRøtter, endringer, INFERENCE_STUBB, taØyeblikksbilde } from "./lib/test-isolasjon";

const røtter = ekteMemoryRøtter();
const før = taØyeblikksbilde(røtter);

const testHjem = mkdtempSync(join(tmpdir(), "pai-test-hjem-"));
process.env.PAI_HOME = testHjem;

mock.module(join(import.meta.dir, "../.opencode/PAI/Tools/Inference.ts"), () => ({
	inference: async (options: { level?: string }) => ({
		success: false,
		output: "",
		error: INFERENCE_STUBB,
		latencyMs: 0,
		level: options?.level ?? "standard",
	}),
}));

afterAll(() => {
	rmSync(testHjem, { recursive: true, force: true });

	const funn = endringer(før, taØyeblikksbilde(røtter));
	if (funn.length === 0) return;
	throw new Error(
		[
			`bun test endret ${funn.length} fil(er) i det EKTE MEMORY-treet:`,
			...funn.slice(0, 20).map((f) => `  ${f}`),
			...(funn.length > 20 ? [`  … og ${funn.length - 20} til`] : []),
			"",
			"Rydd dem, og finn testen som skrev utenom PAI_HOME (tests/preload.ts).",
			"Kjørte en PAI-økt på maskinen samtidig, kan det være den: kjør suiten på nytt uten.",
		].join("\n")
	);
});
