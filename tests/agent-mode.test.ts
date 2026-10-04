/**
 * Kontrakt-test: hver PAI-agent kan kjøre som subagent under OpenCode v2
 *
 * MÅLT 2026-09-26 mot 2.0.16: uten `mode` i frontmatter kommer agentene inn
 * som `primary` under v2, og `subagent {agent: "Engineer"}` gir
 * `Tool.Error: "Agent Engineer cannot run as a subagent"`. Modellen får
 * dessuten bare `explore` og `general` oppgitt som tilgjengelige, så den
 * vet ikke engang at agentene finnes. Ingenting feiler ved oppstart — det er
 * M-17-klassen igjen, en delegering som stille ikke skjer.
 *
 * `mode: all` er v1s default (MÅLT: `opencode agent list` på 1.18.32 gir
 * `all` for alle sytten uten feltet), så feltet endrer ingenting der. Claude-
 * generatoren bygger frontmatteren fra eksplisitte felt og tar det ikke med.
 *
 * Frontmatter, ikke `agent`-blokka i `opencode.json`: blokka mangler
 * `BrowserAgent` og `UIReviewer`, og en ny agent får en `.md` før den får en
 * oppføring der.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const AGENTER = join(import.meta.dir, "..", ".opencode", "agents");

/** Modusene som lar agenten kjøre som subagent. */
const SUBAGENT_MODUS = new Set(["all", "subagent"]);

function frontmatterModus(tekst: string): string | undefined {
	const fm = tekst.match(/^---\n([\s\S]*?)\n---/);
	if (!fm) return undefined;
	return fm[1].match(/^mode:\s*(\S+)\s*$/m)?.[1];
}

describe("PAI-agentenes modus", () => {
	const filer = readdirSync(AGENTER).filter((f) => f.endsWith(".md"));

	test("katalogen har agenter (ellers beviser testen ingenting)", () => {
		expect(filer.length).toBeGreaterThanOrEqual(17);
	});

	test.each(filer)("%s kan spawnes som subagent", (fil) => {
		const modus = frontmatterModus(readFileSync(join(AGENTER, fil), "utf-8"));
		expect(modus && SUBAGENT_MODUS.has(modus)).toBe(true);
	});

	test("leseren skiller primary fra all", () => {
		expect(frontmatterModus("---\nname: X\nmode: primary\n---\n")).toBe("primary");
		expect(frontmatterModus("---\nname: X\n---\nmode: all\n")).toBeUndefined();
	});
});
