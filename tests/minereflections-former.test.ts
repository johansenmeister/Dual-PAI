/**
 * Kontrakt-test: MineReflections leser jobbens refleksjonsformer (#315)
 *
 * Feltnavnene ble matchet eksakt. På jobb hadde 16 av 23 linjer andre
 * stavemåter (`Q1_self`, `q_self`) eller ingen Q-akser (`observation`,
 * `learning`, `action`), og alle 16 ble lest tomme og forkastet som
 * «contentless» før analysen. Radene under er jobbens former, forkortet.
 */

import { describe, expect, test } from "bun:test";
import { detectSchema, normalizeEntry } from "../.opencode/PAI/Tools/MineReflections";

describe("jobbens former når analysen med tekst", () => {
	test("Q1_self/Q2_algorithm/Q3_ai med stor forbokstav", () => {
		const rad = { timestamp: "2026-09-02T04:05:00Z", task: "n8n", Q1_self: "a", Q2_algorithm: "b", Q3_ai: "c" };
		expect(detectSchema(rad)).toBe("short-form");
		const e = normalizeEntry(rad, 1);
		expect([e.q1, e.q2, e.q3]).toEqual(["a", "b", "c"]);
		expect(e.task).toBe("n8n");
	});

	test("q_self/q_algorithm/q_ai", () => {
		const rad = { timestamp: "2026-08-18T20:00:00+02:00", session: "s", q_self: "a", q_algorithm: "b", q_ai: "c" };
		expect(detectSchema(rad)).toBe("short-form");
		const e = normalizeEntry(rad, 1);
		expect([e.q1, e.q2, e.q3]).toEqual(["a", "b", "c"]);
	});

	test("observation, learning og action, med topic som oppgave", () => {
		const rad = { date: "2026-09-08", topic: "Graph", observation: "skjedde", learning: "lærdom", action: "neste gang" };
		expect(detectSchema(rad)).toBe("freeform");
		const e = normalizeEntry(rad, 1);
		expect(e.q1).toBe("skjedde");
		expect(e.q2).toBe("Lesson: lærdom Action: neste gang");
		expect(e.q3).toBe("");
		expect(e.task).toBe("Graph");
		expect(e.timestamp).toBe("2026-09-08");
	});

	test("insight i stedet for observation", () => {
		const rad = { date: "2026-08-12", topic: "Pureservice", insight: "innsikt", action: "gjør", outcome: "success" };
		expect(detectSchema(rad)).toBe("freeform");
		const e = normalizeEntry(rad, 1);
		expect(e.q1).toBe("innsikt");
		expect(e.q2).toBe("Action: gjør");
	});

	test("de kjente formene er urørt", () => {
		expect(detectSchema({ reflection_q1: "a" })).toBe("canonical");
		expect(detectSchema({ q1_self: "a" })).toBe("short-form");
		expect(detectSchema({ incident: "x", lesson: "y" })).toBe("incident");
		expect(detectSchema({ ukjent: "x" })).toBe("unrecognized");
		// En kortform som også har `insight` (jobben har dem), leses som kortform.
		const e = normalizeEntry({ q1_self: "a", q2_algorithm: "b", q3_ai: "c", insight: "i" }, 1);
		expect([e.q1, e.q2, e.q3]).toEqual(["a", "b", "c"]);
	});
});
