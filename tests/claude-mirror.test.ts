/**
 * Kontrakt-test: de genererte plugin-artefaktene
 *
 * En generert fil som har drevet fra kilden sin feiler ikke. Den blir bare
 * gradvis feil, og Claude Code laster den villig vekk — samme stille
 * feilklasse som resten av defektregisteret. Derfor sammenligner disse
 * testene generatorens utdata BYTE FOR BYTE mot det som ligger på disk.
 *
 * Det er også grunnen til at `byggPlan` er ren: en test som må generere
 * for å teste, tester bare seg selv.
 *
 * MÅLINGENE testene hviler på, alle mot Claude Code 2.1.278 2026-09-22 med
 * en kastbar probe-plugin lastet via `--plugin-dir`:
 *
 *   Plugin-agenter eksponeres som `<plugin>:<frontmatter name>`. Fila het
 *   `FileNameAlpha.md` og agenten ble `probe:ProbeAgentBeta` — frontmatter
 *   vinner over filnavnet.
 *
 *   Et BART agentnavn resolver ikke: «Agent type 'ProbeCamelCase' not
 *   found. Available agents: …, probe:ProbeCamelCase, …»
 *
 *   Plugin-skills eksponeres som `<plugin>:<KATALOGNAVN>`. Katalogen het
 *   `probe-dir-name` og frontmatter sa `probe-fm-name`; verktøykallet kom
 *   som `{"skill":"probe:probe-dir-name"}`. Binærens egen tekst: «Skill
 *   names match the skill's directory name».
 *
 *   En skill to nivåer ned (`skills/Kat/Dyp/`) lastes IKKE — den var borte
 *   fra skill-lista. Flatingen er påkrevd, ikke kosmetikk.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byggHooksJson, byggPlan, finnDrift } from "../Tools/BuildClaudePlugin";
import { finnSkills, flattNavn, tilKebab } from "../Tools/lib/skill-walk";
import { HÅNDTERTE_HENDELSER } from "../claude-plugin/src/adapter/routes";
import { capabilitiesFor, dispatch } from "../.opencode/pai-core";
import { tilHookUtdata } from "../claude-plugin/src/adapter/out";
import { nullstillAliasCache, slåOppAgentAlias } from "../.opencode/pai-core/lib/agent-alias";

const ROT = join(import.meta.dir, "..");

/** Formen på `claude-plugin/hooks/hooks.json` — nettopp det testene under asserter. */
interface HooksJson {
	hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; args?: string[] }[] }[]>;
}
const ALIAS_STI = join(ROT, "claude-plugin/agent-alias.json");

// ---------------------------------------------------------------------------
// Friskhet — den testen batchen finnes for
// ---------------------------------------------------------------------------

describe("speilet er ferskt", () => {
	test("hver genererte fil er identisk med det generatoren ville skrevet nå", async () => {
		const plan = await byggPlan(ROT);
		const avvik = await finnDrift(ROT, plan);
		expect(avvik).toEqual([]);
	});

	test("generatoren produserer noe i det hele tatt", async () => {
		// Vaktpost: en `byggPlan` som stille returnerte tomt ville gjort
		// testen over grønn for alltid, uten å teste noe som helst.
		const plan = await byggPlan(ROT);
		expect(plan.filer.length).toBeGreaterThan(50);
		expect(plan.lenker.length).toBeGreaterThan(0);
	});

	test("kroppen er ordrett kildens — kun frontmatter er omskrevet", async () => {
		const skills = await finnSkills(join(ROT, ".opencode/skills"));
		const kropp = (tekst: string) => tekst.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

		for (const skill of skills) {
			const navn = flattNavn(skill.segmenter);
			const speil = join(ROT, "claude-plugin/skills", navn, "SKILL.md");
			expect(kropp(readFileSync(speil, "utf-8"))).toBe(kropp(readFileSync(skill.skillMd, "utf-8")));
		}
	});
});

// ---------------------------------------------------------------------------
// Formen Claude Code faktisk krever
// ---------------------------------------------------------------------------

describe("speilet har formen motoren krever", () => {
	test("ingen skill ligger dypere enn ett nivå", async () => {
		// MÅLT: `skills/Kat/Dyp/SKILL.md` lastes ikke i det hele tatt.
		const plan = await byggPlan(ROT);
		for (const fil of plan.filer.filter((f) => f.sti.startsWith("claude-plugin/skills/"))) {
			const bak = fil.sti.slice("claude-plugin/skills/".length).split("/");
			expect(bak.length).toBe(2);
			expect(bak[1]).toBe("SKILL.md");
		}
	});

	test("hvert skill-navn er kebab og unikt", async () => {
		const plan = await byggPlan(ROT);
		const navn = plan.filer
			.filter((f) => f.sti.startsWith("claude-plugin/skills/"))
			.map((f) => f.sti.split("/")[2]);
		expect(navn.length).toBe(new Set(navn).size);
		for (const n of navn) expect(n).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
	});

	test("`skills/PAI` speiles ikke — den går inn via SessionStart", async () => {
		// Speiles den også, ligger de ~26 KB i konteksten to ganger.
		const plan = await byggPlan(ROT);
		expect(plan.filer.some((f) => f.sti.startsWith("claude-plugin/skills/pai/"))).toBe(false);
	});

	test("kebab bevarer akronymer", () => {
		// `SECUpdates` → `secupdates` er navnet ingen ville gjettet på.
		expect(tilKebab("TrueNAS")).toBe("true-nas");
		expect(tilKebab("SECUpdates")).toBe("sec-updates");
		expect(tilKebab("PAIUpgrade")).toBe("pai-upgrade");
		expect(tilKebab("CreateCLI")).toBe("create-cli");
		expect(tilKebab("OSINT")).toBe("osint");
	});
});

// ---------------------------------------------------------------------------
// hooks.json ← rutetabellen
// ---------------------------------------------------------------------------

describe("hooks.json er avledet av rutetabellen", () => {
	test("nøyaktig de hendelsene adapteren håndterer er registrert", () => {
		// Retningen er poenget: registrerer vi en hendelse motoren fyrer på,
		// men glemmer den i rutetabellen, forkaster hurtigutgangen den —
		// stille. Genereres fila fra settet, kan de to ikke gå fra hverandre.
		const påDisk: HooksJson = JSON.parse(readFileSync(join(ROT, "claude-plugin/hooks/hooks.json"), "utf-8"));
		expect(new Set(Object.keys(påDisk.hooks))).toEqual(new Set(HÅNDTERTE_HENDELSER));
	});

	test("bare nøkler Claude Code kjenner, på toppnivå", () => {
		// `_kommentar` ga «hooks.json: unknown key … ignored» i hver økt (2.1.283).
		const påDisk = JSON.parse(readFileSync(join(ROT, "claude-plugin/hooks/hooks.json"), "utf-8"));
		expect(Object.keys(påDisk).sort()).toEqual(["description", "hooks"]);
		expect(typeof påDisk.description).toBe("string");
	});

	test("en hendelse uten bevisst timeout feiler generatoren", () => {
		// En default ville gitt en ny hendelse et tilfeldig tidsbudsjett.
		expect(() => byggHooksJson(["SessionStart", "HeltNyHendelse"])).toThrow(/timeout/i);
	});

	test("hver oppføring peker på bin/pai-hook og ingenting annet", () => {
		// Kontrakten som gjør `bun build --compile` i batch 12 gratis: en
		// kompilert binær på samme sti krever ingen reinstall.
		const påDisk: HooksJson = JSON.parse(readFileSync(join(ROT, "claude-plugin/hooks/hooks.json"), "utf-8"));
		for (const oppføringer of Object.values(påDisk.hooks)) {
			for (const o of oppføringer) {
				for (const h of o.hooks) {
					// biome-ignore lint/suspicious/noTemplateCurlyInString: ${CLAUDE_PLUGIN_ROOT} er en literal motoren substituerer
					expect(h.command).toBe("${CLAUDE_PLUGIN_ROOT}/bin/pai-hook");
					expect(h.type).toBe("command");
					// Exec-form (M-42): uten `args` er det en skallkommando, og en
					// plugin-sti med mellomrom ga null hooks, målt.
					expect(h.args).toEqual([]);
				}
			}
		}
	});

	test("ingen matchers — filtreringen bor i routes.ts", () => {
		const påDisk: HooksJson = JSON.parse(readFileSync(join(ROT, "claude-plugin/hooks/hooks.json"), "utf-8"));
		for (const oppføringer of Object.values(påDisk.hooks)) {
			for (const o of oppføringer) expect(o.matcher).toBeUndefined();
		}
	});
});

// ---------------------------------------------------------------------------
// Agentene, og at de i det hele tatt kan adresseres
// ---------------------------------------------------------------------------

describe("agentene er adresserbare", () => {
	test("hver genererte agent har et alias til sitt kvalifiserte navn", async () => {
		// Uten dette er hele katalogen uadresserbar: et bart navn resolver
		// ikke, og promptmaterialet bruker bare bare navn.
		const plan = await byggPlan(ROT);
		const alias = JSON.parse(readFileSync(ALIAS_STI, "utf-8"));

		const agenter = plan.filer
			.filter((f) => f.sti.startsWith("claude-plugin/agents/"))
			.map((f) => f.innhold.match(/^name:\s*(.+)$/m)?.[1].trim());

		expect(agenter.length).toBeGreaterThan(0);
		for (const navn of agenter) {
			expect(alias.aliaser[navn as string]).toBe(`${alias.plugin}:${navn}`);
		}
	});

	test("et allerede kvalifisert navn skrives ikke om igjen", () => {
		// `pai:pai:Engineer` er en av de morsommere måtene å miste en agent på.
		nullstillAliasCache();
		expect(slåOppAgentAlias("pai:Engineer", ALIAS_STI)).toBeNull();
	});

	test("et ukjent navn røres ikke", () => {
		// `Explore` er Claude Codes egen. Kapret vi den, ville PAI stjålet
		// motorens innebygde agenter.
		nullstillAliasCache();
		expect(slåOppAgentAlias("Explore", ALIAS_STI)).toBeNull();
		expect(slåOppAgentAlias("", ALIAS_STI)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Kjeden, per hendelse — ikke bare oversatt, men FAKTISK koblet
// ---------------------------------------------------------------------------

describe("alias-kjeden er koblet ende-til-ende", () => {
	// Motoren setter CLAUDE_PLUGIN_ROOT for hver hook, og det er der tabellen
	// leses fra (M-44). Før M-44 gikk disse testene grønt bare fordi en
	// tidligere test hadde fylt den felles cachen fra en eksplisitt sti.
	let rotFør: string | undefined;
	beforeAll(() => {
		rotFør = process.env.CLAUDE_PLUGIN_ROOT;
		process.env.CLAUDE_PLUGIN_ROOT = join(ROT, "claude-plugin");
		nullstillAliasCache();
	});
	afterAll(() => {
		if (rotFør === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
		else process.env.CLAUDE_PLUGIN_ROOT = rotFør;
		nullstillAliasCache();
	});

	const basis = {
		sessionId: "mirror-test",
		sessionKey: "claude-mirror-test",
		at: Date.now(),
		cwd: "/tmp",
	} as const;

	test("kjernen returnerer updatedArgs for et bart agentnavn under Claude", async () => {
		const r = await dispatch({
			type: "tool.before",
			harness: "claude",
			tool: "Agent",
			args: { subagent_type: "Engineer", prompt: "x" },
			...basis,
		});
		expect(r.updatedArgs?.subagent_type).toBe("pai:Engineer");
		// Argumentene ellers skal følge med — `updatedInput` ERSTATTER hele
		// objektet hos motoren, så et felt vi glemmer er et felt som forsvinner.
		expect(r.updatedArgs?.prompt).toBe("x");
	});

	test("adapteren sender det ut som hookSpecificOutput.updatedInput", async () => {
		const r = await dispatch({
			type: "tool.before",
			harness: "claude",
			tool: "Agent",
			args: { subagent_type: "Engineer", prompt: "x" },
			...basis,
		});
		const ut = JSON.parse(tilHookUtdata("PreToolUse", r));
		expect(ut.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(ut.hookSpecificOutput.updatedInput.subagent_type).toBe("pai:Engineer");
		// ALDRI sammen med en tillatelse: PAI retter argumenter, det avgjør
		// ikke om kallet får lov.
		expect(ut.hookSpecificOutput.permissionDecision).toBeUndefined();
	});

	test("OPENCODE skriver IKKE om — der heter agentene det de alltid har hett", async () => {
		// Den farligste greina i hele batchen. `agent-alias.json` ligger i
		// repoet OpenCode kjører fra, så «finnes fila?» er sant i BEGGE
		// motorene. Gatet på fil framfor kapabilitet ville OpenCode skrevet
		// om `Engineer` til `pai:Engineer` og brutt hver subagent-spawn.
		expect(capabilitiesFor("opencode").agentAliases).toBe(false);
		const r = await dispatch({
			type: "tool.before",
			harness: "opencode",
			tool: "task",
			args: { subagent_type: "Engineer", prompt: "x" },
			...basis,
		});
		expect(r.updatedArgs).toBeUndefined();
	});

	test("et verktøy som ikke spawner subagenter røres ikke", async () => {
		const r = await dispatch({
			type: "tool.before",
			harness: "claude",
			tool: "Read",
			args: { subagent_type: "Engineer" },
			...basis,
		});
		expect(r.updatedArgs).toBeUndefined();
	});
});
