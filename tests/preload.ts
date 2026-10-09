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
 *   4. `fetch` notert. Et kall til en annen vert enn maskinen selv feiler
 *      suiten til slutt, som MEMORY-vakten (#189: versjonssjekken i
 *      `session.start` gikk mot GitHub ved hver test gjennom den, og tre
 *      tester falt når GitHub var tregt). Kallet går fortsatt gjennom, så
 *      en test som trenger nettet, feiler med navnet på verten, ikke stumt.
 *      Det dekker testprosessen, ikke underprosessene den starter.
 *   5. The variables `pai` exports into a session cleared: `PAI_CONTEXT_FILE`,
 *      `PAI_ENABLED`, `PAI_HARNESS`. Run inside a `pai --claude` session, the
 *      suite inherited `PAI_CONTEXT_FILE`, and the Claude adapter left out
 *      `context.build` as it should in a session, so two tests failed on the
 *      machine and nowhere else (job issue 15, 2026-10-08).
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

for (const name of ["PAI_CONTEXT_FILE", "PAI_ENABLED", "PAI_HARNESS"]) delete process.env[name];

mock.module(join(import.meta.dir, "../.opencode/PAI/Tools/Inference.ts"), () => ({
	inference: async (options: { level?: string }) => ({
		success: false,
		output: "",
		error: INFERENCE_STUBB,
		latencyMs: 0,
		level: options?.level ?? "standard",
	}),
}));

const LOKALE = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const fremmedeVerter = new Set<string>();
const ekteFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		try {
			const { hostname, host } = new URL(url);
			if (!LOKALE.has(hostname)) fremmedeVerter.add(host);
		} catch {
			// en relativ URL når ingen vert
		}
		return ekteFetch(input, init);
	},
	ekteFetch
);

afterAll(() => {
	if (fremmedeVerter.size > 0) {
		throw new Error(
			`bun test gikk på nettet: ${[...fremmedeVerter].join(", ")}. Stubb kallet i testen, eller fjern det fra koden (tests/preload.ts, #189).`
		);
	}
});

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
