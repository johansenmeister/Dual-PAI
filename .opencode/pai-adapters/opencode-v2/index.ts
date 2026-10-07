/**
 * PAI — adapter for OpenCode v2 (`@opencode/cli`)
 *
 * OpenCode-adapteren, ved siden av `claude-plugin/`. v1-pluginen
 * (`plugins/pai-unified.ts`) ble slettet i fase 7. Samme rolle som Claude-
 * adapteren: registrere motorens hooks,
 * oversette payloadene til `PaiEvent`, og oversette `PaiResult` tilbake. All
 * PAI-logikk ligger i `../../pai-core`.
 *
 * Koblet til `dispatch` så langt (docs/opencode-v2/plan.md):
 *
 *   fase 2  `tool.execute.before` → `tool.before`, og `permission.evaluate`
 *           for kjernens `ask`. Sikkerhetsvakten først, av alt.
 *   fase 3  `session.context` → `context.build`, `session.prompt` →
 *           `user.message`, bussen → `assistant.message`, `execute.after` →
 *           `tool.after`/`tool.failed`, `shell.create.before` → `shell.env`.
 *   fase 4  livssyklusen: reaperen ved plugin-last, `session.start` fra
 *           første prompt per hovedøkt, `session.end` fra cleanup ved
 *           nedstenging (ikke ved omlasting). Se `livssyklus.ts`.
 *   fase 5  subagentene (`agent.start` fra bussen, `agent.stop` fra
 *           `execute.after` på `subagent`), kompakteringskonteksten i
 *           `session.compaction` og `session.compacted` fra bussen, og PAIs
 *           egne verktøy via `tool.transform`.
 *
 * HVORFOR FYR-REGISTERET FINNES. v2 validerer ikke hooknavn:
 * `tool.hook("finnes.ikke")` registreres uten feil og fyrer aldri (MÅLT på
 * 2.0.15 og 2.0.16). Typene fanger en feilstaving i koden, men ikke et navn
 * motoren har endret i en patch — og v2 har gitt ut 17 versjoner på 13 dager.
 * Det er M-17- og K-08-klassen: en handler som aldri kjører og aldri feiler.
 * Derfor skriver hver hook `[v2-fyrt] <navn>` i loggen første gang den fyrer,
 * og `Tools/V2Smoke.ts` feiler for hvert navn i `V2_HOOKS` uten en slik linje.
 * Registrering beviser ingenting.
 *
 * Adapteren lastes av launcheren via `OPENCODE_CONFIG_CONTENT`, ALDRI fra den
 * delte `plugin`-nøkkelen i `opencode.json`: v1 kaller en v2-plugins `setup`
 * med sin egen kontekst (MÅLT, M5). Se B2 i planen.
 *
 * IMPORTANT: This plugin NEVER uses console.log — alt går til fileLog.
 *
 * @module pai-adapters/opencode-v2
 */

import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import { dispatch, sessionKeyFor } from "../../pai-core";
import { reapOrphanedWorkSessions } from "../../pai-core/dispatch/session";
import { emitSecurityBlock, emitSecurityWarn } from "../../pai-core/handlers/observability-emitter";
import { clearLog, fileLog, fileLogError } from "../../pai-core/lib/file-logger";
import { somObjekt, somTekst } from "../../pai-core/lib/payload";
import { isShellTool, isSubagentTool, kanoniskeArgs } from "../../pai-core/lib/tool-names";
import { buildCompactionContext } from "../../pai-core/handlers/compaction-intelligence";
import { Bussoversetter, resultatTekst, subagentFerdig } from "./buss";
import { Livssyklus } from "./livssyklus";
import { agentfiler, agentVarsel, primæreAgenter, REPO_AGENTER } from "./selvtest";
import { paiVerktøy } from "./verktoy";

/**
 * Alt adapteren registrerer, og dermed alt `V2Smoke` krever å se fyre.
 *
 * Én liste, to lesere: `tests/opencode-v2-adapter.test.ts` kjører `setup` mot
 * en falsk kontekst og krever at det som faktisk registreres er nøyaktig
 * denne lista, og `V2Smoke` krever en fyr-linje for hvert navn. Legges en hook
 * til i `setup` uten å stå her, feiler testen; står den her uten å fyre,
 * feiler røyktesten.
 *
 * `event.subscribe` er hendelsesbussen, og «fyrt» betyr at den leverte
 * minst én hendelse. `tool.transform` fyrer når motoren kaller
 * tilbakekallet som legger til PAIs verktøy; at verktøyene faktisk KJØRER,
 * sjekker `V2Smoke` for seg. `plugin.cleanup` er funksjonen `setup` returnerer; den
 * er livssyklusens siste ledd (B5), og en cleanup som aldri kalles er like
 * stum som en hook som aldri fyrer.
 */
export const V2_HOOKS = [
	"tool.execute.before",
	"tool.execute.after",
	"session.prompt",
	"session.context",
	"session.compaction",
	"shell.create.before",
	"permission.evaluate",
	"tool.transform",
	"event.subscribe",
	"plugin.cleanup",
] as const;

export type V2HookNavn = (typeof V2_HOOKS)[number];

/** Prefikset `V2Smoke` leter etter. Endres det, må røyktesten følge med. */
export const FYR_MARKØR = "[v2-fyrt]";

/**
 * Prefikset på hver blokkeringsbegrunnelse. Det samme som v1 bruker, så
 * modellen og brukeren ser samme tekst uansett motor, og så `V2Smoke` kan
 * finne den igjen i modellens verktøyresultat.
 */
export const BLOKK_PREFIKS = "[PAI Security]";

/**
 * Hvilke hooks har fyrt i denne prosessen.
 *
 * Modulvariabel med vilje, og ikke øktstilstand: den svarer på «har motoren
 * noen gang kalt denne hooken her», og er riktig nøyaktig så lenge prosessen
 * lever. Én linje per hook holder loggen lesbar; en linje per kall ville druknet
 * resten.
 */
const fyrt = new Set<V2HookNavn>();

function meldFyrt(navn: V2HookNavn): void {
	if (fyrt.has(navn)) return;
	fyrt.add(navn);
	fileLog(`${FYR_MARKØR} ${navn}`);
}

/** Det en hook kan be innpakningen gjøre. `blokk` er teksten modellen får. */
export type HookUtfall = { blokk: string } | undefined;

/**
 * The masked result with a note for the model added as a last text part.
 * A result without text content gets no note; the `[MASKED:…]` marks in the
 * text still say what happened.
 */
export function withMaskNotice(result: unknown, notice: string): unknown {
	if (!result || typeof result !== "object") return result;
	const r = result as Record<string, unknown>;
	if (Array.isArray(r.content)) return { ...r, content: [...r.content, { type: "text", text: `\n${notice}` }] };
	if (typeof r.content === "string") return { ...r, content: `${r.content}\n${notice}` };
	return r;
}

/**
 * Pakk inn en hook: meld fyring, og la aldri en feil i PAI nå motoren.
 *
 * Samme kontrakt som de andre adapterne («dispatch kaster aldri»). Kaster en
 * v2-hook, er det en BLOKK — `throw` i `execute.before` stopper kallet (MÅLT).
 * Et unntak fra en PAI-feil ville altså blokkert brukerens verktøykall.
 *
 * Derfor er en tiltenkt blokk en RETURVERDI, og kastes først her, utenfor
 * fangsten. Det er K-07-fiksen i v2-form: så lenge blokkering og feil er samme
 * mekanisme, kan adapteren ikke fange den ene uten å svelge den andre.
 */
export function vakt<E>(navn: V2HookNavn, fn: (e: E) => Promise<HookUtfall> | HookUtfall) {
	return async (e: E): Promise<void> => {
		meldFyrt(navn);
		let utfall: HookUtfall;
		try {
			utfall = await fn(e);
		} catch (error) {
			fileLogError(`[v2] ${navn} feilet (non-blocking)`, error);
			return;
		}
		if (utfall?.blokk) throw new Error(utfall.blokk);
	};
}

/**
 * Kjernens `ask`-svar, per verktøykall, til `permission.evaluate` for samme
 * kall fyrer.
 *
 * Kjernen svarer i `execute.before`, men v2 kan bare SPØRRE fra
 * `permission.evaluate` (MÅLT, M6: `effect = "ask"` gir `permission.asked`
 * med vår `message`). De to kobles på kall-ID-en: `execute.before` har `id`,
 * og `permission.evaluate` har den samme som `source.id` (MÅLT i fase 0, f.eks.
 * `write_1` i begge). Rekkefølgen per kall er `execute.before` →
 * `shell.create.before` → `permission.evaluate` (MÅLT).
 *
 * Modulvariabel, fordi begge hookene kjører i samme serverprosess. Taket
 * finnes fordi ikke hvert verktøy nødvendigvis gir en `evaluate`; uten det
 * ville en glemt oppføring ligget til prosessen døde.
 */
const askMinne = new Map<string, string>();
const ASK_TAK = 500;

function kallNøkkel(sessionId: string, kallId: string): string {
	return `${sessionId}\u0000${kallId}`;
}

function huskAsk(nøkkel: string, grunn: string): void {
	if (askMinne.size >= ASK_TAK) {
		const eldste = askMinne.keys().next().value;
		if (eldste !== undefined) askMinne.delete(eldste);
	}
	askMinne.set(nøkkel, grunn);
}

/**
 * Felles hendelsesfelter. Samlet ett sted så ingen kaller glemmer sessionKey.
 *
 * `harness` er `opencode2`: kjernen slår opp kapabilitetene på den, og
 * `sessionKey` får prefikset `o2_`. Eksportert og testet direkte. Da v1 fantes,
 * skilte ingen kodesti i `tool.before` `opencode` fra `opencode2` (en mutasjon
 * slapp gjennom full suite); nå avviser typen den gamle verdien.
 */
export function hendelsesbase(sessionId: unknown, cwd: string) {
	const id = somTekst(sessionId);
	return {
		harness: "opencode2" as const,
		sessionId: id,
		sessionKey: sessionKeyFor("opencode2", id),
		at: Date.now(),
		cwd,
	};
}

/**
 * Verktøyet og argsene fra `execute.before`/`.after`, med kjernens feltnavn.
 * Eksportert, så de gyldne payloadene (K25) går gjennom den samme koden.
 */
export function verktøyhendelse(e: { tool: string; input?: unknown }) {
	return { tool: e.tool, args: kanoniskeArgs(e.input) };
}

/**
 * Tøm hendelsesbussen i bakgrunnen.
 *
 * Bussen er en `AsyncIterable` som først slutter når serveren stenger (MÅLT,
 * M1), så den skal aldri awaites i `setup`. Løkka får heller aldri kaste: en
 * avvist promise uten fanger ville vært en ubehandlet avvisning i motorens
 * egen prosess.
 */
export async function lyttPåBussen(
	strøm: AsyncIterable<unknown>,
	påHendelse: (hendelse: unknown) => Promise<void>
): Promise<void> {
	try {
		for await (const hendelse of strøm) {
			meldFyrt("event.subscribe");
			try {
				await påHendelse(hendelse);
			} catch (error) {
				// Én hendelse som feiler, skal ikke stoppe løkka. Da ville
				// hvert svar etter den blitt borte uten spor.
				fileLogError("[v2] behandling av busshendelse feilet", error);
			}
		}
	} catch (error) {
		fileLogError("[v2] hendelsesbussen kastet", error);
	}
}

export default Plugin.define({
	id: "pai",
	setup: async (ctx) => {
		// v1 kaller `setup` med sin egen kontekst hvis pluginen står i den
		// delte `plugin`-nøkkelen, og den har verken `tool.hook` eller
		// `event` (MÅLT, M5). Da skal ingenting registreres — og ingenting
		// merkes som v2, siden prosessen ikke er det.
		if (typeof ctx?.tool?.hook !== "function") {
			fileLog("[v2] setup kalt uten v2-kontekst (v1?) — registrerer ingenting", "warn");
			return;
		}

		// FØR noe logges: `file-logger` utleder loggstien fra motoren, og
		// `currentHarness()` merker MEMORY-postene med den.
		process.env.PAI_HARNESS = "opencode2";
		clearLog();
		// Loggen er tømt, så fyr-linjene er borte. Står settet igjen, melder
		// ingen hook seg på nytt etter en reload, som kaller `setup` igjen i
		// samme prosess.
		fyrt.clear();
		fileLog(`=== PAI OpenCode v2-adapter lastet (pid ${process.pid}) ===`);

		// Prosjektkatalogen. Serverens egen cwd er ikke den: under
		// bakgrunnstjenesten var den `$HOME` (MÅLT, fase 0).
		const cwd = somTekst(somObjekt(ctx.location).directory) || process.cwd();

		const base = (sessionId: unknown) => hendelsesbase(sessionId, cwd);
		const buss = new Bussoversetter();

		// === LIVSSYKLUS (fase 4) ===
		//
		// EIEREN ER DENNE PROSESSEN. I `--standalone` er plugin-prosessen den
		// private serveren, og den dør med CLI-en (MÅLT, M3/M4, B5). Kjernens
		// `ownerProcess()` gir `process.pid` når `PAI_OWNER_PID` er usatt, så
		// den fjernes: en verdi arvet fra et foreldremiljø ville fått reaperen
		// til å sjekke liveness på en helt annen prosess.
		delete process.env.PAI_OWNER_PID;
		delete process.env.PAI_OWNER_PID_START;

		// REAPEREN kjøres ved plugin-last, som i v1, og ikke fra en hendelse:
		// en korrekthetsgaranti kan ikke henge på noe som kanskje ikke kommer.
		// Ikke awaitet, så oppstarten ikke venter på et etterslep. Første
		// prompt venter på den i stedet (se `Livssyklus.prompt`).
		const rydding = reapOrphanedWorkSessions().then((reapet) => {
			if (reapet.length > 0) {
				fileLog(`[Reaper] Fullførte ${reapet.length} foreldreløs(e) arbeidsøkt(er)`, "info");
			}
		});
		const livssyklus = new Livssyklus({
			rydding,
			start: (sessionId) => dispatch({ ...base(sessionId), type: "session.start" }),
			slutt: (sessionId) => dispatch({ ...base(sessionId), type: "session.end", reason: "exit" }),
		});

		// `shell.create.before` bærer ingen `sessionID` (felt: `command cwd env
		// shell timeout`, MÅLT). Den fyrer rett etter `execute.before` for SAMME
		// skallkall (rekkefølgen er MÅLT), så økten hentes derfra. Kjernen
		// trenger den til `PAI_SESSION_ID`.
		let sisteSkallØkt = "";

		// === SELVTESTEN: AGENTER SOM IKKE KAN SPAWNES (K6) ===
		//
		// Kjøres én gang per prosess, ved første prompt i en hovedøkt, der
		// agentlista er komplett. Varselet går i konteksten, fordi modellen
		// er den som møter feilen, og TUI-en har ingen kanal fra en
		// serverplugin til brukeren. Tom når alt er i orden. Se `selvtest.ts`.
		let agentsjekk: Promise<string | null> | undefined;
		const sjekkAgentene = async (): Promise<string | null> => {
			if (typeof ctx.agent?.list !== "function") return null;
			try {
				const filer = agentfiler([join(cwd, ".opencode", "agents"), REPO_AGENTER]);
				const varsel = agentVarsel(primæreAgenter(await ctx.agent.list(), filer));
				if (varsel) fileLog(`[selvtest] ${varsel}`, "error");
				return varsel;
			} catch (error) {
				fileLogError("[selvtest] agentsjekken feilet (non-blocking)", error);
				return null;
			}
		};

		// === SIKKERHETSVAKTEN (fase 2) ===
		//
		// Verktøyet heter `shell`, ikke `bash`, og filverktøyene sender `path`,
		// ikke `filePath` (MÅLT, M2). Begge er lukket i kjernen
		// (`isShellTool`, `ARG_ALIASER`), ikke her. Adapteren flytter bare
		// `input` inn som `args`.
		//
		// Code Mode (`execute`) fyrer denne hooken også for sine INDRE kall,
		// med det indre verktøyets eget navn (MÅLT, M2) — så vakten ser dem.
		await ctx.tool.hook(
			"execute.before",
			vakt("tool.execute.before", async (e): Promise<HookUtfall> => {
				if (isShellTool(e.tool)) sisteSkallØkt = somTekst(e.sessionID);
				const result = await dispatch({
					...base(e.sessionID),
					type: "tool.before",
					...verktøyhendelse(e),
				});

				if (result.permission === "deny") {
					fileLog(`BLOCKED: ${result.reason}`, "error");
					emitSecurityBlock({ tool: e.tool, reason: result.reason || "Unknown" }).catch(() => {});
					// Begrunnelsen når modellen ordrett, og ingen etterfølgende
					// hook fyrer for kallet (MÅLT, fase 0).
					return { blokk: `${BLOKK_PREFIKS} ${result.message || result.reason}` };
				}

				if (result.permission === "ask") {
					fileLog(`CONFIRM: ${result.reason} — venter på permission.evaluate`, "warn");
					emitSecurityWarn({
						tool: e.tool,
						reason: result.reason || "Requires confirmation",
					}).catch(() => {});
					huskAsk(kallNøkkel(somTekst(e.sessionID), somTekst(e.id)), result.reason || "");
				}
				return undefined;
			})
		);

		// === ETTER VERKTØYKALL (fase 3) ===
		//
		// v2 skiller utfallene: `status: "completed"` med `result`, eller
		// `status: "error"` med `error` (MÅLT, M7). v1 hadde ingen kilde til
		// `tool.failed`. En blokk fra `execute.before` gir INGEN `execute.after`,
		// så PAIs egne blokker telles ikke som feilede kall.
		//
		// Kjernen fanger ikke subagenter fra `tool.after`. Subagentens SLUTT
		// kommer herfra som `agent.stop`, starten fra bussen.
		await ctx.tool.hook(
			"execute.after",
			vakt("tool.execute.after", async (e): Promise<HookUtfall> => {
				// Secrets in tool output are masked before the model sees them
				// (#367): v2 hands the model `result` as it stands after this
				// hook (MEASURED 2026-10-07 on 2.0.22 with shell and read). First,
				// so the core below only ever sees the masked text.
				if (e.status === "completed" && e.result) {
					const masked = await dispatch({
						...base(e.sessionID),
						type: "tool.output",
						tool: e.tool,
						output: e.result,
						callId: somTekst(e.id) || undefined,
					});
					if (masked.output) {
						e.result = withMaskNotice(masked.output.value, masked.output.notice) as typeof e.result;
						fileLog(`[v2] Masked secrets in ${e.tool} output: ${(masked.notes ?? []).join(", ")}`, "warn");
					}
				}
				const felles = {
					...base(e.sessionID),
					...verktøyhendelse(e),
					callId: somTekst(e.id) || undefined,
				};
				if (e.status === "error") {
					await dispatch({
						...felles,
						type: "tool.failed",
						error: somTekst(somObjekt(e.error).message),
					});
					return undefined;
				}
				const result = somObjekt(e.result);
				await dispatch({
					...felles,
					type: "tool.after",
					result: resultatTekst(result),
					metadata: somObjekt(result.metadata),
				});

				// === SUBAGENT FERDIG (fase 5) ===
				//
				// `result.output.output` er subagentens svar alene, uten
				// innpakningen modellen ser (MÅLT, M8). Registeret avsluttes på
				// barneøktens ID, den samme `agent.start` registrerte.
				if (isSubagentTool(e.tool)) {
					const ferdig = subagentFerdig(e.input, result);
					if (ferdig) {
						await dispatch({ ...base(e.sessionID), type: "agent.stop", ...ferdig });
					} else {
						fileLog(`[v2] ${e.tool} fullført uten barneøkt i resultatet — ingen agent.stop`, "warn");
					}
				}
				return undefined;
			})
		);

		// === BRUKERMELDING (fase 3) ===
		//
		// Hooken fyrer også for en subagents barneøkt (MÅLT, M8). Den prompten
		// er ikke brukerens, og ville ellers gitt en ny arbeidsøkt og en falsk
		// linje i THREAD — og, fra fase 4, en egen `session.start` og teardown.
		//
		// Første prompt per hovedøkt er også sesjonsstarten, siden
		// `session.created` aldri kommer for hovedøkten (MÅLT, M1).
		await ctx.session.hook(
			"prompt",
			vakt("session.prompt", async (e): Promise<HookUtfall> => {
				const sessionId = somTekst(e.sessionID);
				const tekst = somTekst(somObjekt(e.prompt).text);
				if (buss.erBarneprompt(sessionId, tekst)) {
					fileLog(`[v2] session.prompt fra barneøkt ${sessionId} — ikke en brukermelding`, "debug");
					return undefined;
				}
				await livssyklus.prompt(sessionId);
				agentsjekk ??= sjekkAgentene();
				if (!tekst) return undefined;
				await dispatch({ ...base(sessionId), type: "user.message", text: tekst });
				return undefined;
			})
		);

		// === KONTEKST (fase 3) ===
		//
		// Fyrer per tur og bygger `system` på nytt hver gang (MÅLT), som v1s
		// `chat.system.transform`. Injeksjonen akkumulerer altså ikke.
		await ctx.session.hook(
			"context",
			vakt("session.context", async (e): Promise<HookUtfall> => {
				const result = await dispatch({ ...base(e.sessionID), type: "context.build" });
				for (const tekst of result.additionalContext ?? []) {
					e.system.push({ type: "text", text: tekst });
				}
				const varsel = agentsjekk ? await agentsjekk : null;
				if (varsel) e.system.push({ type: "text", text: varsel });
				return undefined;
			})
		);
		// === KOMPAKTERING (fase 5) ===
		//
		// Fyrer før kompakteringen, og `system.push` når kompakteringsmodellen
		// (MÅLT, M9). Samme seksjoner som v1s `experimental.session.compacting`:
		// subagentregisteret, aktiv PRD og algoritmetilstanden, så sammendraget
		// bærer dem videre. Barneøkter har ingen av delene.
		await ctx.session.hook(
			"compaction",
			vakt("session.compaction", async (e): Promise<HookUtfall> => {
				const sessionId = somTekst(e.sessionID);
				if (!sessionId || buss.erBarn(sessionId)) return undefined;
				fileLog("[Compaction:Pre] Context injection triggered", "info");
				for (const tekst of await buildCompactionContext({ sessionID: sessionId })) {
					e.system.push({ type: "text", text: tekst });
				}
				return undefined;
			})
		);
		// === SKALLMILJØ (fase 3) ===
		//
		// En mutert `e.env` når kommandoen (MÅLT, fase 0).
		await ctx.shell.hook(
			"create.before",
			vakt("shell.create.before", async (e): Promise<HookUtfall> => {
				const result = await dispatch({
					...base(sisteSkallØkt),
					cwd: somTekst(e.cwd) || cwd,
					type: "shell.env",
				});
				for (const [nøkkel, verdi] of Object.entries(result.env ?? {})) {
					e.env[nøkkel] = verdi;
				}
				return undefined;
			})
		);

		// === KJERNENS `ask` BLIR EN EKTE FORESPØRSEL (fase 2) ===
		//
		// På v1 kunne `ask` bare logges. Her setter vi `effect = "ask"` med
		// kjernens begrunnelse, og motoren spør brukeren (MÅLT, M6). Vi
		// SKJERPER bare: en `deny` motoren allerede har satt, står.
		//
		// MERK: `--auto` gjør `ask` til `allow`, også denne (MÅLT). Derfor
		// bruker launcheren aldri `--auto` (B6). `run` uten `--auto` avslår.
		await ctx.permission.hook(
			"evaluate",
			vakt("permission.evaluate", (e): HookUtfall => {
				const kallId = somTekst(somObjekt(e.source).id);
				const nøkkel = kallNøkkel(somTekst(e.sessionID), kallId);
				const grunn = askMinne.get(nøkkel);
				if (grunn === undefined) return undefined;
				askMinne.delete(nøkkel);
				if (e.effect === "deny") return undefined;
				e.effect = "ask";
				e.message = `${BLOKK_PREFIKS} ${grunn}`;
				fileLog(`[v2] ask → permission.evaluate for ${kallId} (${e.action})`, "warn");
				return undefined;
			})
		);

		// === PAIS EGNE VERKTØY (fase 5) ===
		//
		// `session_registry`, `session_results` og `code_review`, som v1 og
		// Claude-siden (MCP) har. Modellen når dem via Code Mode (MÅLT, M10).
		//
		// Tilbakekallet er ikke en hook og går ikke gjennom `vakt`, så det
		// fanger selv: kaster det, avviser `setup`, og hva motoren da gjør med
		// hookene som allerede er registrert — sikkerhetsvakten først — er
		// UMÅLT. Av samme grunn kalles `transform` bare hvis den finnes; at den
		// aldri fyrte, fanger `V2Smoke` via fyr-registeret.
		if (typeof ctx.tool.transform === "function") {
			await ctx.tool.transform((editor) => {
				meldFyrt("tool.transform");
				try {
					for (const verktøy of paiVerktøy()) editor.add(verktøy);
				} catch (error) {
					fileLogError("[v2] registrering av PAI-verktøyene feilet (non-blocking)", error);
				}
			});
		} else {
			fileLog("[v2] ctx.tool.transform mangler — PAI-verktøyene er ikke registrert", "warn");
		}

		// === NEDSTENGING ELLER OMLASTING? (fase 4) ===
		//
		// Cleanup kalles også når v2 laster pluginen på nytt, og da kommer
		// ingen `location.shutdown` (MÅLT). Se `livssyklus.ts`. Et EGET
		// abonnement, fordi hovedløkka under awaiter hver dispatch: sluttsvaret
		// kommer rett før nedstengingen, og mens det behandles, ville signalet
		// ligget uhentet.
		void (async () => {
			try {
				for await (const hendelse of ctx.event.subscribe()) {
					if (somTekst(somObjekt(hendelse).type) !== "location.shutdown") continue;
					livssyklus.nedstenging();
					return;
				}
			} catch (error) {
				fileLogError("[v2] nedstengingsvakten på bussen kastet", error);
			}
		})();

		// === BUSSEN: SVAR, SUBAGENTSTART OG KOMPAKTERING (fase 3 og 5) ===
		//
		// Tre ting finnes bare på bussen. Se `buss.ts` for hvordan steg og
		// barneøkter skilles.
		void lyttPåBussen(ctx.event.subscribe(), async (hendelse) => {
			const utfall = buss.hendelse(hendelse);
			if (!utfall) return;
			switch (utfall.type) {
				case "svar":
					await dispatch({ ...base(utfall.sessionId), type: "assistant.message", text: utfall.tekst });
					return;
				case "agent.start":
					await dispatch({
						...base(utfall.sessionId),
						type: "agent.start",
						agentId: utfall.agentId,
						agentType: utfall.agentType,
						description: utfall.beskrivelse,
					});
					return;
				case "session.compacted":
					await dispatch({
						...base(utfall.sessionId),
						type: "session.compacted",
						trigger: utfall.trigger,
						summary: utfall.sammendrag,
					});
					return;
			}
		});

		// Den ENESTE sesjonsslutten v2 gir, men bare når `location.shutdown`
		// kom først. Turslutt (`session.execution.succeeded`) og sletting
		// (`session.deleted`) på bussen er det ikke, og ingen av dem er koblet
		// hit (H-17).
		return async () => {
			meldFyrt("plugin.cleanup");
			await livssyklus.slutt();
		};
	},
});
