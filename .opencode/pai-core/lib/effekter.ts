/**
 * Effektmarkører (K5): når en handler faktisk HADDE en effekt
 *
 * M-34, M-35, M-36 og M-46 var handlere som ble kalt i hver økt og aldri gjorde
 * noe, og ingen logglinje skilte «kalt» fra «virket». Dispatch-laget samler
 * allerede `notes` per hendelse, og noen av dem betyr at noe ble skrevet
 * (`prd-tracked`, `learnings:2`, `agent-captured`). De legges her i
 * arbeidsøktens `EFFEKTER.jsonl`, én linje per effekt, så `pai doctor` kan
 * sammenligne inndataen på disk med det som faktisk skjedde.
 *
 * Synkront, som revisjonsloggen: hook-prosessen under Claude avslutter med
 * `process.exit(0)` så snart svaret er skrevet (M-43).
 *
 * @module lib/effekter
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileLogError } from "./file-logger";
import { getCurrentWorkPath } from "./paths";

export const EFFEKTFIL = "EFFEKTER.jsonl";

/** Notene som betyr at en handler skrev noe. Resten er diagnostikk. */
const EFFEKTNOTER: ReadonlySet<string> = new Set([
	"work-created",
	"work-completed",
	"prd-synced",
	"prd-tracked",
	"plan-captured",
	"agent-captured",
	"question-tracked",
	"rating-captured",
	"tab-state",
]);

export function effektnoter(notes: readonly string[] | undefined): string[] {
	return (notes ?? []).filter((n) => EFFEKTNOTER.has(n) || /^learnings:[1-9]/.test(n));
}

/** Legg effektene i `arbeidskatalog`. Kaster aldri; gir antallet linjer. */
export function merkEffekter(arbeidskatalog: string | null, hendelse: string, notes: readonly string[] | undefined): number {
	const effekter = effektnoter(notes);
	if (!arbeidskatalog || effekter.length === 0) return 0;
	const ts = new Date().toISOString();
	try {
		appendFileSync(
			join(arbeidskatalog, EFFEKTFIL),
			`${effekter.map((effekt) => JSON.stringify({ ts, hendelse, effekt })).join("\n")}\n`
		);
		return effekter.length;
	} catch (error) {
		fileLogError("[Effekter] Kunne ikke skrive markøren (non-blocking)", error);
		return 0;
	}
}

/** Som `merkEffekter`, med arbeidsøkten slått opp for sesjonen. Slår bare opp når det finnes en effekt. */
export async function merkForØkt(sessionId: string, hendelse: string, notes: readonly string[] | undefined): Promise<void> {
	if (effektnoter(notes).length === 0) return;
	try {
		merkEffekter(await getCurrentWorkPath(sessionId || undefined), hendelse, notes);
	} catch (error) {
		fileLogError("[Effekter] Fant ikke arbeidsøkten (non-blocking)", error);
	}
}
