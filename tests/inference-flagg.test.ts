/**
 * Kontrakt-test: `Inference.ts` lagrer ikke økten (#150)
 *
 * Sentimentjobben (`implicit-sentiment.ts` → `inference()`) kjørte `claude -p`
 * etter at ClaudeSmoke hadde ryddet, og la igjen en katalog under
 * `~/.claude/projects/-tmp-pai-claudesmoke-*` ved hver kjøring (seks stykker
 * 2.–5. oktober). `--no-session-persistence` (Claude Code 2.1.283) gjør at et
 * engangskall ikke skriver transkript i det hele tatt (MÅLT 2026-10-05: uten
 * flagget en katalog, med flagget ingen). `tests/preload.ts` mocker hele
 * modulen, så kildeteksten er det testen kan lese.
 *
 * @module tests/inference-flagg
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const KILDE = readFileSync(join(import.meta.dir, "..", ".opencode", "PAI", "Tools", "Inference.ts"), "utf8");

test("argumentene til claude har --no-session-persistence", () => {
	const args = KILDE.match(/const args = \[([\s\S]*?)\];/)?.[1] ?? "";
	expect(args).toContain("'--print'");
	expect(args).toContain("'--no-session-persistence'");
});
