/**
 * Kontrakt-test: kommandoene i SETUP.md slipper gjennom PAIs egen sikkerhetsvakt
 *
 * Kjøreplanen ba modellen kjøre `curl -fsSL https://claude.ai/install.sh | bash`,
 * og vakten (`DANGEROUS_PATTERNS`) blokkerte den midt i steg 5 (MÅLT i LXC 101,
 * #162 fase 5). Modellen fant en omvei, men en gratismodell følger kjøreplanen
 * ordrett og skal ikke måtte det. Hver `Run:`-linje sjekkes mot mønstrene, med
 * `cd` til repoet foran, slik modellen kjører den.
 *
 * `SETUP.md` følger ikke med jobben, så testen hoppes over der.
 *
 * @module tests/kjoreplan-vakt
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DANGEROUS_PATTERNS } from "../.opencode/pai-core/adapters/types";

const SETUP = join(import.meta.dir, "..", "SETUP.md");

describe.skipIf(!existsSync(SETUP))("SETUP.md mot sikkerhetsvakten", () => {
	const kommandoer = existsSync(SETUP)
		? [...readFileSync(SETUP, "utf8").matchAll(/^Run: `([^`]+)`/gm)].map((m) => m[1] as string)
		: [];

	test("kjøreplanen har Run:-linjer å sjekke", () => {
		expect(kommandoer.length).toBeGreaterThan(10);
	});

	test.each(kommandoer.map((k) => [k]))("%s", (k) => {
		const linje = `cd "$(dirname "$(realpath ~/.opencode)")" && ${k}`;
		expect(DANGEROUS_PATTERNS.filter((m) => m.test(linje)).map(String)).toEqual([]);
	});
});
