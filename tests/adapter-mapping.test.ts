/**
 * Kontrakt-test: OpenCode-adapteren (v2) forblir tynn
 *
 * Batch 4 flyttet logikken fra v1-pluginen til pai-core, og denne fila var
 * vaktposten mot at den sig tilbake én bekvemmelighetsimport om gangen. v1 er
 * slettet (fase 7); vakten gjelder nå `pai-adapters/opencode-v2/`, med de
 * samme to tillatte handlerne.
 *
 * Feltplasseringene i v2 er låst av `opencode-v2-*.test.ts` og `V2Smoke`, som
 * kjører mot den ekte binæren. Her leses bare kilden.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROT = join(import.meta.dir, "..", ".opencode");
const ADAPTER = join(ROT, "pai-adapters", "opencode-v2");

/** Fjerner kommentarer, så prosa om et felt ikke teller som bruk av det. */
function utenKommentarer(kilde: string): string {
	return kilde.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const filer = readdirSync(ADAPTER).filter((f) => f.endsWith(".ts"));
const adapterKode = filer.map((f) => utenKommentarer(readFileSync(join(ADAPTER, f), "utf-8"))).join("\n");
const indeksKode = utenKommentarer(readFileSync(join(ADAPTER, "index.ts"), "utf-8"));

describe("adapteren er tynn", () => {
	/**
	 * Handlere adapteren har lov til å importere.
	 *
	 * Begge er motorformede i signatur, ikke PAI-logikk:
	 * `compaction-intelligence` bygger seksjoner til kompakteringshooken, og
	 * emitterne oversetter en blokkering til et observability-innslag.
	 * Alt annet hører hjemme bak `dispatch()`.
	 */
	const TILLATTE_HANDLERE = ["compaction-intelligence", "observability-emitter"];

	test("det finnes filer å sjekke", () => {
		// Uten denne ville testene under bestått trivielt om katalogen flyttet.
		expect(filer).toContain("index.ts");
		expect(filer.length).toBeGreaterThanOrEqual(4);
	});

	test("ingen andre handler-importer har sneket seg inn", () => {
		const importerte = [...adapterKode.matchAll(/pai-core\/handlers\/([\w-]+)/g)].map((m) => m[1]);
		const ulovlige = importerte.filter((navn) => !TILLATTE_HANDLERE.includes(navn));
		expect(ulovlige).toEqual([]);
	});

	test("adapteren går gjennom dispatch, ikke rundt den", () => {
		expect(indeksKode).toContain('from "../../pai-core"');
		// Én dispatch per hook som har en kjernehendelse.
		const antall = [...indeksKode.matchAll(/await dispatch\(/g)].length;
		expect(antall).toBeGreaterThanOrEqual(8);
	});

	test("mengden LOGIKK holder seg nede", () => {
		// 564 kodelinjer i de fire filene da v1 ble slettet. Teller kodelinjer,
		// ikke totale: kommentarene bærer de MÅLTE feltplasseringene, og de
		// skal få vokse. En terskel som stadig heves, vokter ingenting.
		const kodelinjer = adapterKode.split("\n").filter((l) => l.trim().length > 0).length;
		expect(kodelinjer).toBeLessThan(650);
	});

	test("ingen console.log — den korrumperer TUI-en", () => {
		expect(adapterKode).not.toContain("console.log");
	});
});

describe("hver hendelsestype har en dispatch-gren", () => {
	// Den uttømmende `never`-sjekken i index.ts fanger dette i typegaten
	// også. Denne gir en lesbar melding med hendelsesnavnet i.
	const typer = readFileSync(join(ROT, "pai-core", "types.ts"), "utf-8");
	const indeks = readFileSync(join(ROT, "pai-core", "index.ts"), "utf-8");
	const medlemmer = [...typer.matchAll(/^\ttype: "([\w.]+)";$/gm)].map((m) => m[1]);

	test("unionen ble faktisk funnet", () => {
		expect(medlemmer.length).toBeGreaterThanOrEqual(10);
	});

	test.each(medlemmer)('%s har case i dispatch', (medlem) => {
		expect(indeks).toContain(`case "${medlem}"`);
	});
});
