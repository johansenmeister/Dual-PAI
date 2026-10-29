/**
 * Contract test: every skill under `Infrastructure/` has a row in the overview (#471)
 *
 * `Infrastructure/SKILL.md` is the model's map of the category. Nothing checked
 * that it was complete: Komodo had no row from #380 until a job PR added it,
 * and the job's overview is the job's own, so a shared skill that reaches the
 * job through the delivery never gets one by itself.
 *
 * Runs in all three trees. At home the overview has every skill; the job's
 * file is its own; in public, `bygg.sh` removes the home skills and their rows
 * together. A directory without a row, or a row without a directory, is red.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const KATEGORI = join(import.meta.dir, "..", ".opencode", "skills", "Infrastructure");
const OVERSIKT = join(KATEGORI, "SKILL.md");

/** The names in the overview's rows: `| **Name** | … |`. */
function rader(tekst: string): string[] {
	return [...tekst.matchAll(/^\| \*\*([^*]+)\*\* \|/gm)].map((m) => m[1] as string);
}

describe.skipIf(!existsSync(OVERSIKT))("Infrastructure/SKILL.md (#471)", () => {
	const kataloger = readdirSync(KATEGORI, { withFileTypes: true })
		.filter((o) => o.isDirectory() && !o.name.startsWith("."))
		.map((o) => o.name)
		.sort();
	const navn = rader(readFileSync(OVERSIKT, "utf-8")).sort();

	test("the overview has rows", () => {
		expect(navn.length).toBeGreaterThan(0);
	});

	test("every skill directory has a row", () => {
		expect(kataloger.filter((k) => !navn.includes(k))).toEqual([]);
	});

	test("every row has a skill directory", () => {
		expect(navn.filter((n) => !kataloger.includes(n))).toEqual([]);
	});

	test("rader() reads the table form, and not a bold word in the text", () => {
		const tekst = "| Skill | Purpose |\n|---|---|\n| **A** | x |\n| **B C** | y |\nSome **bold** text\n";
		expect(rader(tekst)).toEqual(["A", "B C"]);
	});
});
