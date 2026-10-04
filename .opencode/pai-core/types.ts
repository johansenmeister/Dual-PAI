/**
 * PAI Core — harness-uavhengig kontrakt
 *
 * Denne modulen importerer ingen motor. Alt som er spesifikt for én motor
 * hører hjemme i adapterlaget.
 *
 * Unionen utvides når en hendelse faktisk håndteres — en union med
 * uimplementerte medlemmer er nøyaktig den døde koden defektregisteret er
 * fullt av. `agent.start`/`agent.stop` kom inn i batch 7, da Claude Codes
 * SubagentStart/SubagentStop ga dem en kilde med egne felter, og v2 har
 * sin egen (fase 5). v1 hadde ingen, og utledet fangsten av `tool.after`
 * filtrert på Task; den veien ble slettet med v1.
 *
 * @module pai-core/types
 */

/**
 * Hvilken motor hendelsen kom fra.
 *
 * `opencode2` er OpenCode v2 (`@opencode/cli`, `Plugin.define`). v1
 * (`opencode-ai`) het `opencode` og ble slettet i fase 7 (2026-09-26); verdien
 * står fortsatt som `harness: opencode` i eldre MEMORY-filer, men ingen
 * prosess skriver den lenger. `opencode2` beholdes framfor å døpe om, så
 * sesjonsnøkkelen (`o2_`) og `harness:`-feltet i MEMORY betyr det samme før
 * og etter slettingen. Se `docs/opencode-v2/plan.md`, B1.
 */
export type Harness = "opencode2" | "claude";

export interface PaiEventBase {
	harness: Harness;
	/** Motorens egen sesjons-ID, uendret. Kan være tom når motoren ikke gir én. */
	sessionId: string;
	/**
	 * Nøkkelen som brukes i ALLE filnavn under STATE/.
	 *
	 * Aldri lik `sessionId`: den er prefikset med motor, slik at to harness
	 * som deler MEMORY-tre ikke kan kollidere på samme rå ID. Utledes av
	 * `sessionKeyFor()` i runtime.ts — bygg den aldri for hånd.
	 */
	sessionKey: string;
	/** Millisekunder siden epoch. */
	at: number;
	cwd: string;
}

/**
 * Verktøykall er i ferd med å kjøre. Vakten kan nekte her.
 *
 * MERK om `args`: OpenCode leverer dem i hookens `output`, ikke `input`
 * (dokumentert quirk, `pai-unified.ts:519`). Normaliseringen er adapterens
 * jobb — kjernen ser alltid ett felt.
 */
export interface PaiToolBeforeEvent extends PaiEventBase {
	type: "tool.before";
	tool: string;
	args: Record<string, unknown>;
}

/**
 * Verktøykall er ferdig. Kun observasjon — utfallet kan ikke endres.
 *
 * `result` er UVERIFISERT på OpenCode-siden: SDK-typen for hookens `output`
 * oppgir `title`/`output`/`metadata`, ikke `result`, men koden har lest
 * `output.result` i lang tid. Typefila har tatt feil før (se M-10), så
 * adapteren sender det den finner og kjernen behandler feltet som `unknown`.
 * Se M-15 i defektregisteret.
 */
export interface PaiToolAfterEvent extends PaiEventBase {
	type: "tool.after";
	tool: string;
	args: Record<string, unknown>;
	result: unknown;
	/**
	 * Motorens strukturerte sidekanal ved siden av resultatteksten.
	 *
	 * Må være med: `session-registry.extractSessionId` prøver
	 * `metadata.sessionId` FØR den parser `<task_metadata>` ut av teksten.
	 * Faller feltet bort, mister subagent-registreringen sin foretrukne
	 * kilde og faller stille tilbake på tekstparsing.
	 */
	metadata?: Record<string, unknown>;
	callId?: string;
}

/**
 * Motoren spør om tillatelse.
 *
 * `tool` og `args` er valgfrie med vilje: OpenCodes `Permission`-type har
 * ingen av dem (K-02), så på den siden kommer hendelsen alltid uten. Claude
 * Codes PermissionRequest har dem. Kjernen må tåle begge.
 */
export interface PaiPermissionAskEvent extends PaiEventBase {
	type: "permission.ask";
	tool?: string;
	args?: Record<string, unknown>;
}

/**
 * Motoren bygger systemkonteksten for en ny tur eller sesjon.
 *
 * Kadensen er IKKE lik mellom motorene, og det er en egenskap ved hendelsen,
 * ikke ved kjernen: `experimental.chat.system.transform` fyrer per tur (målt
 * 2026-09-20: seks injeksjoner à 25 968 tegn på ett spørsmål), mens Claude
 * Codes `SessionStart` fyrer én gang per sesjon. Kjernen bygger den samme
 * konteksten uansett; hvor ofte den spørres er adapterens valg.
 */
export interface PaiContextBuildEvent extends PaiEventBase {
	type: "context.build";
}

/** Ny sesjon. Skill-restore, versjonssjekk, nullstilling av buffere. */
export interface PaiSessionStartEvent extends PaiEventBase {
	type: "session.start";
}

/**
 * Sesjonen avsluttes. Teardown: læring, integritet, arbeidsøkt, opprydding.
 *
 * `reason` sier hva som UTLØSTE teardown, og det er ikke en detalj.
 *
 * OpenCode har ingen sesjonsslutt-hendelse i det hele tatt — `session.ended`
 * finnes ikke i binæren (0 treff), og `session.idle` fyrer etter hver
 * assistenttur (H-12). Å behandle idle som slutt var det som fragmenterte
 * arbeidshistorikken i H-17. Derfor utløses teardown nå av:
 *
 *   `exit`    prosessen avsluttes — motoren sa fra mens den levde
 *   `reaped`  en tidligere økts prosess er død, oppdaget ved oppstart
 *
 * Claude Codes `SessionEnd` gir `exit` direkte. Reaperen er det som gjør
 * kjeden pålitelig i begge motorene, siden SIGKILL ikke varsler noen.
 */
export interface PaiSessionEndEvent extends PaiEventBase {
	type: "session.end";
	reason: "exit" | "reaped";
	/**
	 * Motorens egen begrunnelse, uoversatt.
	 *
	 * Claude Codes `SessionEnd` bærer `reason: clear | resume | logout |
	 * prompt_input_exit | other` (skjemaet i binæren, 2.1.278). Alle fem
	 * betyr «denne økten er over», så alle blir `exit` her — men hvilken av
	 * dem det var, er verdt å ha i loggen når en teardown ser rar ut.
	 * Kjernen forgrener ALDRI på feltet; da ville den kjent motoren.
	 */
	detail?: string;
}

/**
 * Kompaktering er ferdig. Kun observasjon: læringen trekkes ut ved teardown
 * fra de samme arbeidsfilene, som kompakteringen ikke rører (M-35).
 *
 * MERK at det IKKE finnes noen «session.compacting»-hendelse her, og at det
 * er målt, ikke glemt: Claude Codes `PreCompact` har intet
 * `hookSpecificOutput`-skjema i binæren (2.1.278), kun fellesformen
 * `continue`/`decision`/`stopReason`/`systemMessage`. Den kan altså ikke
 * injisere kontekst slik OpenCodes `experimental.session.compacting` gjør.
 * Det som dekker kompaktering på Claude-siden er `SessionStart` med
 * `source: "compact"`, som adapteren behandler som enhver annen start.
 */
export interface PaiSessionCompactedEvent extends PaiEventBase {
	type: "session.compacted";
	/** Hva som utløste kompakteringen. `undefined` når motoren ikke sier det. */
	trigger?: "manual" | "auto";
	/**
	 * Sammendraget kompakteringen produserte.
	 *
	 * Claude Codes `PostCompact` gir det ferdig (`compact_summary`), og
	 * OpenCode v2 gir det i `session.compaction.ended` (`text`); v1 gir
	 * ingenting. Feltet er derfor valgfritt og brukes kun til logg og
	 * lengdemåling.
	 */
	summary?: string;
}

/** Bruker har sendt en melding. */
export interface PaiUserMessageEvent extends PaiEventBase {
	type: "user.message";
	text: string;
}

/**
 * Assistenten har levert et fullstendig svar.
 *
 * INGEN OPENCODE-KILDE. Målt 2026-09-21: `message.updated` bærer kun
 * metadata (`properties = {sessionID, info}`, og `info` har verken `content`
 * eller `parts`), så teksten finnes ikke på hendelsen. Adapteren emitterer
 * derfor ikke denne på OpenCode i dag — se K-08 i defektregisteret og
 * batch 4b. Claude Codes `Stop` gir `last_assistant_message` direkte.
 */
export interface PaiAssistantMessageEvent extends PaiEventBase {
	type: "assistant.message";
	text: string;
	/**
	 * Kjører denne turen allerede fordi en tidligere blokkering ba modellen
	 * fortsette?
	 *
	 * Løkkevakten for ISC-håndhevelsen. Blokkerer vi en tur, får modellen
	 * beskjeden og svarer på nytt — og blokkerer vi DEN også, står de to i
	 * ring til brukeren griper inn. Claude Code sier fra via
	 * `stop_hook_active` (målt `false` på en vanlig tur); er feltet sant,
	 * skal kjernen aldri blokkere igjen.
	 *
	 * `undefined` betyr «motoren sier det ikke», og behandles som `false`.
	 * OpenCode kan uansett ikke blokkere en tur.
	 */
	continuedAfterBlock?: boolean;
}

/**
 * Verktøykallet feilet. Kun observasjon — som `tool.after`, men for utfallet
 * der resultatet er en feil og ikke et svar.
 *
 * EGEN HENDELSE, ikke et flagg på `tool.after`. Grunnen er at konsumentene
 * er ulike og at et flagg må huskes: PRD-synk skal ikke lese en fil som
 * aldri ble skrevet, spørsmålssporing skal ikke registrere et svar som aldri
 * kom, og `emitToolExecute` har allerede et `success`-felt som til nå har
 * vært hardkodet `true` fordi ingen kilde til `false` fantes. Den som
 * glemmer å sjekke et flagg, behandler et feilet kall som vellykket i
 * stillhet; den som glemmer å håndtere en unionsvariant, får typefeil.
 *
 * INGEN OPENCODE-KILDE: `tool.execute.after` fyrer også ved feil, men uten
 * noe felt som skiller de to utfallene. Claude Codes `PostToolUseFailure`
 * har `error` og `is_interrupt`.
 */
export interface PaiToolFailedEvent extends PaiEventBase {
	type: "tool.failed";
	tool: string;
	args: Record<string, unknown>;
	/** Motorens feiltekst. Alltid en streng — tom når motoren ikke gir noen. */
	error: string;
	/**
	 * Ble kallet avbrutt av brukeren framfor å feile av seg selv?
	 *
	 * Et avbrudd er et VALG, ikke en defekt, og skal ikke telle som en feil
	 * i noen statistikk. Claude Code sier fra via `is_interrupt`.
	 */
	isInterrupt?: boolean;
	callId?: string;
}

/**
 * En subagent er startet.
 *
 * Claude Code og OpenCode v2. `SubagentStart` bærer `agent_id` og
 * `agent_type` direkte; v2 gir barneøktens `session.created` med `parentID`
 * og `agent` på bussen. Begge gir `running` før subagenten er ferdig, så en
 * subagent som krasjer blir synlig i registeret.
 */
export interface PaiAgentStartEvent extends PaiEventBase {
	type: "agent.start";
	/** Motorens ID for subagenten. Nøkkelen registeret oppdaterer på. */
	agentId: string;
	/**
	 * Agenttypen, slik motoren oppgir den.
	 *
	 * Dette er hele poenget med hendelsen: på OpenCode utledes typen av
	 * `args.subagent_type` og rapporteres `unknown` av årsaker ingen har
	 * funnet. Her kommer den fra motoren og kan ikke bli `unknown`.
	 */
	agentType: string;
	/**
	 * Hva subagenten ble bedt om, med motorens egne ord.
	 *
	 * Claude Codes `SubagentStart` har det ikke. OpenCode v2 gir det som
	 * `title` på barneøktens `session.created`, og det er `description` fra
	 * `subagent`-kallet (MÅLT 2026-09-26). Uten feltet står «subagent» i
	 * registerets beskrivelseskolonne.
	 */
	description?: string;
}

/**
 * En subagent er ferdig.
 *
 * Claude Code og OpenCode v2, se `PaiAgentStartEvent`. `SubagentStop` gir
 * både `agent_type` og `last_assistant_message`; v2s `execute.after` på
 * `subagent` gir `result.output = {sessionID, status, output}`. Fangsten
 * slipper å parse verktøyteksten for å finne svaret i begge.
 */
export interface PaiAgentStopEvent extends PaiEventBase {
	type: "agent.stop";
	agentId: string;
	agentType: string;
	/** Subagentens siste svar. Tom streng når motoren ikke gir noen. */
	output: string;
	/** Transkriptet subagenten skrev. Registreres, ikke lest. */
	transcriptPath?: string;
}

/**
 * Et verktøy er i ferd med å spawne et skall og trenger PAI-miljøet.
 *
 * OpenCode-bash er tilstandsløs — hvert kall er en frisk prosess. Claude Code
 * har ingen tilsvarende hook (gap 1); der dekkes de statiske nøklene av
 * `settings.json.env`.
 */
export interface PaiShellEnvEvent extends PaiEventBase {
	type: "shell.env";
}

export type PaiEvent =
	| PaiContextBuildEvent
	| PaiSessionStartEvent
	| PaiSessionEndEvent
	| PaiSessionCompactedEvent
	| PaiUserMessageEvent
	| PaiAssistantMessageEvent
	| PaiToolBeforeEvent
	| PaiToolAfterEvent
	| PaiToolFailedEvent
	| PaiAgentStartEvent
	| PaiAgentStopEvent
	| PaiPermissionAskEvent
	| PaiShellEnvEvent;

/**
 * Hva kjernen vil at motoren skal gjøre.
 *
 * Alle felter er valgfrie. Et tomt resultat betyr «ingen innvending».
 */
export interface PaiResult {
	/**
	 * Blokkering som returverdi, ikke som `throw`.
	 *
	 * Dette er strukturfiksen for K-07: så lenge blokkering var et unntak,
	 * kunne ikke adapteren fange interne feil uten samtidig å svelge en
	 * tiltenkt blokkering. Nå kan den skille dem.
	 */
	permission?: "allow" | "deny" | "ask";
	/** Menneskelesbar begrunnelse for `permission`. Logges, og vises til bruker ved deny. */
	reason?: string;
	/** Beskjed til modellen når kallet nektes. Faller tilbake til `reason`. */
	message?: string;
	/**
	 * Systemkontekst motoren skal injisere.
	 *
	 * Liste, ikke streng: OpenCode tar imot `output.system.push(...)` og
	 * Claude Code én `additionalContext`-streng. Adapteren velger form, så
	 * kjernen slipper å vite hvilken.
	 */
	additionalContext?: string[];
	/**
	 * Nekt modellen å avslutte turen.
	 *
	 * Skilt fra `permission` med vilje: `permission` gjelder ET VERKTØYKALL
	 * som ikke har kjørt ennå, mens dette gjelder en TUR som er ferdig. De to
	 * har ulik utdataform i motoren også — `hookSpecificOutput.
	 * permissionDecision` mot toppnivå `decision: "block"` — og å presse dem
	 * inn i samme felt ville tvunget adapteren til å gjette ut fra
	 * hendelsesnavnet hvilken av dem kjernen mente.
	 *
	 * `message` går til MODELLEN og skal si hva som mangler, ikke bare at noe
	 * mangler: den er hele grunnlaget modellen har for å rette seg.
	 *
	 * Kun `assistant.message`, og kun når `PAI_ISC_ENFORCE=block`. OpenCode
	 * har ingen kanal for dette og ignorerer feltet.
	 */
	block?: { message: string };
	/**
	 * Omskrevne verktøyargumenter motoren skal bruke i stedet for de sendte.
	 *
	 * Kun `tool.before`. MÅLT 2026-09-22 mot Claude Code 2.1.278: motoren
	 * leser `hookSpecificOutput.updatedInput` FØR den slår opp agenttypen, så
	 * en omskriving her avgjør hvilken agent som faktisk spawnes.
	 *
	 * Det er ikke en finesse. Claude Code eksponerer plugin-agenter som
	 * `pai:Engineer`, og et BART navn resolver ikke — «Agent type 'Engineer'
	 * not found». Promptmaterialet i dette repoet sier `subagent_type:
	 * "Engineer"` 139 steder. Uten denne kanalen er hver genererte agent
	 * uadresserbar.
	 *
	 * OpenCode har ingen tilsvarende kanal og ignorerer feltet — der heter
	 * agentene det de alltid har hett.
	 */
	updatedArgs?: Record<string, unknown>;
	/** Miljøvariabler skallet skal få. Kun `shell.env`. */
	env?: Record<string, string>;
	/** Diagnostikk. Aldri styrende — kun for logg og tester. */
	notes?: string[];
}

/**
 * Hva denne motoren kan.
 *
 * Grep på `harness ===` skal kun treffe runtime.ts og adapterne. Alt annet
 * spør om kapabilitet, ellers blir paritetskravet uetterrettelig.
 */
export interface PaiCapabilities {
	observability: boolean;
	/**
	 * Må agentnavn oversettes til motorens egne?
	 *
	 * Claude Code eksponerer plugin-agenter som `pai:Engineer`, og et bart
	 * navn resolver ikke (målt 2026-09-22). OpenCode kjenner dem ved navnet
	 * de alltid har hatt.
	 *
	 * Dette MÅ være en kapabilitet og ikke et fil-fravær: `agent-alias.json`
	 * ligger i samme repo som OpenCode-siden kjører fra, så «finnes fila?»
	 * er sant i begge motorene. Gatet på fil ville OpenCode skrevet om
	 * `Engineer` til `pai:Engineer` og brutt hver eneste subagent-spawn.
	 */
	agentAliases: boolean;
}
