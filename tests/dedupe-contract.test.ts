/**
 * Kontrakt-test: meldings-dedupe (H-08)
 *
 * Dedupe finnes fordi «chat.message» og «message.updated» begge fyrer for
 * samme brukermelding. Uten den ville arbeidsøkt, rating og THREAD-innslag
 * skrives to ganger.
 *
 * Nøkkelen manglet sessionId (H-08). To samtidige økter som sendte samme
 * tekst innen TTL-vinduet dedupet hverandres meldinger, og den andre økten
 * mistet alt — stille, slik alle defektene i dette repoet er.
 *
 * Fra batch 5 ligger vinduet på DISK, ikke i en modulvariabel. Det er ikke
 * en optimalisering som ble reversert: Claude Code kjører én prosess per
 * hook-event, så et minnebasert vindu ville vært tomt hver gang og dedupe
 * hadde aldri slått til der.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wasMessageRecentlyProcessed } from "../.opencode/pai-core/dispatch/state";

// Vinduet skrives til STATE/. Uten isolasjon havner testfilene i brukerens
// ekte MEMORY-tre.
let tempHome: string;
let opprinnelig: string | undefined;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "pai-dedupe-test-"));
	opprinnelig = process.env.PAI_HOME;
	process.env.PAI_HOME = tempHome;
});

afterEach(() => {
	if (opprinnelig === undefined) delete process.env.PAI_HOME;
	else process.env.PAI_HOME = opprinnelig;
	rmSync(tempHome, { recursive: true, force: true });
});

/** Unik tekst per test, så tester ikke forurenser hverandres cache. */
function unik(merkelapp: string): string {
	return `${merkelapp}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

describe("dedupe innenfor én økt", () => {
	test("første gang er ikke duplikat, andre gang er det", async () => {
		const tekst = unik("samme-økt");
		expect(await wasMessageRecentlyProcessed("oc_a", tekst)).toBe(false);
		expect(await wasMessageRecentlyProcessed("oc_a", tekst)).toBe(true);
	});

	test("ulik tekst i samme økt dedupes ikke", async () => {
		const nøkkel = "oc_b";
		expect(await wasMessageRecentlyProcessed(nøkkel, unik("en"))).toBe(false);
		expect(await wasMessageRecentlyProcessed(nøkkel, unik("to"))).toBe(false);
	});
});

describe("H-08 — nøkkelen er sesjons-scopet", () => {
	test("samme tekst i to økter dedupes IKKE", async () => {
		// Kjernen i defekten. Slår denne feil, kan en samtidig økt spise den
		// andres melding uten at noe logges.
		const tekst = unik("to-økter");
		expect(await wasMessageRecentlyProcessed("oc_økt1", tekst)).toBe(false);
		expect(await wasMessageRecentlyProcessed("oc_økt2", tekst)).toBe(false);
	});

	test("samme rå ID under to motorer dedupes ikke mot hverandre", async () => {
		// Delt MEMORY-tre betyr at begge harness kan kjøre samtidig.
		const tekst = unik("to-motorer");
		expect(await wasMessageRecentlyProcessed("oc_ses_x", tekst)).toBe(false);
		expect(await wasMessageRecentlyProcessed("cc_ses_x", tekst)).toBe(false);
	});

	test("økt-scopingen opphever ikke dedupe innenfor økten", async () => {
		// Speilvendingen: scopingen skal ikke gjøre dedupe virkningsløs.
		const tekst = unik("begge-deler");
		expect(await wasMessageRecentlyProcessed("oc_økt1", tekst)).toBe(false);
		expect(await wasMessageRecentlyProcessed("oc_økt2", tekst)).toBe(false);
		expect(await wasMessageRecentlyProcessed("oc_økt1", tekst)).toBe(true);
		expect(await wasMessageRecentlyProcessed("oc_økt2", tekst)).toBe(true);
	});
});
