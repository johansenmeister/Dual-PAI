/**
 * Kontrakt-test: gratismodellen kjøreplanen starter med (#162)
 *
 * Det som må holde, og som ville feilet stille: en modell som bruker
 * brukerens data velges aldri uten `--allow-other`, hver agent får modellen
 * (ellers kjører en subagent mot en leverandør uten nøkkel), og en `error` i
 * strømmen teller ikke som svar, selv om exitkoden er 0.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { kandidater, medModell, NULLLAGRING, svarte } from "../PAI-Install/cli/zen-start";

describe("kandidater", () => {
	const levende = ["nemotron-3-ultra-free", "space-bunny-free", "big-pickle", "longcat-2.5-preview-free", "gpt-5.5"];

	test("uten --allow-other: bare nulllagring, i fast rekkefølge", () => {
		expect(kandidater(levende, false)).toEqual(["longcat-2.5-preview-free", "space-bunny-free"]);
	});

	test("en nulllagringsmodell som er borte fra lista, prøves ikke", () => {
		expect(kandidater(["space-bunny-free", "nemotron-3-ultra-free"], false)).toEqual(["space-bunny-free"]);
	});

	test("med --allow-other: nulllagring først, så de andre gratismodellene, aldri betalte", () => {
		expect(kandidater(levende, true)).toEqual(["longcat-2.5-preview-free", "space-bunny-free", "nemotron-3-ultra-free"]);
	});

	test("tom liste (nettet hikket): nulllagringsmodellene prøves likevel", () => {
		expect(kandidater([], false)).toEqual([...NULLLAGRING]);
	});
});

describe("medModell", () => {
	const konfig = {
		$schema: "https://opencode.ai/config.json",
		model: "fireworks-ai/x",
		permission: { "*": "allow" },
		agent: { Algorithm: { model: "fireworks-ai/y" }, Intern: { model: "fireworks-ai/z", mode: "all" } },
	};
	const ut = medModell(konfig, "longcat-2.5-preview-free") as typeof konfig;

	test("standardmodellen og hver agent får opencode/<id>", () => {
		expect(ut.model).toBe("opencode/longcat-2.5-preview-free");
		expect(ut.agent.Algorithm.model).toBe("opencode/longcat-2.5-preview-free");
		expect(ut.agent.Intern.model).toBe("opencode/longcat-2.5-preview-free");
	});

	test("resten av konfigen står", () => {
		expect(ut.permission).toEqual({ "*": "allow" });
		expect(ut.agent.Intern.mode).toBe("all");
		expect(konfig.model).toBe("fireworks-ai/x");
	});
});

describe("svarte", () => {
	const tekst = JSON.stringify({ type: "text", part: { text: "ok" } });
	const feil = JSON.stringify({ type: "error", error: { type: "provider.no-route" } });

	test("en tekstdel er et svar", () => {
		expect(svarte(`{"type":"step_start"}\n${tekst}\n`)).toBe(true);
	});

	test("en error-hendelse er ikke et svar, selv med tekst før", () => {
		expect(svarte(`${tekst}\n${feil}\n`)).toBe(false);
	});

	test("tom eller ødelagt utdata er ikke et svar", () => {
		expect(svarte("")).toBe(false);
		expect(svarte("cli starting\n{ikke json")).toBe(false);
		expect(svarte(JSON.stringify({ type: "text", part: { text: "  " } }))).toBe(false);
	});
});

// #197: profilen `zen` ga agentene gratismodeller som bruker dataene.
describe("zen.yaml følger NULLLAGRING", () => {
	const profil = parse(readFileSync(join(import.meta.dir, "..", ".opencode", "profiles", "zen.yaml"), "utf-8")) as {
		default_model: string;
		agents: Record<string, { model: string }>;
	};
	const modeller = [profil.default_model, ...Object.values(profil.agents).map((a) => a.model)];

	test("hver modell i profilen er en nulllagringsmodell", () => {
		expect(modeller.length).toBeGreaterThan(10);
		for (const m of modeller) expect(NULLLAGRING).toContain(m.replace(/^opencode\//, ""));
	});
});
