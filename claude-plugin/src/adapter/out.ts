/**
 * Claude-adapter — PaiResult inn, hook-utdata ut
 *
 * BLOKKERING ER EN RETURVERDI, IKKE ET UNNTAK. Det er strukturfiksen for
 * K-07: så lenge blokkering var et `throw`, kunne ikke adapteren fange
 * interne feil uten samtidig å svelge en tiltenkt blokkering. Kjernen kaster
 * aldri, så alt som kommer hit er en bevisst avgjørelse.
 *
 * Utdataformen er MÅLT mot Claude Code 2.1.278 (2026-09-21):
 *
 *   `permissionDecision` er "allow" | "deny" | "ask" — IKKE "request".
 *   Binærens egen hjelpetekst: «- `permissionDecision` - "allow", "deny",
 *   or "ask" (PreToolUse only)». Planen anga "request"; det er feil.
 *
 *   `permissionDecisionReason` når fram til MODELLEN ordrett. Verifisert
 *   ende-til-ende: en blokkert Bash-kommando ga svaret «Feilmelding: [PAI
 *   Security] Mønsteret FARLIG er blokkert av PAI-vakten.»
 *
 *   `additionalContext` virker på både `SessionStart` og `UserPromptSubmit`.
 *   Verifisert ende-til-ende ved at modellen gjenga injisert innhold.
 *
 *   TURBLOKKERING på `Stop` har en HELT ANNEN form: toppnivå
 *   `decision: "block"` + `reason`, ikke `hookSpecificOutput`. Binærens egen
 *   kode leser `permissionDecisionReason ?? reason ?? ""` og tester
 *   `decision === "block"`. Det er grunnen til at `PaiResult` skiller
 *   `permission` fra `block`: ett felt for begge ville tvunget adapteren til
 *   å gjette ut fra hendelsesnavnet hvilken av de to formene kjernen mente.
 *
 * Det siste er paritetsgevinsten mot OpenCode: der kan `tool.execute.before`
 * bare kaste eller la gå, og en «confirm» blir derfor en logglinje ingen ser.
 * Her blir den en reell dialog brukeren kan svare på.
 *
 * @module claude-plugin/adapter/out
 */

import type { PaiResult } from "../../../.opencode/pai-core";
import { fileLog } from "../bootstrap";

/**
 * Over dette legger Claude Code hook-kontekst i en fil og gir modellen bare
 * de første 2 KB (MÅLT 2.1.283, `jDo=1e4` i binæren, K-10). Større kontekst
 * går som systemprompt fra `pai --claude`.
 */
export const CLAUDE_HOOK_TAK = 10_000;

/** Kort beskjed i stedet for en forhåndsvisning modellen ikke kan bruke. */
function forStor(tegn: number): string {
	fileLog(`[pai-hook] Konteksten er ${tegn} tegn, over Claude Codes tak på ${CLAUDE_HOOK_TAK}`, "warn");
	return (
		`PAI: konteksten (${tegn} tegn) er større enn Claude Codes grense for hook-kontekst ` +
		`(${CLAUDE_HOOK_TAK}), og ble ikke sendt. Start økten med \`pai --claude\`, som gir den som systemprompt.`
	);
}

/**
 * Slå sammen flere PaiResult til ett.
 *
 * `SessionStart` gir to hendelser (se in.ts), og begge kan ha noe å si.
 * Kontekstbitene skal begge med; en `deny` fra hvilken som helst av dem
 * vinner. Rekkefølgen på notes bevares, fordi de leses som et spor.
 */
export function slåSammen(resultater: PaiResult[]): PaiResult {
	const samlet: PaiResult = {};
	const kontekst: string[] = [];
	const notes: string[] = [];

	for (const r of resultater) {
		if (r.additionalContext?.length) kontekst.push(...r.additionalContext);
		if (r.notes?.length) notes.push(...r.notes);

		// Strengeste avgjørelse vinner. Uten denne rangeringen ville en senere
		// hendelse som ikke har noen mening kunnet overskrive en blokkering.
		if (r.permission === "deny" || (r.permission === "ask" && samlet.permission !== "deny")) {
			samlet.permission = r.permission;
			samlet.reason = r.reason;
			samlet.message = r.message;
		}

		// Turblokkering er et eget felt fra `permission`, se PaiResult. Første
		// treff vinner: to blokkeringer i samme hendelse ville uansett blitt
		// til én beskjed, og den første er den som utløste den.
		if (r.block && !samlet.block) samlet.block = r.block;

		// Omskrevne argumenter slås SAMMEN framfor at siste vinner: to
		// hendelser kan rette hvert sitt felt, og et helt objekt som
		// overskriver ville stilletiende kastet den andres rettelse.
		if (r.updatedArgs) samlet.updatedArgs = { ...samlet.updatedArgs, ...r.updatedArgs };
		if (r.output) samlet.output = r.output;
	}

	if (kontekst.length > 0) samlet.additionalContext = kontekst;
	if (notes.length > 0) samlet.notes = notes;
	return samlet;
}

/**
 * Bygg JSON-dokumentet Claude Code skal lese på stdout.
 *
 * @returns Én streng, ferdig serialisert. Kalleren skriver den i ETT stykke
 *   og avslutter — se `bin/pai-hook.ts`. Det er med vilje at denne funksjonen
 *   returnerer en streng framfor å skrive selv: da finnes det nøyaktig ett
 *   sted i hele adapteren som rører stdout.
 */
export function tilHookUtdata(hendelsesnavn: string, result: PaiResult): string {
	switch (hendelsesnavn) {
		case "PreToolUse": {
			if (result.permission === "deny") {
				return JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						// Begrunnelsen går til MODELLEN, ikke bare til loggen, så
						// den kan korrigere seg selv. Prefikset gjør det tydelig
						// hvem som blokkerte — ellers ser det ut som en verktøyfeil.
						permissionDecisionReason: `[PAI Security] ${result.message || result.reason || "Blokkert av PAI-vakten"}`,
					},
				});
			}

			if (result.permission === "ask") {
				// PARITETSGEVINST. OpenCode kan ikke eskalere til en dialog fra
				// `tool.execute.before`, så der ender en «confirm» som en
				// advarsel i loggen. Her spør vi brukeren på ekte.
				return JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "ask",
						permissionDecisionReason: `[PAI Security] ${result.reason || "Krever bekreftelse"}`,
					},
				});
			}

			// OMSKREVNE ARGUMENTER. MÅLT 2026-09-22: motoren leser
			// `updatedInput` FØR den slår opp agenttypen, så dette er det som
			// gjør `subagent_type: "Engineer"` til `pai:Engineer` — uten
			// omskrivingen resolver ikke et bart agentnavn i det hele tatt.
			//
			// Sendes UTEN `permissionDecision`. Å legge ved "allow" ville
			// overstyrt brukerens egne permission-regler; vi retter
			// argumentene og lar tillatelsesspørsmålet stå urørt.
			if (result.updatedArgs) {
				return JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						updatedInput: result.updatedArgs,
					},
				});
			}

			// "allow" sendes IKKE. Det ville overstyrt brukerens egne
			// permission-regler og gjort PAI til en omgåelse av dem. PAI
			// blokkerer eller lar være — tillatelse er brukerens domene.
			return "{}";
		}

		case "SessionStart":
		case "UserPromptSubmit": {
			if (!result.additionalContext?.length) return "{}";
			const tekst = result.additionalContext.join("\n\n");
			return JSON.stringify({
				hookSpecificOutput: {
					hookEventName: hendelsesnavn,
					// Kjernen gir en LISTE fordi OpenCode tar `system.push(...)`.
					// Claude Code tar én streng. Sammenføyningen hører hjemme
					// her, ikke i kjernen.
					additionalContext: tekst.length > CLAUDE_HOOK_TAK ? forStor(tekst.length) : tekst,
				},
			});
		}

		case "Stop": {
			// TURBLOKKERING — den ene hendelsen der PAI kan nekte modellen å gi
			// seg. Formen er en ANNEN enn PreToolUse sin: her er det TOPPNIVÅ
			// `decision: "block"` + `reason`, ikke `hookSpecificOutput.
			// permissionDecision`. Binæren leser `permissionDecisionReason ??
			// reason ?? ""` og behandler `decision === "block"` som blokkering
			// (2.1.278). Blandes de to formene, forsvinner begrunnelsen.
			//
			// Kjernen har allerede sjekket `PAI_ISC_ENFORCE` og løkkevakten;
			// står `block` her, er avgjørelsen tatt. Adapteren oversetter.
			if (result.block) {
				return JSON.stringify({
					decision: "block",
					reason: result.block.message,
				});
			}
			// Ellers ren observasjon: PAI har ingenting å si tilbake.
			return "{}";
		}

		case "PostToolUse":
			// The masked output replaces what the model sees, for built-in
			// tools too (MEASURED 2026-10-07 on 2.1.283 with Bash, Read and
			// Grep), and the note says what was masked (#367).
			if (!result.output) return "{}";
			return JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					updatedToolOutput: result.output.value,
					additionalContext: result.output.notice,
				},
			});

		default:
			// Alt annet er observasjon. `PostToolUse`, `PostToolUseFailure`,
			// `SubagentStart`, `SubagentStop`, `SessionEnd` og `PostCompact`
			// gjør arbeid i kjernen, men har ingen beskjed til motoren — og et
			// tomt objekt er det eneste svaret som ALLTID er gyldig.
			//
			// Merk at det ikke finnes noen fellesgren for `additionalContext`
			// her selv om flere av dem tar imot det. Kjernen produserer ingen
			// på de hendelsene, og en kanal uten avsender er død kode som ser
			// levende ut.
			return "{}";
	}
}
