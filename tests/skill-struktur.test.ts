/**
 * Contract test: `ValidateSkillStructure.ts` passes in `bun test` (#142)
 *
 * The validator checks that every skill has a SKILL.md with `name` and
 * `description`, that categories have their own SKILL.md, and that no name is
 * used twice. It was fixed in #74, and nothing has run it since. Errors fail
 * the test; warnings (such as a description without "USE WHEN") do not.
 *
 * Runs in all three trees: home, the job's tree and public pass today.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const VALIDATOR = join(import.meta.dir, "..", ".opencode", "PAI", "Tools", "ValidateSkillStructure.ts");

describe.skipIf(!existsSync(VALIDATOR))("the skill structure (#142)", () => {
	test("ValidateSkillStructure.ts finds no errors", () => {
		const r = Bun.spawnSync(["bun", VALIDATOR], { stdout: "pipe", stderr: "pipe" });
		const ut = r.stdout.toString() + r.stderr.toString();
		// Red: the lines after «❌ Errors:» name the skill and what is missing.
		expect(ut).toContain("Errors: 0");
		expect(r.exitCode).toBe(0);
	});
});
