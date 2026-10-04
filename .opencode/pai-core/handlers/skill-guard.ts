/**
 * Skill Guard Handler (v3.0)
 *
 * Validates skill invocations match USE WHEN triggers.
 * Warns on mismatched invocations but doesn't block.
 *
 * Ported from PAI v3.0 SkillGuard.hook.ts
 *
 * @module skill-guard
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileLog, fileLogError } from "../lib/file-logger";
import { getOpenCodeDir } from "../lib/paths";

interface SkillValidation {
	valid: boolean;
	reason?: string;
}

/** Skills known to be false-positive triggers */
const BLOCKED_SKILLS = ["keybindings-help"];

/**
 * Check if a skill is in the blocked list
 */
export function isBlockedSkill(skillName: string): boolean {
	return BLOCKED_SKILLS.includes(skillName.toLowerCase());
}

/**
 * Find skill directory (supports both flat and hierarchical structures)
 * Searches: skills/SkillName/ and skills/Category/SkillName/
 */
function findSkillDir(skillName: string): string | null {
	const skillsDir = path.join(getOpenCodeDir(), "skills");

	// Try flat structure first (backward compatibility)
	const flatPath = path.join(skillsDir, skillName);
	if (fs.existsSync(flatPath)) {
		return flatPath;
	}

	// Try hierarchical structure - search all categories
	try {
		const categories = fs
			.readdirSync(skillsDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);

		for (const category of categories) {
			const categoryPath = path.join(skillsDir, category);
			const nestedSkillPath = path.join(categoryPath, skillName);
			if (fs.existsSync(nestedSkillPath)) {
				return nestedSkillPath;
			}
		}
	} catch {
		// Fall through to return null
	}

	return null;
}

/**
 * Skillnavnet fra verktøyargumentene, uansett motor (M-40).
 *
 * Claude sender `skill` (`"pai:infrastructure-pihole"`), v2 sender `id`
 * (`"Pihole"`), begge MÅLT 2026-09-26. `name` var det vakten leste fram til
 * da, og ingen av motorene sender det. Tom streng når ingen finnes.
 */
export function skillnavnFraArgs(args: Record<string, unknown>): string {
	for (const felt of ["skill", "id", "name"]) {
		const verdi = args[felt];
		if (typeof verdi === "string" && verdi.trim()) return verdi.trim();
	}
	return "";
}

/**
 * Kildekatalogen til en skill i Claude-speilet, via `claude-plugin/skill-map.json`.
 *
 * Claude adresserer skills som `<plugin>:<flatt-navn>`, og det flate navnet
 * (`infrastructure-pihole`) finnes ikke i kildetreet. Kartet ligger ved siden
 * av `.opencode/` i repoet, og `kilde` er relativ til repo-roten. Null når
 * kartet mangler eller ikke kjenner navnet.
 */
function findSkillDirViaMap(flattNavn: string): string | null {
	try {
		const repoRot = path.dirname(fs.realpathSync(getOpenCodeDir()));
		const kart = JSON.parse(fs.readFileSync(path.join(repoRot, "claude-plugin", "skill-map.json"), "utf-8")) as {
			skills?: Record<string, { kilde?: unknown }>;
			aliaser?: Record<string, unknown>;
		};
		const alias = kart.aliaser?.[flattNavn.toLowerCase()];
		const oppføring = kart.skills?.[flattNavn] ?? (typeof alias === "string" ? kart.skills?.[alias] : undefined);
		if (typeof oppføring?.kilde !== "string") return null;
		const dir = path.join(repoRot, oppføring.kilde);
		return fs.existsSync(dir) ? dir : null;
	} catch {
		return null;
	}
}

/**
 * Finn en skill under navnet motoren brukte: kildenavnet (`Pihole`, v2) eller
 * speilnavnet med pluginprefiks (`pai:infrastructure-pihole`, Claude).
 */
function resolveSkillDir(skillName: string): string | null {
	const utenPrefiks = skillName.replace(/^[a-z0-9-]+:/i, "");
	return findSkillDir(utenPrefiks) ?? findSkillDirViaMap(utenPrefiks);
}

/**
 * Extract USE WHEN triggers from a skill's SKILL.md
 */
function extractTriggers(skillName: string): string | null {
	try {
		const skillDir = resolveSkillDir(skillName);
		if (!skillDir) return null;

		const skillPath = path.join(skillDir, "SKILL.md");

		if (!fs.existsSync(skillPath)) return null;

		const content = fs.readFileSync(skillPath, "utf-8");

		// Look for description in frontmatter
		const frontmatterMatch = content.match(/---\s*\n[\s\S]*?description:\s*(.+)\n[\s\S]*?---/);
		if (frontmatterMatch) {
			return frontmatterMatch[1].trim();
		}

		// Look for USE WHEN in content
		const useWhenMatch = content.match(/USE WHEN[:\s]+(.+)/i);
		if (useWhenMatch) {
			return useWhenMatch[1].trim();
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Validate a skill invocation
 */
export async function validateSkillInvocation(
	skillName: string,
	_context: string
): Promise<SkillValidation> {
	try {
		// Block known false-positives
		if (isBlockedSkill(skillName)) {
			fileLog(`[SkillGuard] Blocked false-positive: ${skillName}`, "warn");
			return {
				valid: false,
				reason: `Skill "${skillName}" is in the blocked list (known false-positive)`,
			};
		}

		// Check skill exists (supports hierarchical structure)
		const skillDir = resolveSkillDir(skillName);
		if (!skillDir) {
			fileLog(`[SkillGuard] Skill not found: ${skillName}`, "warn");
			return {
				valid: false,
				reason: `Skill "${skillName}" not found in skills directory (checked flat and hierarchical structures)`,
			};
		}

		// Extract and log triggers for debugging
		const triggers = extractTriggers(skillName);
		if (triggers) {
			fileLog(`[SkillGuard] Skill "${skillName}" triggers: ${triggers.substring(0, 100)}`, "debug");
		}

		fileLog(`[SkillGuard] Skill "${skillName}" invocation OK`, "debug");
		return { valid: true };
	} catch (error) {
		fileLogError("[SkillGuard] Validation failed", error);
		return { valid: true, reason: "Validation error — allowing invocation" };
	}
}
