#!/usr/bin/env bun
/**
 * PAI MCP-server — PAIs egne verktøy for Claude Code
 *
 * OpenCode-siden eksponerer de samme verktøyene via `tool()` i
 * `pai-adapters/opencode/tools.ts`. Logikken de kaller står i kjernen og er
 * harness-nøytral; dette er oversettelsen, akkurat som `src/adapter/`.
 *
 * INVARIANTENE er hook-dispatcherens, av samme grunn:
 *
 *   **stdout er protokollen.** Hver linje er nøyaktig ett JSON-RPC-dokument.
 *   En stray `console.log` ødelegger rammen, og motoren rapporterer det som
 *   en generisk serverfeil uten å si hvilken byte som var for mye. Derfor
 *   shimmes `console.*` til fileLog før noe annet importeres.
 *
 *   **Ingenting kaster ut.** En verktøyfeil blir en tekstlig feilmelding til
 *   modellen, ikke en død server — dør serveren, forsvinner ALLE verktøyene
 *   for resten av økten.
 *
 * MÅLT 2026-09-22 mot Claude Code 2.1.278:
 *   Verktøynavnene blir `mcp__plugin_pai_pai__<navn>` — motoren bygger dem
 *   som `mcp__plugin_<plugin>_<server>__<verktøy>`. Planens `mcp__pai__<navn>`
 *   finnes ikke.
 *   Serveren er et DIREKTE barn av motoren, og langlivet: én prosess per
 *   økt, med `initialize` → `notifications/initialized` → `tools/list` →
 *   `tools/call`.
 *
 * @module claude-plugin/mcp/pai-mcp
 */

import "../src/bootstrap";
import { fileLog, fileLogError } from "../../.opencode/pai-core/lib/file-logger";
import { finnSesjon } from "../src/session";

/** Protokollversjonen probet mot 2.1.278. Motoren godtok den uten innsigelse. */
const PROTOKOLL = "2024-11-05";

interface RpcMelding {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Verktøyene
// ---------------------------------------------------------------------------

/**
 * `session_id` er valgfritt på ALLE verktøy — lag 2 i `src/session.ts`.
 *
 * Beskrivelsen sier at det normalt kan utelates. Uten den setningen ville
 * modellen bedt om en ID den ikke har, og fått den fra ingen steder.
 */
const SESSION_ID_ARG = {
	session_id: {
		type: "string",
		description:
			"Valgfritt. Utelates normalt — serveren finner økten selv. Oppgi kun hvis du vet at du spør om en ANNEN økt enn den du står i.",
	},
} as const;

interface Verktøy {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	kjør(args: Record<string, unknown>): Promise<string>;
}

const VERKTØY: Verktøy[] = [
	{
		name: "session_registry",
		description:
			"List alle subagent-økter spawnet i denne økten: agenttype, ID, beskrivelse og status. " +
			"Bruk den etter kompaktering for å hente tilbake hva som ble delegert — registeret overlever kompaktering.",
		inputSchema: { type: "object", properties: { ...SESSION_ID_ARG } },
		async kjør(args) {
			const { sessionId, kilde } = finnSesjon(args.session_id as string | undefined);
			if (!sessionId) return UKJENT_ØKT;
			fileLog(`[MCP] session_registry for ${sessionId} (kilde: ${kilde})`, "debug");

			const { readRegistry } = await import("../../.opencode/pai-core/handlers/session-registry");
			const registry = readRegistry(sessionId);
			if (registry.entries.length === 0) {
				return "Ingen subagent-økter registrert for denne økten ennå.";
			}

			const linjer = [
				`## Subagent-register (${registry.entries.length} økter)`,
				"",
				"| # | Agent | Sesjons-ID | Beskrivelse | Status | Spawnet |",
				"|---|-------|-----------|-------------|--------|---------|",
			];
			registry.entries.forEach((e, i) => {
				linjer.push(
					`| ${i + 1} | ${e.agentType} | ${e.sessionId} | ${kortet(e.description, 60)} | ${e.status} | ${e.spawnedAt} |`
				);
			});
			linjer.push("", "Bruk `session_results` med en sesjons-ID for å hente subagentens faktiske svar.");
			return linjer.join("\n");
		},
	},
	{
		name: "session_results",
		description:
			"Hent hva en subagent faktisk svarte, gitt sesjons-ID fra session_registry. " +
			"Returnerer det fangede svaret i sin helhet, ikke bare metadata.",
		inputSchema: {
			type: "object",
			properties: {
				subagent_session_id: {
					type: "string",
					description: "Subagentens sesjons-ID, hentet fra session_registry.",
				},
				...SESSION_ID_ARG,
			},
			required: ["subagent_session_id"],
		},
		async kjør(args) {
			const ønsket = String(args.subagent_session_id ?? "").trim();
			if (!ønsket) return "Mangler `subagent_session_id`. Kjør `session_registry` først.";

			const { sessionId } = finnSesjon(args.session_id as string | undefined);
			if (!sessionId) return UKJENT_ØKT;

			const { readRegistry } = await import("../../.opencode/pai-core/handlers/session-registry");
			const registry = readRegistry(sessionId);
			const entry = registry.entries.find((e) => e.sessionId === ønsket);
			if (!entry) {
				return `Fant ikke ${ønsket} i registeret for denne økten. Kjør \`session_registry\` for å se hvilke som finnes.`;
			}

			const hode = [
				`## Subagent: ${entry.agentType}`,
				"",
				`**Beskrivelse:** ${entry.description}`,
				`**Spawnet:** ${entry.spawnedAt}`,
				`**Status:** ${entry.status}`,
				"",
			];

			// HER SKILLER CLAUDE-SIDEN SEG FRA OPENCODE, og den er bedre:
			// OpenCode-verktøyet endte i `Task({session_id, prompt})` for å
			// gjenoppta subagenten, og det finnes ikke i Claude Code. Men
			// `agent-capture` har allerede skrevet `last_assistant_message`
			// fra `SubagentStop` til MEMORY/RESEARCH/, og registeret bærer
			// filstien. Vi returnerer altså det EKTE svaret framfor en
			// instruksjon om hvordan man kunne fått tak i det.
			// Valgfritt i typen: eldre oppføringer, skrevet før batch 9, har den ikke.
			const sti = entry.outputPath;
			if (!sti) {
				return [
					...hode,
					entry.status === "running"
						? "Subagenten kjører fortsatt — svaret fanges når den er ferdig."
						: "Ingen fanget output for denne subagenten.",
				].join("\n");
			}

			try {
				const { readFileSync } = await import("node:fs");
				return [...hode, "---", "", readFileSync(sti, "utf-8")].join("\n");
			} catch (error) {
				fileLogError("[MCP] Kunne ikke lese fanget output", error);
				return [...hode, `Fanget output skulle ligget i \`${sti}\`, men fila kunne ikke leses.`].join("\n");
			}
		},
	},
];

const UKJENT_ØKT =
	"Fant ikke ut hvilken økt dette er. Det skjer hvis PAI-hookene ikke kjørte ved sesjonsstart " +
	"(er `PAI_ENABLED=1` satt?). Oppgi `session_id` eksplisitt hvis du kjenner den.";

function kortet(tekst: string, maks: number): string {
	const rent = String(tekst ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
	return rent.length > maks ? `${rent.slice(0, maks - 1)}…` : rent;
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

/** Nøyaktig ett sted som rører stdout — samme regel som bin/pai-hook.ts. */
function send(dokument: unknown): void {
	process.stdout.write(`${JSON.stringify(dokument)}\n`);
}

function svar(id: number | string, result: unknown): void {
	send({ jsonrpc: "2.0", id, result });
}

async function håndter(melding: RpcMelding): Promise<void> {
	const { id, method } = melding;

	switch (method) {
		case "initialize":
			svar(id as number, {
				protocolVersion: PROTOKOLL,
				capabilities: { tools: {} },
				serverInfo: { name: "pai", version: "3.0.1" },
			});
			return;

		case "notifications/initialized":
			// Notifikasjon: ingen `id`, og et svar ville vært protokollfeil.
			return;

		case "tools/list":
			svar(id as number, {
				tools: VERKTØY.map((v) => ({
					name: v.name,
					description: v.description,
					inputSchema: v.inputSchema,
				})),
			});
			return;

		case "tools/call": {
			const navn = (melding.params?.name as string) ?? "";
			const args = (melding.params?.arguments as Record<string, unknown>) ?? {};
			const verktøy = VERKTØY.find((v) => v.name === navn);
			if (!verktøy) {
				svar(id as number, {
					content: [{ type: "text", text: `Ukjent verktøy: ${navn}` }],
					isError: true,
				});
				return;
			}
			try {
				const tekst = await verktøy.kjør(args);
				svar(id as number, { content: [{ type: "text", text: tekst }] });
			} catch (error) {
				// En verktøyfeil er et SVAR, ikke en død server. Dør serveren,
				// mister økten alle verktøyene for godt.
				fileLogError(`[MCP] ${navn} feilet`, error);
				svar(id as number, {
					content: [{ type: "text", text: `Verktøyet feilet: ${String(error)}` }],
					isError: true,
				});
			}
			return;
		}

		default:
			// Ukjent metode MED id krever svar; uten id er den en notifikasjon
			// vi skal tie om.
			if (id !== undefined) {
				send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Ukjent metode: ${method}` } });
			}
	}
}

// Linjedelt rammeverk. Meldingene kan komme delt over flere chunks, og en
// halv linje som parses er en server som svarer feil på noe den ikke leste.
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString();
	let brudd: number = buffer.indexOf("\n");
	while (brudd !== -1) {
		const linje = buffer.slice(0, brudd);
		buffer = buffer.slice(brudd + 1);
		brudd = buffer.indexOf("\n");
		if (linje.trim() === "") continue;
		let melding: RpcMelding;
		try {
			melding = JSON.parse(linje);
		} catch {
			fileLog("[MCP] Ugyldig JSON på stdin — hoppet over", "warn");
			continue;
		}
		håndter(melding).catch((error) => fileLogError("[MCP] Uventet feil", error));
	}
});

process.stdin.on("end", () => process.exit(0));

fileLog(`[MCP] Server startet (pid ${process.pid})`, "info");
