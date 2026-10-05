/**
 * Kontrakt-test: Biome er pinnet, og `biome.json` følger pinningen (#288)
 *
 * `bun run lint` kjørte `bunx @biomejs/biome` uten versjon, så hver kjøring
 * hentet siste Biome. En ny utgivelse med en ny regel kunne gjort lintingen
 * rød hjemme og på jobb uten at koden var endret, og 2026-10-05 sa CLI-en
 * (2.5.15) fra om at skjemaet i `biome.json` (2.5.14) ikke stemte. Biome
 * står ikke i `node_modules` (AGENTS.md), så pinningen er versjonen i
 * skriptet, og en bump er to linjer: skriptet og skjemaet.
 *
 * @module tests/biome-pinnet
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const lint: string = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts.lint;
const skjema: string = JSON.parse(readFileSync(join(REPO, "biome.json"), "utf8")).$schema;

describe("Biome er pinnet (#288)", () => {
	test("lint-skriptet har en eksakt versjon", () => {
		expect(lint).toMatch(/\bbunx @biomejs\/biome@\d+\.\d+\.\d+ /);
	});

	test("skjemaet i biome.json er for den pinnede versjonen", () => {
		const pinnet = lint.match(/@biomejs\/biome@(\d+\.\d+\.\d+)/)?.[1];
		expect(skjema).toBe(`https://biomejs.dev/schemas/${pinnet}/schema.json`);
	});
});
