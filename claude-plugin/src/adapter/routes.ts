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
 * Verktøyene `onToolAfter` faktisk gjør noe med.
 *
 * Hver linje speiler en sjekk i kjernen, og alle fire må stemme — en
 * uteglemt gren her er en handler som stille slutter å kjøre:
 *
 *   `algorithm-tracker`  bash, todo, subagent-verktøyet
 *   `prd-sync`           `isWriteTool`: navn som inneholder write eller edit,
 *                        og hvert navn i `SKRIVEVERKTØY` (K58)
 *   `question-tracking`  kun `AskUserQuestion` (hviteliste, ikke substring)
 *   `agent-capture`      subagent-verktøyet — men KUN når `subagentEvents`
 *                        er av, og den er PÅ under Claude Code. Navnet står
 *                        likevel her, fordi algoritmesporingen teller
 *                        spawnen og agent-vakten leser argumentene.
 *
 * `agent` OG `task` står begge i lista, og det er ikke belter og bukseseler:
 * Claude Codes subagent-verktøy heter **`Agent`** (målt 2026-09-22,
 * ende-til-ende), OpenCodes heter `mcp_task`. Kjernen kjenner begge via
 * `lib/tool-names.ts`, og hurtigutgangen må kjenne nøyaktig de samme — ellers
 * forkastes kallet her før kjernen ser det.
 *
 * TESTEN som låser dette leser kjernens kildekode og sammenligner. Uten den
 * ville lista råtnet ved første handler som får en ny verktøytype.
 */
const ETTERBEHANDLEDE_VERKTØY = [
	"bash",
	"todo",
	"task",
	"agent",
	"write",
	"edit",
	// v2s skriveverktøy. Claude har det ikke i dag; står her fordi kjernen
	// etterbehandler hvert navn i `SKRIVEVERKTØY` (K58), og testen låser det.
	"patch",
	"askuserquestion",
];

/** Matcher kjernens egen form: substring på småbokstaver, ikke eksakt navn. */
function berørerEtterbehandling(toolName: string): boolean {
	const lower = toolName.toLowerCase();
	return ETTERBEHANDLEDE_VERKTØY.some((navn) => lower.includes(navn));
}

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

		case "PostToolUse": {
			// DEN DYRESTE HENDELSEN etter PreToolUse, og den eneste her hvor
			// filtrering gir reell gevinst: `onToolAfter` gjør INGENTING for et
			// `Read`- eller `Grep`-kall, og de er flertallet i en økt.
			//
			// Speilingen er mot kjernens egne navnetester, ikke mot en liste
			// noen mente var fornuftig. Testen låser de to sammen.
			const verktøy = payload.tool_name;
			if (typeof verktøy !== "string" || !berørerEtterbehandling(verktøy)) {
				return `uinteressant-verktøy:${String(verktøy)}`;
			}
			return null;
		}

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
