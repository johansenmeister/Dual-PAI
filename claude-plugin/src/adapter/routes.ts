/**
 * Claude-adapter — rutetabell og hurtigutgang
 *
 * REN DATA. Denne fila importerer ingenting, og det er en ytelsesegenskap,
 * ikke en stilpreferanse: den konsulteres FØR kjernen lastes, så en hendelse
 * vi ikke bryr oss om koster bun-oppstart alene og ingen modulgraf.
 *
 * Regnestykket den finnes for: `PreToolUse` og `PostToolUse` fyrer på hvert
 * eneste verktøykall — to prosesser per kall. Bun kaldstart er ~69 ms målt, og
 * kjernens modulgraf ~10-17 ms på toppen. Over noen hundre kall blir det
 * titalls sekunder akkumulert latens hvis alt lastes hver gang.
 *
 * Legger du til en hurtigutgang her, må den speile en sjekk kjernen ALLEREDE
 * gjør. En hurtigutgang som hopper over noe kjernen ville reagert på, er et
 * stille funksjonstap — nøyaktig den feilklassen defektregisteret er fullt av.
 *
 * @module claude-plugin/adapter/routes
 */

/**
 * Hendelsene adapteren håndterer. Resten svarer `{}` uten å laste noe.
 *
 * `PermissionRequest`, `PermissionDenied` og `PreCompact` er med selv om de
 * ikke gir noen kjernehendelse: de blir en revisjonslinje i `in.ts`. Det
 * koster en hook-prosess, men alle tre er sjeldne — en kompaktering eller en
 * tillatelsesdialog skjer ikke per verktøykall.
 */
export const HÅNDTERTE_HENDELSER = new Set([
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"PostCompact",
	"PreCompact",
	"PermissionRequest",
	"PermissionDenied",
]);

/**
 * Terskelen `pai-core/dispatch/message.ts` bruker på assistentsvar.
 *
 * MÅ holdes i synk med `ASSISTANT_MIN_LENGTH` der. Speilingen er duplisering
 * med vilje: å importere konstanten ville dratt inn modulgrafen denne fila
 * finnes for å unngå. `tests/claude-adapter.test.ts` låser at de er like.
 */
export const ASSISTENT_MIN_LENGDE = 100;

/**
 * Skal denne payloaden behandles i det hele tatt?
 *
 * @returns `null` når hendelsen skal behandles, ellers en kort grunn til at
 *   den hoppes over. Grunnen logges, så en hurtigutgang som slår til oftere
 *   enn tenkt er synlig framfor å være taus.
 */
export function hurtigutgang(payload: Record<string, unknown>): string | null {
	const hendelse = payload.hook_event_name;

	if (typeof hendelse !== "string" || !HÅNDTERTE_HENDELSER.has(hendelse)) {
		return `uhåndtert-hendelse:${String(hendelse)}`;
	}

	switch (hendelse) {
		case "UserPromptSubmit": {
			// Speiler `onUserMessage`, som returnerer tomt for blank tekst.
			const prompt = payload.prompt;
			if (typeof prompt !== "string" || prompt.trim().length === 0) {
				return "tom-prompt";
			}
			return null;
		}

		case "Stop": {
			// Speiler `onAssistantMessage`: `responseText.length <= ASSISTANT_MIN_LENGTH`
			// gir tomt resultat FØR noe buffres, så dette er eksakt samme utfall
			// til langt lavere pris. Merk `<=`, ikke `<`.
			//
			// ISC-håndhevelsen endrer ikke dette: kjernen kommer aldri forbi
			// den samme terskelen, så et kort svar kunne uansett ikke blitt
			// blokkert.
			const svar = payload.last_assistant_message;
			if (typeof svar !== "string" || svar.length <= ASSISTENT_MIN_LENGDE) {
				return "kort-assistentsvar";
			}
			return null;
		}

		case "PostToolUse":
			// NO shortcut (#367). It used to skip Read, Grep and every tool no
			// handler looked at, but the core now masks secrets in the output
			// of EVERY tool before the model sees it, and Read and Grep are how
			// `.git/config` and `.env` get printed. A shortcut here would be a
			// hole in that guard, like one on PreToolUse.
			return null;

		case "PostToolUseFailure": {
			// Et AVBRUDD er ikke en feil — brukeren trykket ESC. `onToolFailed`
			// gjør ingenting for det tilfellet, så vi laster ikke kjernen for å
			// komme fram til det samme.
			if (payload.is_interrupt === true) return "avbrutt-av-bruker";
			return null;
		}

		case "SubagentStop": {
			// Ingen hurtigutgang på tom tekst, i motsetning til `Stop`: en
			// subagent som svarte tomt er fortsatt FERDIG, og registeret må få
			// vite det. Lot vi den gå, ville oppføringen stått som `running` for
			// alltid — som er nettopp den løgnen hendelsen finnes for å unngå.
			return null;
		}

		case "PreToolUse":
			// INGEN hurtigutgang. Sikkerhetsvakten må se hvert eneste
			// verktøykall — en filtrering her ville vært et hull i vakten, ikke
			// en optimalisering. Batch 12 kan innføre en allowlist for
			// beviselig ufarlige verktøy, men det krever måling først.
			return null;

		default:
			// SessionStart: alltid full behandling. Den kjører reaperen, som er
			// korrekthetsgarantien for teardown-kjeden i BEGGE motorene.
			// SessionEnd: teardown — den kan per definisjon ikke hoppes over.
			// SubagentStart, PostCompact og de tre observasjonshendelsene er
			// sjeldne nok til at filtrering ikke ville målt seg.
			return null;
	}
}
