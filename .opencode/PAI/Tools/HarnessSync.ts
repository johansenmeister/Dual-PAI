#!/usr/bin/env bun
/**
 * HarnessSync — den deterministiske delen av HarnessUpdate-skillen (C5)
 *
 * Begge motorene er pinnet eksakt i `.opencode/package.json`: `@opencode/cli`
 * som avhengighet (B3) og `pai.claudeCode` (C1). Dette verktøyet finner ut om
 * det finnes nyere versjoner, henter endringene siden den pinnede, og flagger
 * hver linje som rører en rad i antakelsesregisteret
 * (`skills/Utilities/HarnessUpdate/AssumptionRegister.md`). Det oppgraderer
 * aldri: en bump er en gren, røyktesten og en PR (planen, fase 2).
 *
 *   bun .opencode/PAI/Tools/HarnessSync.ts check [--json] [--claude-fra X.Y.Z] [--v2-fra X.Y.Z]
 *
 * `--claude-fra`/`--v2-fra` erstatter den pinnede versjonen som startpunkt: hva
 * har endret seg siden en bestemt versjon.
 *
 * Kildene (MÅLT 2026-09-27):
 *   - versjonene: npm-registeret, `dist-tags` for `@anthropic-ai/claude-code`
 *     (`latest`, `stable`) og `@opencode/cli` (`latest`)
 *   - Claude Code: `CHANGELOG.md` i `anthropics/claude-code`, én `## X.Y.Z` per
 *     versjon med én linje per endring
 *   - OpenCode v2: ingen release-notater for 2.0.x (GitHub har taggene, men
 *     releasene er v1s). Compare-API-et mellom taggene gir commit-emnene og
 *     stiene som er endret
 *
 * Exit: 0 = begge står på siste · 1 = nyere versjon, og noe rører registeret ·
 * 2 = nyere versjon, ingenting flagget · 3 = en kilde svarte ikke (da er ingen
 * konklusjon trukket for den motoren)
 *
 * @module PAI/Tools/HarnessSync
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OPENCODE_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const TIDSAVBRUDD_MS = 15_000;

export type Motor = "claude-code" | "opencode-v2";

/** En rad i antakelsesregisteret, og mønstrene som kan røre den. */
export interface Regel {
	rad: string;
	mønster: RegExp;
}

const HOOKNAVN = /\b(SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|SessionEnd|SubagentStart|SubagentStop|PreCompact)\b/;

/** Claude-tabellen i registeret. Bredt heller enn smalt: en falsk flagging koster en lesning. */
export const CLAUDE_REGLER: readonly Regel[] = [
	{ rad: "hook-taket (K-10)", mønster: /additionalContext|persisted-output|hook (output|context)|context from hooks?/i },
	{ rad: "--append-system-prompt-file (K-10)", mønster: /append-system-prompt|system prompt file/i },
	{ rad: "hooks i exec-form, CLAUDE_PLUGIN_ROOT (M-42)", mønster: /hooks\.json|CLAUDE_PLUGIN_ROOT|hook commands?\b|exec form/i },
	{ rad: "plugin-formen og plugin validate (M-42)", mønster: /plugin validate|plugin\.json|--plugin-dir|plugin manifest/i },
	{ rad: "permissionDecision og begrunnelsen (vakten)", mønster: /permissionDecision|permission decision|PreToolUse/i },
	{ rad: "Stop-blokkering (PAI_ISC_ENFORCE)", mønster: /\bStop hooks?\b|stop_hook_active|decision: ?"?block/i },
	{ rad: "Agent-verktøyet og updatedInput (M-17, M-44, K-09)", mønster: /updatedInput|subagent_type|\bAgent tool|\bTask tool|file_path/i },
	{ rad: "Agent kjører asynkront (registeret)", mønster: /background (agent|subagent)|async(hronous)? (agent|subagent)|SubagentStop/i },
	{ rad: "Skill-kall og args.skill (M-40)", mønster: /\bSkill tool|skill (invocation|arguments?)|args\.skill/i },
	{ rad: "SessionEnd i -p (røyktesten)", mønster: /SessionEnd/ },
	{ rad: "plugin-MCP-navnene (batch 9)", mønster: /mcp__plugin|\.mcp\.json|plugin MCP|MCP servers? (from|in|declared in) plugins?/i },
	{ rad: "TaskCreate og CLAUDE_CODE_ENABLE_TODO_TOOLS (ISC)", mønster: /TaskCreate|TODO_TOOLS|todo tools?/i },
	{ rad: "DISABLE_AUTOUPDATER og claude install (C1)", mønster: /DISABLE_AUTOUPDATER|auto-?updat|claude install\b|native installer/i },
	{ rad: "strømformatet ClaudeSmoke leser", mønster: /include-hook-events|hook_started|hook_response|stream-json/i },
	{ rad: "skriveverktøyene og vakten (K58)", mønster: /NotebookEdit|notebook edit|MultiEdit|\b(Write|Edit) tool\b|\bnew tools?\b/i },
	{ rad: "hook-hendelsene", mønster: HOOKNAVN },
];

/** v2-raden i registeret og det som står «utenfor røyktesten». Gjelder commit-emner. */
export const V2_REGLER: readonly Regel[] = [
	{ rad: "plugin-API-et og hookene (V2Smoke)", mønster: /\bplugins?\b|\bhooks?\b/i },
	{ rad: "skallverktøyet heter shell (vakten)", mønster: /\bshell\b|\bbash\b/i },
	{ rad: "session.context per tur", mønster: /session\.context|system prompt|\bcontext\b/i },
	{ rad: "OPENCODE_CONFIG_CONTENT og --standalone (B2, B6)", mønster: /OPENCODE_CONFIG_CONTENT|standalone|background service|\bserve\b/i },
	{ rad: "agenter trenger mode: all", mønster: /\bagents?\b.*\bmode\b|\bmode\b.*\bagents?\b|subagent/i },
	{ rad: "modellkatalogen i opencode.db", mønster: /models\.dev|models-dev|model catalog/i },
	{ rad: "innloggingen i credential-tabellen", mønster: /credential|\bauth\b/i },
	{ rad: "kompaktering (fase 5)", mønster: /compact/i },
	{ rad: "tillatelser og ask-dialogen", mønster: /permission/i },
	{ rad: "skriveverktøyene og vakten (K58)", mønster: /\b(patch|write|edit)\b.*\btools?\b|\btools?\b.*\b(patch|write|edit)\b|apply_patch/i },
];

/** Stier i v2-repoet som rører det samme, uansett hva commit-emnet sier. */
export const V2_STIER: readonly Regel[] = [
	{ rad: "plugin-API-et og hookene (V2Smoke)", mønster: /plugin|hook/i },
	{ rad: "skallverktøyet heter shell (vakten)", mønster: /tool\/(shell|bash)/i },
	{ rad: "skriveverktøyene og vakten (K58)", mønster: /core\/src\/tool\/plugin\//i },
];

export interface Treff {
	versjon: string;
	tekst: string;
	rader: string[];
}

export interface MotorRapport {
	motor: Motor;
	pinnet: string | null;
	siste: string | null;
	/** `stable` for Claude Code, som apt-kilden følger. */
	stabil?: string | null;
	nyere: string[];
	treff: Treff[];
	/** Linjer i endringene som ikke rørte noe. */
	uflagget: number;
	feil?: string;
	/** Compare-API-et kutter ved 300 filer og 250 commits. */
	avkortet?: boolean;
}

/** -1, 0 eller 1. Bare `X.Y.Z`; alt annet sammenlignes som 0. */
export function sammenlignVersjon(a: string, b: string): number {
	const del = (v: string) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
	const [x, y] = [del(a), del(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
	return 0;
}

/** Versjonsseksjonene i en `CHANGELOG.md` med `fra < versjon <= til`, med linjene sine. */
export function seksjonerMellom(changelog: string, fra: string, til: string): { versjon: string; linjer: string[] }[] {
	const ut: { versjon: string; linjer: string[] }[] = [];
	let gjeldende: { versjon: string; linjer: string[] } | null = null;
	for (const linje of changelog.split("\n")) {
		const m = linje.match(/^##\s+v?(\d+\.\d+\.\d+)\s*$/);
		if (m) {
			const v = m[1];
			gjeldende = sammenlignVersjon(v, fra) > 0 && sammenlignVersjon(v, til) <= 0 ? { versjon: v, linjer: [] } : null;
			if (gjeldende) ut.push(gjeldende);
			continue;
		}
		const punkt = linje.match(/^\s*[-*]\s+(.*\S)/);
		if (gjeldende && punkt) gjeldende.linjer.push(punkt[1]);
	}
	return ut;
}

/** Radene en tekst rører. Tom når ingen regel treffer. */
export function klassifiser(tekst: string, regler: readonly Regel[]): string[] {
	return [...new Set(regler.filter((r) => r.mønster.test(tekst)).map((r) => r.rad))];
}

/** Exit-koden for hele rapporten, se modulkommentaren. */
export function utfall(rapporter: readonly MotorRapport[]): 0 | 1 | 2 | 3 {
	if (rapporter.some((r) => r.feil)) return 3;
	if (rapporter.some((r) => r.treff.length > 0)) return 1;
	if (rapporter.some((r) => r.nyere.length > 0)) return 2;
	return 0;
}

export function lesPinning(opencodeDir = OPENCODE_DIR): { claude: string | null; v2: string | null } {
	try {
		const pkg = JSON.parse(readFileSync(join(opencodeDir, "package.json"), "utf-8"));
		return { claude: pkg?.pai?.claudeCode ?? null, v2: pkg?.dependencies?.["@opencode/cli"] ?? null };
	} catch {
		return { claude: null, v2: null };
	}
}

async function hent(url: string, json: true): Promise<unknown>;
async function hent(url: string, json: false): Promise<string>;
async function hent(url: string, json: boolean): Promise<unknown> {
	const r = await fetch(url, {
		signal: AbortSignal.timeout(TIDSAVBRUDD_MS),
		headers: { "User-Agent": "pai-harness-sync" },
	});
	if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
	return json ? r.json() : r.text();
}

async function distTags(pakke: string): Promise<Record<string, string>> {
	const d = (await hent(`https://registry.npmjs.org/${pakke}`, true)) as { "dist-tags"?: Record<string, string> };
	return d["dist-tags"] ?? {};
}

async function sjekkClaude(pinnet: string | null): Promise<MotorRapport> {
	const r: MotorRapport = { motor: "claude-code", pinnet, siste: null, nyere: [], treff: [], uflagget: 0 };
	try {
		const tags = await distTags("@anthropic-ai/claude-code");
		r.siste = tags.latest ?? null;
		r.stabil = tags.stable ?? null;
		if (!pinnet || !r.siste || sammenlignVersjon(r.siste, pinnet) <= 0) return r;
		const log = await hent("https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md", false);
		for (const s of seksjonerMellom(log, pinnet, r.siste)) {
			r.nyere.push(s.versjon);
			for (const tekst of s.linjer) {
				const rader = klassifiser(tekst, CLAUDE_REGLER);
				if (rader.length) r.treff.push({ versjon: s.versjon, tekst, rader });
				else r.uflagget++;
			}
		}
		// En versjon i npm uten seksjon i endringsloggen: si det, ikke tro at den er tom.
		if (!r.nyere.includes(r.siste)) r.feil = `the changelog has no section for ${r.siste}`;
	} catch (e) {
		r.feil = e instanceof Error ? e.message : String(e);
	}
	return r;
}

export interface Compare {
	commits?: { commit: { message: string } }[];
	files?: { filename: string }[];
	total_commits?: number;
}

/**
 * Treffene i et compare-svar fra GitHub. Release-commitene hoppes over, og
 * testfiler teller ikke som stier: de rører ikke kontrakten, og de er mange.
 */
export function v2Treff(c: Compare, spenn: string): Pick<MotorRapport, "treff" | "uflagget" | "avkortet"> {
	const treff: Treff[] = [];
	let uflagget = 0;
	for (const k of c.commits ?? []) {
		const tekst = k.commit.message.split("\n")[0];
		if (/^(release|sync release versions)\b/i.test(tekst)) continue;
		const rader = klassifiser(tekst, V2_REGLER);
		if (rader.length) treff.push({ versjon: spenn, tekst, rader });
		else uflagget++;
	}
	for (const f of c.files ?? []) {
		if (/(^|\/)test\/|\.test\.[jt]sx?$/.test(f.filename)) continue;
		const rader = klassifiser(f.filename, V2_STIER);
		if (rader.length) treff.push({ versjon: spenn, tekst: `file: ${f.filename}`, rader });
	}
	const avkortet = (c.files?.length ?? 0) >= 300 || (c.total_commits ?? 0) > (c.commits?.length ?? 0);
	return { treff, uflagget, avkortet };
}

async function sjekkV2(pinnet: string | null): Promise<MotorRapport> {
	const r: MotorRapport = { motor: "opencode-v2", pinnet, siste: null, nyere: [], treff: [], uflagget: 0 };
	try {
		r.siste = (await distTags("@opencode/cli")).latest ?? null;
		if (!pinnet || !r.siste || sammenlignVersjon(r.siste, pinnet) <= 0) return r;
		const spenn = `v${pinnet}...v${r.siste}`;
		const c = (await hent(`https://api.github.com/repos/anomalyco/opencode/compare/${spenn}`, true)) as Compare;
		r.nyere.push(spenn);
		Object.assign(r, v2Treff(c, spenn));
	} catch (e) {
		r.feil = e instanceof Error ? e.message : String(e);
	}
	return r;
}

export function markdown(rapporter: readonly MotorRapport[]): string {
	const ut: string[] = ["# HarnessSync", ""];
	for (const r of rapporter) {
		const navn = r.motor === "claude-code" ? "Claude Code" : "OpenCode v2";
		const stabil = r.stabil ? ` (stable ${r.stabil})` : "";
		ut.push(`## ${navn}: pinned ${r.pinnet ?? "?"}, latest ${r.siste ?? "?"}${stabil}`, "");
		if (r.feil) ut.push(`❌ ${r.feil}. No conclusion for ${navn}.`, "");
		if (!r.feil && r.nyere.length === 0) ut.push("✅ on the latest version.", "");
		if (r.nyere.length) ut.push(`Newer: ${r.nyere.join(", ")}. ${r.treff.length} flagged, ${r.uflagget} without hits.`, "");
		if (r.avkortet) ut.push("⚠️ the compare response is truncated: read the rest on GitHub.", "");
		for (const t of r.treff) ut.push(`- **${t.versjon}** ${t.tekst}`, `  → ${t.rader.join("; ")}`);
		if (r.treff.length) ut.push("");
	}
	return ut.join("\n");
}

if (import.meta.main) {
	const [kommando, ...flagg] = process.argv.slice(2);
	if (kommando !== "check") {
		console.log("Usage: bun .opencode/PAI/Tools/HarnessSync.ts check [--json] [--claude-fra X.Y.Z] [--v2-fra X.Y.Z]");
		process.exit(kommando ? 64 : 0);
	}
	const pin = lesPinning();
	const verdi = (navn: string) => {
		const i = flagg.indexOf(navn);
		return i >= 0 ? (flagg[i + 1] ?? null) : null;
	};
	const rapporter = await Promise.all([
		sjekkClaude(verdi("--claude-fra") ?? pin.claude),
		sjekkV2(verdi("--v2-fra") ?? pin.v2),
	]);
	console.log(flagg.includes("--json") ? JSON.stringify({ rapporter }, null, 2) : markdown(rapporter));
	process.exit(utfall(rapporter));
}
