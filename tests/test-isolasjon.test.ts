/**
 * Testisolasjonen — at preloaden faktisk isolerer, og at vakten ser (K1)
 *
 * Preloaden er stum når den virker. Uten disse testene ville en bunfig som
 * sluttet å laste den, eller en stubb som ikke traff modulen, sett helt lik
 * ut som en som virker: grønn suite. Det er M-19-klassen.
 *
 * Vakten bevises i BEGGE retninger: den ser en ny, endret og slettet fil, og
 * den er taus når ingenting er rørt. En vakt som roper feil er verre enn
 * ingen (M-23/M-24).
 *
 * @module tests/test-isolasjon
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPaiHome } from "../.opencode/pai-core/lib/paths";
import { inference } from "../.opencode/PAI/Tools/Inference";
import { ekteMemoryRøtter, endringer, INFERENCE_STUBB, taØyeblikksbilde } from "./lib/test-isolasjon";

describe("preloaden", () => {
	test("PAI_HOME peker på en temp-katalog, ikke på repoets .opencode", () => {
		const home = process.env.PAI_HOME;
		expect(home).toBeDefined();
		expect(realpathSync(home as string).startsWith(realpathSync(tmpdir()))).toBe(true);
		expect(getPaiHome()).toBe(home as string);
	});

	test("inference() er stubbet og gjør ikke et modellkall", async () => {
		// Kort frist, så en stubb som ikke traff koster et avbrutt kall og ikke
		// et ekte svar. Feilteksten skiller stubben fra en timeout.
		const svar = await inference({ systemPrompt: "x", userPrompt: "x", level: "fast", timeout: 50 });
		expect(svar.success).toBe(false);
		expect(svar.error).toBe(INFERENCE_STUBB);
	});
});

describe("ekteMemoryRøtter", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), "pai-røtter-")));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	test("tar med $PAI_HOME og cwd/.opencode når de har MEMORY", () => {
		const home = join(tmp, "home");
		const cwd = join(tmp, "cwd");
		mkdirSync(join(home, "MEMORY"), { recursive: true });
		mkdirSync(join(cwd, ".opencode", "MEMORY"), { recursive: true });

		const røtter = ekteMemoryRøtter({ PAI_HOME: home }, cwd);
		expect(røtter).toContain(join(home, "MEMORY"));
		expect(røtter).toContain(join(cwd, ".opencode", "MEMORY"));
	});

	test("slår sammen en symlink og målet, slik ~/.opencode peker inn i repoet", () => {
		mkdirSync(join(tmp, ".opencode", "MEMORY"), { recursive: true });
		symlinkSync(join(tmp, ".opencode"), join(tmp, "lenke"));
		const røtter = ekteMemoryRøtter({ PAI_HOME: join(tmp, "lenke") }, tmp);
		expect(røtter.filter((r) => r.startsWith(tmp))).toEqual([join(tmp, ".opencode", "MEMORY")]);
	});
});

describe("øyeblikksbildet", () => {
	let rot: string;
	const fil = () => join(rot, "STATE", "a.json");

	beforeEach(() => {
		rot = mkdtempSync(join(tmpdir(), "pai-bilde-"));
		mkdirSync(join(rot, "STATE"), { recursive: true });
		writeFileSync(fil(), "{}");
	});

	afterEach(() => {
		rmSync(rot, { recursive: true, force: true });
	});

	test("er taust når ingenting er rørt", () => {
		const før = taØyeblikksbilde([rot]);
		expect(endringer(før, taØyeblikksbilde([rot]))).toEqual([]);
	});

	test("ser en ny fil, også dypt i treet", () => {
		const før = taØyeblikksbilde([rot]);
		mkdirSync(join(rot, "WORK", "2026-09", "økt"), { recursive: true });
		writeFileSync(join(rot, "WORK", "2026-09", "økt", "META.yaml"), "status: ACTIVE");
		expect(endringer(før, taØyeblikksbilde([rot]))).toEqual([
			`ny:      ${join(rot, "WORK", "2026-09", "økt", "META.yaml")}`,
		]);
	});

	test("ser en overskriving med samme størrelse", () => {
		// Samme lengde, nytt innhold: størrelsen alene ville ikke sett det.
		const før = taØyeblikksbilde([rot]);
		writeFileSync(fil(), "[]");
		utimesSync(fil(), new Date(), new Date(Date.now() + 5000));
		expect(endringer(før, taØyeblikksbilde([rot]))).toEqual([`endret:  ${fil()}`]);
	});

	test("ser en slettet fil", () => {
		const før = taØyeblikksbilde([rot]);
		rmSync(fil());
		expect(endringer(før, taØyeblikksbilde([rot]))).toEqual([`slettet: ${fil()}`]);
	});
});
