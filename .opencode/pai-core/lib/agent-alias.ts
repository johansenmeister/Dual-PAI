/**
 * PAI Core — agentnavn på tvers av motorer
 *
 * MÅLT 2026-09-22, ende-til-ende mot Claude Code 2.1.278: plugin-agenter
 * eksponeres som `<plugin>:<navn>`, og et BART navn resolver IKKE. Motorens
 * egen feilmelding, ordrett fra en probe:
 *
 *   Agent type 'ProbeCamelCase' not found. Available agents: claude,
 *   Explore, general-purpose, Plan, probe:ProbeAgentBeta,
 *   probe:ProbeCamelCase, statusline-setup
 *
 * Promptmaterialet i dette repoet sier `subagent_type: "Engineer"` — 139
 * treff i `.md`. Uten omskriving ville altså HVER agentspawn under Claude
 * Code feilet, og de sytten genererte agentdefinisjonene vært uadresserbare.
 *
 * Samme målte kjøring viste veien ut: en PreToolUse-hook som svarer med
 * `hookSpecificOutput.updatedInput` blir lest FØR motoren slår opp
 * agenttypen. A/B-en er entydig — samme prompt feilet uten hooken og
 * lyktes med den.
 *
 * Tabellen GENERERES av `Tools/BuildClaudePlugin.ts` fra de samme
 * agentfilene speilet bygges av. Å skrive den for hånd ville vært å
 * vedlikeholde to lister over de samme sytten navnene.
 *
 * @module pai-core/lib/agent-alias
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileLog } from "../runtime";
import { getPaiHome } from "./paths";

interface AliasFil {
	plugin?: string;
	aliaser?: Record<string, string>;
}

/**
 * Lest tabell per sti, eller `null` når fila mangler.
 *
 * Cachen er per prosess, og under Claude Code er det per hook-event — altså
 * nøyaktig ett oppslag. Den er nøklet på stien: med én felles verdi fikk et
 * oppslag mot en sti som ikke finnes, tabellen en tidligere test hadde lest
 * fra en annen, og det var derfor M-44 aldri falt i `bun test`.
 */
const cache = new Map<string, AliasFil | null>();

/**
 * Hvor `agent-alias.json` ligger (M-44).
 *
 * `CLAUDE_PLUGIN_ROOT` først: motoren setter den for hver hook, og den peker
 * på pluginen som faktisk er lastet. Uten den: repo-roten via `realpathSync`,
 * som i skill-vakten. `join(getPaiHome(), "..")` alene er leksikalsk, og
 * `~/.opencode` er en symlenke inn i repoet: fra `.opencode/` (der `pai
 * --claude` starter) ble stien `~/claude-plugin`, som ikke finnes, og hvert
 * bart agentnavn feilet med «Agent type not found» (MÅLT 2026-09-27).
 */
export function aliasSti(env: NodeJS.ProcessEnv = process.env): string {
	const plugin = env.CLAUDE_PLUGIN_ROOT?.trim();
	if (plugin) return join(plugin, "agent-alias.json");
	const paiHome = getPaiHome();
	try {
		return join(dirname(realpathSync(paiHome)), "claude-plugin", "agent-alias.json");
	} catch {
		return join(paiHome, "..", "claude-plugin", "agent-alias.json");
	}
}

export function lesAliasTabell(sti = aliasSti()): AliasFil | null {
	const kjent = cache.get(sti);
	if (kjent !== undefined) return kjent;
	let tabell: AliasFil | null = null;
	try {
		// Mangler fila, er det ikke en feil på OpenCode-siden: den hører til
		// Claude-pluginen, og oppslaget kalles bare når kapabiliteten er på.
		if (existsSync(sti)) tabell = JSON.parse(readFileSync(sti, "utf-8")) as AliasFil;
	} catch (error) {
		fileLog(`[AgentAlias] Kunne ikke lese ${sti}: ${String(error)}`, "warn");
	}
	cache.set(sti, tabell);
	return tabell;
}

/** Kun for tester. */
export function nullstillAliasCache(): void {
	cache.clear();
}

/**
 * Finn motorens navn på en agent, eller `null` når ingen omskriving trengs.
 *
 * @param ønsket Verdien kallet kom med, f.eks. `"Engineer"`.
 * @returns `"pai:Engineer"`, eller `null` når navnet allerede er riktig,
 *   ukjent, eller tabellen mangler. `null` betyr «la kallet gå urørt» — en
 *   gjetning her ville sendt arbeid til feil agent, og det er verre enn en
 *   feilmelding brukeren kan lese.
 */
export function slåOppAgentAlias(ønsket: string, sti = aliasSti()): string | null {
	if (!ønsket) return null;

	const tabell = lesAliasTabell(sti);
	const aliaser = tabell?.aliaser;
	if (!aliaser) return null;

	// Allerede kvalifisert (`pai:Engineer`). Skriver vi om den, får vi
	// `pai:pai:Engineer` — en av de morsommere måtene å miste en agent på.
	const plugin = tabell.plugin;
	if (plugin && ønsket.startsWith(`${plugin}:`)) return null;

	const treff = aliaser[ønsket] ?? aliaser[ønsket.toLowerCase()];
	if (!treff || treff === ønsket) return null;
	return treff;
}
