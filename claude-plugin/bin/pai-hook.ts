/**
 * PAI hook-dispatcher for Claude Code
 *
 * ÉN inngang for alle hook-hendelser: les stdin → hurtigutgang → oversett →
 * `dispatch` → oversett tilbake → skriv JSON → exit 0.
 *
 * Tre invarianter, i prioritert rekkefølge:
 *
 *   1. **stdout er protokollen.** Nøyaktig ett skrivekall, helt til slutt,
 *      med et ferdig serialisert dokument. Enhver annen byte ødelegger
 *      JSON-parsingen på den andre siden.
 *   2. **Avslutningskoden er alltid 0.** En krasjet hook er ikke-blokkerende,
 *      og feilen blir da usynlig. Alt som går galt skal bli en logglinje og
 *      et tomt svar, ikke en exit-kode ingen ser.
 *   3. **Ingenting henger.** Vaktbikkja under ligger lavere enn `timeout` i
 *      hooks.json, så PAI selv avgjør hva som skjer når noe tar for lang tid
 *      — framfor at Claude Code dreper prosessen midt i en filskriving.
 *
 * `./src/bootstrap` MÅ stå som første import. Den setter `PAI_HARNESS`,
 * `PAI_HOME` og `PAI_OWNER_PID` og shimmer `console.*`, og ESM evaluerer
 * importer i rekkefølge. Flyttes linja ned, virker den ikke lenger — og
 * ingenting feiler synlig.
 *
 * @module claude-plugin/bin/pai-hook
 */

import { fileLog, fileLogError } from "../src/bootstrap";
import { dispatch } from "../../.opencode/pai-core";
import type { PaiResult } from "../../.opencode/pai-core";
import { reapOrphanedWorkSessions } from "../../.opencode/pai-core/dispatch/session";
import { type ClaudeHookPayload, tilKjernehendelser } from "../src/adapter/in";
import { slåSammen, tilHookUtdata } from "../src/adapter/out";
import { hurtigutgang } from "../src/adapter/routes";
import { repoRotFraPlugin, sjekkFerskhet } from "../src/binaer";

/**
 * Hvor lenge PAI får bruke på én hendelse, i millisekunder.
 *
 * Verdiene ligger under `timeout` i hooks.json med god margin. `SessionStart`
 * har mest fordi den både kjører reaperen — som kan ha et etterslep av
 * foreldreløse arbeidsøkter å fullføre — og bygger ~26 KB kontekst.
 *
 * Blir en av dem nådd, svarer vi tomt. For `PreToolUse` betyr det at kallet
 * slipper gjennom: FAIL-OPEN, samme retning som `guardToolCall` i kjernen
 * allerede har valgt. En bug i vakten skal ikke kunne låse brukeren ute av
 * sitt eget verktøy.
 */
const VAKTBIKKJE_MS: Record<string, number> = {
	SessionStart: 35_000,
	// Teardown har like mye å gjøre som oppstart: læringsuttrekk,
	// integritetssjekk, fullføring av arbeidsøkten og relasjonsminne.
	SessionEnd: 35_000,
	UserPromptSubmit: 22_000,
	PreToolUse: 10_000,
	PostToolUse: 15_000,
	PostToolUseFailure: 10_000,
	Stop: 22_000,
	SubagentStart: 10_000,
	// Skriver en fangstfil til MEMORY/RESEARCH/ og oppdaterer registeret
	// under compare-and-swap, som kan måtte prøve om igjen.
	SubagentStop: 22_000,
	PreCompact: 10_000,
	PostCompact: 22_000,
	PermissionRequest: 10_000,
	PermissionDenied: 10_000,
};

/** Les hele stdin. Tom streng når det ikke kommer noe. */
async function lesStdin(): Promise<string> {
	const biter: Uint8Array[] = [];
	for await (const bit of Bun.stdin.stream()) {
		biter.push(bit);
	}
	return Buffer.concat(biter).toString("utf-8");
}

/**
 * Skriv svaret og avslutt.
 *
 * `process.exit(0)` er bevisst, ikke en vane. Claude Code venter på at
 * prosessen avslutter, ikke på at stdout lukkes — lar vi hendelsesløkka
 * tømme seg selv, blir hooken hengende så lenge et bakgrunnskall lever.
 *
 * KONSEKVENSEN, som er en reell forskjell fra OpenCode-siden: arbeid som
 * kjernen har sluppet løs uten å vente på det, blir kuttet her.
 * `handleImplicitSentiment` er det ene tilfellet i dag — den spawner en CLI
 * og kan bruke opptil 25 sekunder, og `onUserMessage` awaiter den derfor
 * ikke. Under OpenCode lever motorprosessen videre og arbeidet fullføres;
 * under Claude Code gjør det ikke det.
 *
 * Det er registrert, ikke oversett: planens batch 12 gjør sentiment til en
 * ekte detached worker med jobbfil i `STATE/jobs/` og `unref()`. Å awaite
 * den her i stedet ville lagt 25 sekunder på hver eneste brukermelding.
 */
function svarOgAvslutt(dokument: string): never {
	// Det ENESTE stedet i adapteren som rører stdout.
	process.stdout.write(dokument);
	process.exit(0);
}

/**
 * Advar brukeren hvis den kompilerte binæren er eldre enn kildekoden.
 *
 * VAKTEN MOT DEN ENE FARLIGE EGENSKAPEN ved `bin/pai-hook.bin`: den kan bli
 * stale. Redigerer du sikkerhetsvakten uten å bygge på nytt, kjører den gamle
 * koden videre — stumt, som er nøyaktig feilklassen defektregisteret er fullt
 * av.
 *
 * Sjekken ligger HER og ikke i shell-oppstarteren, fordi en `find -newer`
 * koster 11 ms (målt) av de 44 kompileringen vant — en fjerdedel, betalt på
 * hvert eneste verktøykall. `SessionStart` koster allerede 424 ms og fyrer én
 * gang per økt, så her er den gratis.
 *
 * `systemMessage` når BRUKEREN, ikke modellen. Det er riktig adressat: en
 * stale binær er noe et menneske må rette med `pai claude sync`, ikke noe
 * modellen kan gjøre noe med.
 *
 * Kjører vi fra kilden (ingen binær bygget), er ingenting stale og det
 * returneres uendret. En advarsel som alltid står, er en advarsel ingen leser.
 */
function medStaleVarsel(dokument: string): string {
	try {
		const pluginRot = process.env.CLAUDE_PLUGIN_ROOT?.trim();
		if (!pluginRot) return dokument;

		const f = sjekkFerskhet(repoRotFraPlugin(pluginRot), pluginRot);
		if (!f.finnes || f.fersk) return dokument;

		const alder = Math.round((f.nyesteKilde - f.bygget) / 1000);
		const beskjed =
			`⚠️  PAI: den kompilerte hook-binæren er ${alder} s eldre enn kildekoden. ` +
			"Du kjører GAMMEL PAI-kode, inkludert sikkerhetsvakten. Kjør: pai claude sync";

		fileLog(`[pai-hook] STALE BINÆR: kilde ${f.nyesteKilde} > bygget ${f.bygget}`, "error");

		const svar = JSON.parse(dokument) as Record<string, unknown>;
		svar.systemMessage = beskjed;
		return JSON.stringify(svar);
	} catch (error) {
		// En vakt som kaster skal ikke kunne velte hooken den vokter.
		fileLogError("[pai-hook] Ferskhetssjekken feilet", error);
		return dokument;
	}
}

async function main(): Promise<never> {
	let rå: string;
	try {
		rå = await lesStdin();
	} catch (error) {
		fileLogError("[pai-hook] Klarte ikke lese stdin", error);
		svarOgAvslutt("{}");
	}

	let payload: ClaudeHookPayload;
	try {
		payload = JSON.parse(rå) as ClaudeHookPayload;
	} catch {
		// Ikke fileLogError: en tom eller ugyldig stdin er ikke nødvendigvis en
		// feil — den kan komme fra en manuell kjøring. Vi sier fra og går videre.
		fileLog(`[pai-hook] Ugyldig JSON på stdin (${rå.length} tegn) — svarer tomt`, "warn");
		svarOgAvslutt("{}");
	}

	const hendelsesnavn = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";

	const grunn = hurtigutgang(payload as Record<string, unknown>);
	if (grunn) {
		// Hurtigutgangen har ikke lastet kjernen. Logglinja er billig og gjør
		// en utgang som slår til oftere enn tenkt synlig framfor taus.
		fileLog(`[pai-hook] Hurtigutgang (${hendelsesnavn}): ${grunn}`, "debug");
		svarOgAvslutt("{}");
	}

	fileLog(
		`[pai-hook] ${hendelsesnavn} pid=${process.pid} eier=${process.env.PAI_OWNER_PID} sesjon=${payload.session_id ?? "?"}`,
		"debug"
	);

	const hendelser = tilKjernehendelser(payload);

	const arbeid = (async (): Promise<PaiResult[]> => {
		const ut: PaiResult[] = [];

		// === REAPER ===
		//
		// ADAPTEREN bestemmer NÅR det reapes, kjernen HVORDAN. Samme
		// arbeidsdeling som på OpenCode-siden, der reaperen kalles ved
		// plugin-last (`pai-unified.ts:153`) framfor fra `session.created` —
		// den hendelsen fyrte ikke i det hele tatt i en målt TUI-økt, og en
		// korrekthetsgaranti kan ikke henge på en hendelse som kanskje ikke
		// kommer. `SessionStart` er MÅLT til å fyre her.
		//
		// Fra batch 7 er `SessionEnd` den normale teardown-veien, og reaperen
		// er tilbake i rollen den har på OpenCode: korrekthetsgarantien.
		// `SessionEnd` fyrer ikke ved SIGKILL, og ingen motor varsler der, så
		// «kjørte teardown?» kan fortsatt bare besvares av om prosessen som
		// eide økten lever.
		//
		// AWAITET, i motsetning til OpenCode. Der lever motorprosessen videre
		// og rekker resten senere; her avsluttes prosessen så snart vi har
		// svart. Vaktbikkja under dekker kallet, og rekker den ikke gjennom et
		// stort etterslep, tar neste oppstart resten.
		if (hendelsesnavn === "SessionStart") {
			const reapet = await reapOrphanedWorkSessions();
			if (reapet.length > 0) {
				fileLog(`[pai-hook] Reaper fullførte ${reapet.length} foreldreløs(e) arbeidsøkt(er)`, "info");
			}
		}

		// Sekvensielt, ikke parallelt: `SessionStart` gir `session.start` før
		// `context.build`, og den rekkefølgen er bindende — reaperen og
		// ryddingen skal være ferdige før konteksten bygges.
		for (const hendelse of hendelser) {
			// `dispatch` kaster ALDRI (invarianten i pai-core/index.ts), så det
			// finnes ingen try/catch her å skrive. Kommer det likevel et
			// unntak, er invarianten brutt, og da skal den feilen være synlig i
			// vaktposten under framfor å bli svelget her.
			ut.push(await dispatch(hendelse));
		}
		return ut;
	})();

	const frist = VAKTBIKKJE_MS[hendelsesnavn] ?? 15_000;
	const vaktbikkje = new Promise<PaiResult[] | null>((løs) => {
		setTimeout(() => løs(null), frist).unref?.();
	});

	let resultater: PaiResult[] | null;
	try {
		resultater = await Promise.race([arbeid, vaktbikkje]);
	} catch (error) {
		// Invarianten er brutt. Det er verdt en ERROR-linje.
		fileLogError(`[pai-hook] dispatch kastet for ${hendelsesnavn} — invariant brutt`, error);
		svarOgAvslutt("{}");
	}

	if (resultater === null) {
		fileLog(
			`[pai-hook] Vaktbikkja løste ut for ${hendelsesnavn} etter ${frist} ms — svarer tomt`,
			"warn"
		);
		svarOgAvslutt("{}");
	}

	const samlet = slåSammen(resultater);
	if (samlet.notes?.length) {
		fileLog(`[pai-hook] ${hendelsesnavn} notes: ${samlet.notes.join(", ")}`, "debug");
	}
	if (samlet.permission === "deny") {
		fileLog(`[pai-hook] BLOKKERT: ${samlet.reason}`, "error");
	}
	if (samlet.block) {
		fileLog(`[pai-hook] TUR BLOKKERT: ${samlet.block.message}`, "error");
	}

	let dokument: string;
	try {
		dokument = tilHookUtdata(hendelsesnavn, samlet);
		if (hendelsesnavn === "SessionStart") dokument = medStaleVarsel(dokument);
	} catch (error) {
		// Serialisering kan feile på sirkulære strukturer. Et tomt svar er
		// alltid gyldig JSON; et halvt dokument er det aldri.
		fileLogError(`[pai-hook] Klarte ikke bygge utdata for ${hendelsesnavn}`, error);
		svarOgAvslutt("{}");
	}

	svarOgAvslutt(dokument);
}

// Siste skanse. Kommer vi hit, har noe utenfor all håndtering over gått galt,
// og protokollen krever fortsatt et gyldig dokument og kode 0.
main().catch((error) => {
	try {
		fileLogError("[pai-hook] Uventet feil i main", error);
	} catch {
		// Selv loggingen kan feile. Protokollen går foran.
	}
	process.stdout.write("{}");
	process.exit(0);
});
