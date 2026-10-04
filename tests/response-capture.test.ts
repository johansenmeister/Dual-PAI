/**
 * response-capture: det den gjør med oppgavens filer (M-46)
 *
 * `updateTaskMeta` skulle skrive `status`, `completedAt` og `summary` i
 * frontmatteren til oppgavens THREAD.md, men work-tracker lager den uten
 * frontmatter (`**Status:** ACTIVE`). Ingen av regexene traff, fila ble skrevet
 * tilbake uendret, og loggen sa «Updated task THREAD». MÅLT 2026-09-27: 0 av 40
 * oppgave-THREAD-er i MEMORY hadde feltene, og ingenting leste dem. Funksjonen
 * er fjernet; statusen settes ved teardown (`markThreadsCompleted`).
 *
 * Isolert via PAI_HOME og PAI_LOG_PATH.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponseCapture } from "../.opencode/pai-core/handlers/response-capture";
import { createWorkSession } from "../.opencode/pai-core/handlers/work-tracker";

let hjem: string;
const lagret: Record<string, string | undefined> = {};

beforeEach(() => {
	hjem = mkdtempSync(join(tmpdir(), "pai-response-capture-"));
	for (const k of ["PAI_HOME", "PAI_LOG_PATH"]) lagret[k] = process.env[k];
	process.env.PAI_HOME = hjem;
	process.env.PAI_LOG_PATH = join(hjem, "debug.log");
});

afterEach(() => {
	for (const [k, v] of Object.entries(lagret)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(hjem, { recursive: true, force: true });
});

function oppgave(): string {
	const work = join(hjem, "MEMORY", "WORK");
	const ym = readdirSync(work)[0];
	return join(work, ym, readdirSync(join(work, ym))[0], "tasks", "main");
}

describe("M-46: oppgavens filer etter et svar", () => {
	test("ISC.json får statusen; THREAD.md røres ikke, og loggen påstår ikke at den gjorde det", async () => {
		const sesjon = "m46-test";
		expect((await createWorkSession("Sjekk oppgavens filer etter et svar", sesjon)).success).toBe(true);
		const dir = oppgave();
		const tråd = readFileSync(join(dir, "THREAD.md"), "utf-8");

		await handleResponseCapture("📋 SUMMARY: Ferdig.\n\n✓ COMPLETE\n\n🗣️ Ada Lovelace: Oppgaven er fullført.", sesjon);

		const isc = JSON.parse(readFileSync(join(dir, "ISC.json"), "utf-8"));
		expect(isc.status).toBe("COMPLETE");
		expect(readFileSync(join(dir, "THREAD.md"), "utf-8")).toBe(tråd);
		const logg = existsSync(process.env.PAI_LOG_PATH as string) ? readFileSync(process.env.PAI_LOG_PATH as string, "utf-8") : "";
		expect(logg).not.toContain("Updated task THREAD");
	});
});
