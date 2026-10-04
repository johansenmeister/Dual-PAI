/**
 * Kontrakt-test: skill-vakten leser skillnavnet motorene faktisk sender (M-40)
 *
 * Vakten leste `args.name` fra den kom inn, og ingen av motorene sender det
 * feltet. Hvert skill-kall ga `Skill not found: unknown`, i begge motorene,
 * uten at noe falt. Payload-formene under er MÅLT 2026-09-26 (jobb-fase 3),
 * ikke skrevet etter hukommelsen:
 *
 *   Claude: `Skill {"skill": "pai:infrastructure-pihole"}`, det flate
 *           speilnavnet med pluginprefiks, som bare `skill-map.json` kjenner.
 *   v2:     `skill {"id": "Pihole"}`, katalognavnet i kildetreet.
 *
 * Treet er et lite, falskt repo under en temp-`PAI_HOME`: `.opencode/skills/`
 * og `claude-plugin/skill-map.json` ved siden av, som i repoet.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, sessionKeyFor } from "../.opencode/pai-core";
import { skillnavnFraArgs, validateSkillInvocation } from "../.opencode/pai-core/handlers/skill-guard";

let rot: string;
let opprinneligHome: string | undefined;

beforeAll(() => {
	rot = mkdtempSync(join(tmpdir(), "pai-skill-guard-"));
	const skill = join(rot, ".opencode", "skills", "Infrastructure", "Pihole");
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), "---\nname: Pihole\ndescription: Pi-hole. USE WHEN pihole\n---\n# Pihole\n");
	mkdirSync(join(rot, "claude-plugin"));
	writeFileSync(
		join(rot, "claude-plugin", "skill-map.json"),
		JSON.stringify({
			plugin: "pai",
			skills: {
				"infrastructure-pihole": {
					kilde: ".opencode/skills/Infrastructure/Pihole",
					segmenter: ["Infrastructure", "Pihole"],
					navn: "Pihole",
				},
			},
			aliaser: { pihole: "infrastructure-pihole" },
		})
	);
	opprinneligHome = process.env.PAI_HOME;
	process.env.PAI_HOME = join(rot, ".opencode");
});

afterAll(() => {
	if (opprinneligHome === undefined) delete process.env.PAI_HOME;
	else process.env.PAI_HOME = opprinneligHome;
	rmSync(rot, { recursive: true, force: true });
});

describe("skillnavnFraArgs — feltet hver motor sender", () => {
	test("Claude: `skill`", () => {
		expect(skillnavnFraArgs({ skill: "pai:infrastructure-pihole" })).toBe("pai:infrastructure-pihole");
	});

	test("v2: `id`", () => {
		expect(skillnavnFraArgs({ id: "Pihole" })).toBe("Pihole");
	});

	test("`name` leses fortsatt, men sist", () => {
		expect(skillnavnFraArgs({ name: "Pihole" })).toBe("Pihole");
		expect(skillnavnFraArgs({ skill: "pai:x", name: "y" })).toBe("pai:x");
	});

	test("ingen av feltene, eller tomme: tom streng", () => {
		expect(skillnavnFraArgs({})).toBe("");
		expect(skillnavnFraArgs({ skill: "  ", id: 3 })).toBe("");
	});
});

describe("validateSkillInvocation — navnet slik motoren sendte det", () => {
	test("v2s kildenavn finnes i kategorien", async () => {
		expect((await validateSkillInvocation("Pihole", "")).valid).toBe(true);
	});

	test("Claudes speilnavn med prefiks løses via skill-map.json", async () => {
		expect((await validateSkillInvocation("pai:infrastructure-pihole", "")).valid).toBe(true);
	});

	test("speilnavnet uten prefiks løses også", async () => {
		expect((await validateSkillInvocation("infrastructure-pihole", "")).valid).toBe(true);
	});

	test("et alias fra kartet løses, også når katalogsøket bommer på store/små bokstaver", async () => {
		expect((await validateSkillInvocation("pai:pihole", "")).valid).toBe(true);
	});

	test("en skill som ikke finnes, meldes fortsatt, med og uten prefiks", async () => {
		// Vakten skal ikke bli taus av rettingen: den andre retningen.
		expect((await validateSkillInvocation("finnes-ikke", "")).valid).toBe(false);
		expect((await validateSkillInvocation("pai:finnes-ikke", "")).valid).toBe(false);
	});
});

describe("dispatch tool.before — ekte payloads gir ingen skill-advarsel", () => {
	const base = { sessionId: "ses_skill", at: 1_700_000_000_000, cwd: "/tmp" };

	test("Claude: Skill {skill: pai:infrastructure-pihole}", async () => {
		const r = await dispatch({
			...base,
			harness: "claude",
			sessionKey: sessionKeyFor("claude", "ses_skill"),
			type: "tool.before",
			tool: "Skill",
			args: { skill: "pai:infrastructure-pihole" },
		});
		expect(r.notes ?? []).not.toContain("skill-guard-warning");
	});

	test("v2: skill {id: Pihole}", async () => {
		const r = await dispatch({
			...base,
			harness: "opencode2",
			sessionKey: sessionKeyFor("opencode2", "ses_skill"),
			type: "tool.before",
			tool: "skill",
			args: { id: "Pihole" },
		});
		expect(r.notes ?? []).not.toContain("skill-guard-warning");
	});

	test("en ukjent skill gir advarselen, så testen over ikke består av en taus vakt", async () => {
		const r = await dispatch({
			...base,
			harness: "opencode2",
			sessionKey: sessionKeyFor("opencode2", "ses_skill"),
			type: "tool.before",
			tool: "skill",
			args: { id: "FinnesIkke" },
		});
		expect(r.notes ?? []).toContain("skill-guard-warning");
	});
});
