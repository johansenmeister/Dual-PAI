/**
 * v2-adapteren — selvtesten som krever motoren (K6)
 *
 * En PAI-agent med `mode: primary` kan ikke spawnes som subagent under v2:
 * `subagent {agent: "Engineer"}` gir «Agent Engineer cannot run as a
 * subagent», og modellen får bare `explore` og `general` oppgitt (MÅLT, fase
 * 5). Stumt for brukeren, som bare ser at modellen gjør jobben selv.
 * `tests/agent-mode.test.ts` vokter repoets sytten agenter, men ikke en agent
 * brukeren legger til selv, og heller ikke en `mode` som settes et annet sted
 * enn i frontmatter.
 *
 * Derfor spørres MOTOREN: `ctx.agent.list()` ved første prompt, der lista er
 * komplett (i `setup` er den ikke det, MÅLT i fase 0). Bare agenter som har en
 * fil i en `agents/`-katalog, sjekkes. Motorens egne primæragenter (`build`,
 * `plan`, `compaction` …) skal være primære, og en liste over dem ville
 * foreldet ved neste versjon og gitt en falsk alarm.
 *
 * Holdt fri for motor-API, som `livssyklus.ts`. Indeksen kaller motoren.
 *
 * @module pai-adapters/opencode-v2/selvtest
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { somListe, somObjekt, somTekst } from "../../pai-core/lib/payload";

/** Repoets egne agenter, der adapteren selv ligger: `.opencode/agents/`. */
export const REPO_AGENTER = join(import.meta.dir, "..", "..", "agents");

/**
 * Navnene på agentfilene i katalogene, uten `.md`. En katalog som ikke finnes,
 * gir ingenting: prosjektet brukeren står i, har sjelden en.
 */
export function agentfiler(kataloger: readonly string[]): string[] {
	const navn = new Set<string>();
	for (const katalog of kataloger) {
		let filer: string[];
		try {
			filer = readdirSync(katalog);
		} catch {
			continue;
		}
		for (const f of filer) if (f.endsWith(".md")) navn.add(f.slice(0, -3));
	}
	return [...navn].sort();
}

/**
 * Agentene med en fil som motoren har som `primary`.
 *
 * `liste` er svaret fra `ctx.agent.list()`, `{data: [{id, mode, …}]}` (MÅLT,
 * fase 0). Sammenlignet uten store/små bokstaver: gjør motoren id-en om til
 * små bokstaver, ville et eksakt treff aldri slått ut, og vakten ville vært
 * taus i feil retning. En agent med fil som ikke står i lista, er et annet
 * problem, og meldes ikke her.
 */
export function primæreAgenter(liste: unknown, filer: readonly string[]): string[] {
	const medFil = new Map(filer.map((f) => [f.toLowerCase(), f]));
	const funnet: string[] = [];
	for (const a of somListe(somObjekt(liste).data)) {
		const agent = somObjekt(a);
		const fil = medFil.get(somTekst(agent.id).toLowerCase());
		if (fil && agent.mode === "primary") funnet.push(fil);
	}
	return funnet.sort();
}

/** Linja modellen får i konteksten, og som logges. Null når alt er i orden. */
export function agentVarsel(primære: readonly string[]): string | null {
	if (primære.length === 0) return null;
	return (
		`PAI-selvtest: ${primære.length === 1 ? "agenten" : "agentene"} ${primære.join(", ")} ` +
		`har \`mode: primary\` og kan ikke spawnes som subagent under OpenCode v2 («cannot run as a subagent»). ` +
		`Rettes med \`mode: all\` i frontmatter i agentfila. Si fra til brukeren hvis du trenger en av dem.`
	);
}
