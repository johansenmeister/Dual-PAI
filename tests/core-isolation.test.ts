/**
 * Kontrakt-test: pai-core er harness-uavhengig
 *
 * Hele poenget med pai-core er at den ikke vet hvilken motor den kjører
 * under. Det er en egenskap som forsvinner stille — én import lagt til av
 * bekvemmelighet, og kjernen er bundet igjen uten at noe feiler.
 *
 * Derfor håndheves den her framfor å stå som en kommentar i types.ts.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KJERNE = join(import.meta.dir, "..", ".opencode", "pai-core");

function tsFiler(dir: string): string[] {
	const ut: string[] = [];
	for (const navn of readdirSync(dir)) {
		const full = join(dir, navn);
		if (statSync(full).isDirectory()) ut.push(...tsFiler(full));
		else if (navn.endsWith(".ts")) ut.push(full);
	}
	return ut;
}

/** Fjerner blokk- og linjekommentarer, så prosa om forbudet ikke gir falske treff. */
function utenKommentarer(kilde: string): string {
	return kilde.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("pai-core importerer aldri motorspesifikke moduler", () => {
	const filer = tsFiler(KJERNE);

	test("det finnes faktisk filer å sjekke", () => {
		// Uten denne ville testen bestått trivielt om katalogen ble flyttet.
		expect(filer.length).toBeGreaterThan(30);
	});

	test.each(filer.map((f) => [f.slice(f.indexOf("pai-core")), f]))("%s", (_navn, full) => {
		const kode = utenKommentarer(readFileSync(full, "utf-8"));
		expect(kode).not.toContain("@opencode-ai/");
		// v2s pakker. Kjernen skal ikke vite at det finnes to OpenCode-er.
		expect(kode).not.toContain("@opencode/");
		expect(kode).not.toContain("@anthropic-ai/");
	});
});

describe("adapterlaget eier motorkoblingen", () => {
	test("pai-adapters/opencode-v2 importerer v2s plugin-API", () => {
		// Speilvendingen av testen over: kjernen importerer aldri `@opencode/*`,
		// og v2-adapteren er stedet den importen bor.
		const kode = readFileSync(
			join(import.meta.dir, "..", ".opencode", "pai-adapters", "opencode-v2", "index.ts"),
			"utf-8"
		);
		expect(kode).toContain('from "@opencode/plugin"');
	});
});
