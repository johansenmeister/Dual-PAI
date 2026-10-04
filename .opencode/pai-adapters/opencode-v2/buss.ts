/**
 * v2-adapteren — oversettelse av hendelsesbussen
 *
 * Tre ting v2 bare forteller på bussen, og ikke i en hook:
 *
 *   1. Hvilke økter som er subagenters BARNEØKTER (`session.created` med
 *      `parentID`). Deres prompt og svar er ikke brukerens samtale, og
 *      hendelsen er samtidig subagentens START (`agent.start`, fase 5).
 *   2. Assistentens svartekst (`session.text.ended`), og når svaret er ferdig
 *      (`session.step.ended` med `finish: "stop"`).
 *   3. At en kompaktering er ferdig (`session.compaction.ended`, med hele
 *      sammendraget i `text`).
 *
 * Holdt fri for motor-API og I/O, så den kan testes med hendelser alene.
 * Indeksen eier dispatch; denne eier bare tilstanden.
 *
 * @module pai-adapters/opencode-v2/buss
 */

import { somObjekt, somTekst } from "../../pai-core/lib/payload";

/**
 * Teksten v2 setter foran en subagents prompt (MÅLT 2026-09-25, fase 0).
 *
 * Dette er den PRIMÆRE kilden til «er dette en barneøkt?» for prompten, ikke
 * `session.created`. I fase 0-rådataen kom barneøktens `session.prompt`
 * 12:58:57.286 og dens `session.created` 12:58:57.293 — hooken fyrer altså FØR
 * bussen har levert hendelsen som sier at økten er et barn. Et filter bygd på
 * bussen alene ville latt subagentens første prompt gå inn som brukermelding.
 */
export const SUBAGENT_PREFIKS = "You are a subagent spawned by another session.";

/** Tak på samtidige ufullførte steg. Et steg som aldri ender, skal ikke leve evig. */
const STEG_TAK = 200;

export interface FerdigSvar {
	type: "svar";
	sessionId: string;
	tekst: string;
}

/**
 * En subagent er startet: barneøkten finnes.
 *
 * MÅLT 2026-09-26 (2.0.16): `session.created` for barnet bærer `parentID`,
 * `agent` (PAI-agentens navn, uten prefiks, f.eks. `Engineer`) og `title`,
 * som er `description` fra `subagent`-kallet. Barnets `sessionID` er nøkkelen
 * registeret bruker, og den samme som `execute.after` på `subagent` gir i
 * `result.output.sessionID` når subagenten er ferdig.
 */
export interface SubagentStartet {
	type: "agent.start";
	/** Forelderøkten — den registeret hører til. */
	sessionId: string;
	agentId: string;
	agentType: string;
	beskrivelse: string;
}

/**
 * En kompaktering er ferdig.
 *
 * MÅLT 2026-09-25 (fase 0): `session.compaction.ended` med `reason:
 * "manual"` og hele sammendraget i `text`. Hvilken `reason` en automatisk
 * kompaktering gir, er UMÅLT; bare de to verdiene kjernen kjenner, slippes
 * gjennom.
 */
export interface Kompaktert {
	type: "session.compacted";
	sessionId: string;
	trigger?: "manual" | "auto";
	sammendrag: string;
}

export type BussUtfall = FerdigSvar | SubagentStartet | Kompaktert;

export class Bussoversetter {
	/** Barneøkter sett på bussen. */
	private readonly barn = new Set<string>();

	/**
	 * Tekstdeler per steg (`assistantMessageID`), nøklet på `ordinal`.
	 *
	 * `session.text.ended` bærer HELE delens tekst (MÅLT, M1), så ingenting
	 * akkumuleres fra deltaer — `session.text.delta` brukes ikke. Det er
	 * K-08-bufferen fra v1 uten bufferen.
	 */
	private readonly steg = new Map<string, { sessionId: string; deler: Map<number, string> }>();

	/** Er økten en subagents barneøkt, slik bussen har meldt det? */
	erBarn(sessionId: string): boolean {
		return this.barn.has(sessionId);
	}

	/** Er denne prompten fra en subagent, og ikke fra brukeren? */
	erBarneprompt(sessionId: string, tekst: string): boolean {
		return tekst.startsWith(SUBAGENT_PREFIKS) || this.barn.has(sessionId);
	}

	/**
	 * Ta imot én hendelse fra bussen. Returnerer det kjernen skal ha av den:
	 * sluttsvaret når et steg ender med `finish: "stop"`, subagentens start
	 * når en barneøkt opprettes, og kompakteringens slutt. Ellers `undefined`.
	 *
	 * Hvert steg har sin egen `assistantMessageID` (MÅLT 2026-09-25). Tekst i et
	 * steg som ender med `tool-calls` er mellomtekst («Jeg kjører …»); det er
	 * steget med `stop` som er svaret. Samme semantikk som Claudes
	 * `last_assistant_message`, og det kjernens ISC-validering og
	 * responsfangst forventer.
	 */
	hendelse(rå: unknown): BussUtfall | undefined {
		const h = somObjekt(rå);
		const type = somTekst(h.type);
		const d = somObjekt(h.data ?? h.properties);
		const sessionId = somTekst(d.sessionID);

		if (type === "session.created") {
			const forelder = somTekst(d.parentID);
			if (!forelder || !sessionId) return undefined;
			this.barn.add(sessionId);
			return {
				type: "agent.start",
				sessionId: forelder,
				agentId: sessionId,
				agentType: somTekst(d.agent),
				beskrivelse: somTekst(d.title),
			};
		}

		if (type === "session.compaction.ended") {
			if (!sessionId || this.barn.has(sessionId)) return undefined;
			const grunn = somTekst(d.reason);
			return {
				type: "session.compacted",
				sessionId,
				trigger: grunn === "manual" || grunn === "auto" ? grunn : undefined,
				sammendrag: somTekst(d.text),
			};
		}

		if (type === "session.text.ended") {
			const stegId = somTekst(d.assistantMessageID);
			const tekst = somTekst(d.text);
			if (!stegId || !tekst || this.barn.has(sessionId)) return undefined;
			let s = this.steg.get(stegId);
			if (!s) {
				if (this.steg.size >= STEG_TAK) {
					const eldste = this.steg.keys().next().value;
					if (eldste !== undefined) this.steg.delete(eldste);
				}
				s = { sessionId, deler: new Map() };
				this.steg.set(stegId, s);
			}
			const ordinal = typeof d.ordinal === "number" ? d.ordinal : s.deler.size;
			s.deler.set(ordinal, tekst);
			return undefined;
		}

		if (type === "session.step.ended") {
			const stegId = somTekst(d.assistantMessageID);
			const s = this.steg.get(stegId);
			this.steg.delete(stegId);
			if (!s || somTekst(d.finish) !== "stop") return undefined;
			const tekst = [...s.deler.entries()]
				.sort(([a], [b]) => a - b)
				.map(([, t]) => t)
				.join("\n\n");
			return tekst ? { type: "svar", sessionId: s.sessionId, tekst } : undefined;
		}

		return undefined;
	}
}

/**
 * Teksten et verktøy ga modellen, fra `execute.after` sitt `result`.
 *
 * MÅLT (fase 0): `result = {output, content: [{type: "text", text}], metadata}`.
 * `content` er det modellen ser, og det samme v1 ga i `output.output` — som er
 * det kjernens konsumenter (agentfangst, algoritmesporing) leser. `output` er
 * strukturert og varierer per verktøy (`{exit, output, status}` for shell,
 * `{sessionID, status, output}` for subagent), så den brukes bare som reserve.
 */
export function resultatTekst(result: unknown): string {
	const r = somObjekt(result);
	if (Array.isArray(r.content)) {
		const tekst = r.content
			.map((c) => somObjekt(c))
			.filter((c) => c.type === "text")
			.map((c) => somTekst(c.text))
			.join("");
		if (tekst) return tekst;
	}
	if (typeof r.output === "string") return r.output;
	if (r.output === undefined) return "";
	try {
		return JSON.stringify(r.output);
	} catch {
		return "";
	}
}

/** Det `agent.stop` trenger fra et fullført `subagent`-kall. */
export interface SubagentFerdig {
	agentId: string;
	agentType: string;
	output: string;
}

/**
 * Subagentens svar, fra `execute.after` på `subagent`.
 *
 * MÅLT 2026-09-26 (2.0.16): `input = {agent, description, prompt}` og
 * `result.output = {sessionID, status: "completed", output}`. `output` er
 * subagentens svar alene; `result.content` er det samme pakket inn i
 * `<subagent sessionID=… state=…>`, som er det modellen ser. `sessionID` er
 * barneøkten, altså samme ID som `agent.start` registrerte fra bussen.
 *
 * `undefined` når kallet ikke bar en barneøkt. Da finnes det ingen
 * registeroppføring å avslutte, og å finne på en ID ville gitt en.
 */
export function subagentFerdig(input: unknown, result: unknown): SubagentFerdig | undefined {
	const ut = somObjekt(somObjekt(result).output);
	const agentId = somTekst(ut.sessionID);
	if (!agentId) return undefined;
	return {
		agentId,
		agentType: somTekst(somObjekt(input).agent),
		output: somTekst(ut.output),
	};
}
