/**
 * Format Reminder Handler
 *
 * Utleder effort-nivå fra brukerens melding etter åtte-trinns-skalaen.
 * Resultatet skrives til arbeidsøktens `META.yaml` av `dispatch/message.ts`.
 *
 * MÅLT 2026-09-22, og grunnen til at fila ble skrevet om:
 *
 *   `msg.includes(signal)` traff INNI ord. «Kan du **just**ere tabellen» ble
 *   `Fast`, og «Vi har **fast** pris» ble `Fast`. Samme feilklasse som M-17
 *   (`includes("task")`), bare i prompt-retningen. Matching skjer nå på hele
 *   ORD, via en tokenizer som kjenner æøå.
 *
 *   Signallistene var engelske pluss to tyske. Brukeren skriver norsk, så de
 *   eneste listene som kunne treffe var de som traff ved uhell — og alle
 *   nedgraderer. «Gjør en grundig gjennomgang…» ble `Standard`. Norske
 *   signaler står nå i listene, med bøyningsformene skrevet ut.
 *
 *   Ordet «just» er FJERNET fra fartssignalene. `PAI/SKILL.md` sier ordrett
 *   «the word "just" does not reduce depth», og koden gjorde nettopp det.
 *   Det samme gjelder «fast»: på norsk betyr det «permanent», og brukerens
 *   domene er full av «fast pris» og «fast IP».
 *
 * Fordelingen over 533 arbeidsøkter før denne endringen: 441 `Standard`,
 * 38 `Comprehensive`, 29 `Extended`, 22 `Advanced`, 2 `Fast`, 1 `Loop`.
 * `Instant` er strukturelt uoppnåelig herfra — `isTrivialMessage` stopper alt
 * under 25 tegn før arbeidsøkten opprettes, og `Instant` krever `len < 20`.
 *
 * Rekkefølgen på sjekkene er BEVART fra forrige versjon, inkludert at `Loop`
 * står etter `Advanced`/`Extended` og derfor nesten aldri nås. Å flytte den
 * er en atferdsendring, ikke en retting av det som ble målt.
 *
 * @module format-reminder
 */

import { fileLogError } from "../lib/file-logger";

/** Effort level tiers (v3.0) */
const EFFORT_LEVELS = {
	Instant: { budget: "<10s", description: "Trivial lookup, greeting, math" },
	Fast: { budget: "<1min", description: "Simple fix, skill invocation" },
	Standard: { budget: "<2min", description: "Normal request, 1-8 ISC" },
	Extended: {
		budget: "<8min",
		description: "Complex task, multi-file changes",
	},
	Advanced: { budget: "<16min", description: "Multi-domain, thorough work" },
	Deep: { budget: "<32min", description: "Research + analysis, extensive" },
	Comprehensive: { budget: "<120min", description: "Full system design" },
	Loop: { budget: "unbounded", description: "Iterative PRD execution" },
} as const;

type EffortLevel = keyof typeof EFFORT_LEVELS;

interface EffortResult {
	level: EffortLevel;
	budget: string;
	reasoning: string;
}

/**
 * Ord i meldingen, små bokstaver.
 *
 * `\p{L}` med `u`-flagget er påkrevd: `\w` og `\b` i JS regner ikke æøå som
 * ordtegn, så «påse» ville blitt delt i «p» og «se».
 */
function ord(melding: string): Set<string> {
	return new Set(melding.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

/** Treffer bare HELE ord. Substring-matching var feilen som ble målt. */
function harOrd(ordene: Set<string>, signaler: readonly string[]): boolean {
	return signaler.some((s) => ordene.has(s));
}

/** Flerordsfraser kan trygt matches som substring — de har egne grenser. */
function harFrase(melding: string, fraser: readonly string[]): boolean {
	return fraser.some((f) => melding.includes(f));
}

/**
 * Treffer ord som BEGYNNER med stammen.
 *
 * Norsk bøyer: «refaktorere», «refaktorering», «refaktorert». Å ramse opp
 * hver form er dømt til å gå ut på dato, så lange stammer prefiks-matches.
 * Grensen er det som skiller dette fra feilen som ble rettet — «just» er fire
 * tegn og traff «justere».
 *
 * Eksportert fordi `tests/effort-heuristikk.test.ts` håndhever den mot
 * stammelistene. Sto tallet bare i testen, ville de to kunne gli fra
 * hverandre uten at noe falt.
 */
export const STAMME_MIN = 6;

function harStamme(ordene: Set<string>, stammer: readonly string[]): boolean {
	for (const o of ordene) {
		for (const stamme of stammer) {
			if (o.startsWith(stamme)) return true;
		}
	}
	return false;
}

/**
 * Fartssignaler.
 *
 * «just» og «fast» står bevisst IKKE her: «just» fordi SKILL.md sier det ikke
 * skal senke dybden, «fast» fordi det er et vanlig norsk ord for «permanent».
 */
const FART_ORD = [
	"quick",
	"quickly",
	"simple",
	"kurz",
	"raskt",
	"rask",
	"kjapt",
	"kjapp",
	"enkel",
	"enkelt",
	"kjempekjapt",
] as const;

/** Dybdesignaler — eksakte ord. */
const DYBDE_ORD = [
	"thorough",
	"comprehensive",
	"detailed",
	"extensive",
	"determined",
	"gründlich",
	"ausführlich",
] as const;

/** Dybdesignaler der bøyning betyr noe. */
const DYBDE_STAMMER = ["grundig", "omfattende", "detaljert", "utførlig", "dyptgående"] as const;

const DYBDE_FRASER = ["deep dive", "all phases", "dypdykk", "alle faser"] as const;

/** Flerdomene-signaler — eksakte ord. */
const BREDDE_ORD = ["parallel", "multiple", "parallelt", "flerdomene"] as const;

/** Flerdomene-signaler der bøyning betyr noe. */
const BREDDE_STAMMER = [
	"migrat",
	"migrer",
	"migrering",
	"refactor",
	"refaktor",
	"redesign",
	"architect",
	"arkitektur",
	"omskriv",
] as const;

/**
 * Detect effort level from user message
 *
 * Uses heuristics to classify the effort level.
 * Default is Standard (~2min).
 */
export async function detectEffortLevel(userMessage: string): Promise<EffortResult> {
	try {
		const msg = userMessage.toLowerCase().trim();
		const len = msg.length;
		const ordene = ord(msg);

		// Instant: greetings, ratings, very short
		if (len < 20) {
			// Norsk er lagt til av samme grunn som resten av listene: brukeren
			// skriver norsk, og en engelsk-only liste gjorde grenen uoppnåelig.
			const greetings = [
				"hi",
				"hey",
				"hello",
				"yo",
				"thanks",
				"ok",
				"thx",
				"hei",
				"heisann",
				"hallo",
				"morn",
				"takk",
				"jepp",
			];
			if (greetings.some((g) => msg.startsWith(g))) {
				return {
					level: "Instant",
					budget: EFFORT_LEVELS.Instant.budget,
					reasoning: "Greeting or acknowledgment",
				};
			}
			// Check for rating
			if (/^\d{1,2}(\/10)?$/.test(msg.trim())) {
				return {
					level: "Instant",
					budget: EFFORT_LEVELS.Instant.budget,
					reasoning: "Rating response",
				};
			}
		}

		// Fast: explicit speed signals
		if (harOrd(ordene, FART_ORD) && len < 200) {
			return {
				level: "Fast",
				budget: EFFORT_LEVELS.Fast.budget,
				reasoning: "Speed signal detected in short prompt",
			};
		}

		// Extended+: explicit depth signals
		const hasDeepSignal =
			harOrd(ordene, DYBDE_ORD) || harStamme(ordene, DYBDE_STAMMER) || harFrase(msg, DYBDE_FRASER);

		// Comprehensive: very long prompts or explicit signals
		if (len > 2000 || ordene.has("comprehensive") || msg.includes("full system")) {
			return {
				level: "Comprehensive",
				budget: EFFORT_LEVELS.Comprehensive.budget,
				reasoning: `Long prompt (${len} chars) or comprehensive signal`,
			};
		}

		// Deep: complex + explicit signal
		if (hasDeepSignal && len > 500) {
			return {
				level: "Deep",
				budget: EFFORT_LEVELS.Deep.budget,
				reasoning: "Depth signal with substantial prompt",
			};
		}

		// Advanced: multi-domain or substantial work
		if (harOrd(ordene, BREDDE_ORD) || harStamme(ordene, BREDDE_STAMMER) || len > 800) {
			return {
				level: "Advanced",
				budget: EFFORT_LEVELS.Advanced.budget,
				reasoning: "Multi-domain or substantial work detected",
			};
		}

		// Extended: medium complexity
		if (hasDeepSignal || len > 400) {
			return {
				level: "Extended",
				budget: EFFORT_LEVELS.Extended.budget,
				reasoning: "Depth signal or medium-length prompt",
			};
		}

		// Loop: explicit loop/iteration mode
		if (ordene.has("loop") || msg.includes("iterate until")) {
			return {
				level: "Loop",
				budget: EFFORT_LEVELS.Loop.budget,
				reasoning: "Explicit loop/iteration mode",
			};
		}

		// Default: Standard
		return {
			level: "Standard",
			budget: EFFORT_LEVELS.Standard.budget,
			reasoning: "Default — normal request complexity",
		};
	} catch (error) {
		fileLogError("[FormatReminder] Effort detection failed", error);
		return {
			level: "Standard",
			budget: EFFORT_LEVELS.Standard.budget,
			reasoning: "Detection error — defaulting to Standard",
		};
	}
}
