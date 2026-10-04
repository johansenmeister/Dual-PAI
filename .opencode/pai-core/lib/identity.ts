/**
 * Central Identity Loader
 * Single source of truth for DA (Digital Assistant) and Principal identity
 *
 * Reads from settings.json - the programmatic way, not markdown parsing.
 * All hooks and tools should import from here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getHomePaiDir } from "./paths";

/**
 * Path to settings.json, resolved on each call.
 *
 * Was `join(process.env.HOME!, ".opencode/settings.json")` evaluated at module
 * load — a non-null assertion outside any try/catch that took the whole plugin
 * down if HOME was unset (M-04). Lazy resolution also lets PAI_HOME reach a
 * module that is imported long before any hook runs.
 */
function getSettingsPath(): string {
	// OpenCode uses ~/.opencode/ (not ~/.claude/)
	return join(getHomePaiDir(), "settings.json");
}

// Default identity (fallback if settings.json doesn't have identity section)
const DEFAULT_IDENTITY = {
	name: "PAI",
	fullName: "Personal AI",
	displayName: "PAI",
	voiceId: "",
	color: "#3B82F6",
};

const DEFAULT_PRINCIPAL = {
	name: "User",
	pronunciation: "",
	timezone: "UTC",
};

export interface VoiceProsody {
	stability: number;
	similarity_boost: number;
	style: number;
	speed: number;
	use_speaker_boost: boolean;
	volume?: number;
}

export interface Identity {
	name: string;
	fullName: string;
	displayName: string;
	voiceId: string;
	color: string;
	voice?: VoiceProsody;
}

export interface Principal {
	name: string;
	pronunciation: string;
	timezone: string;
}

export interface Settings {
	daidentity?: Partial<Identity>;
	principal?: Partial<Principal>;
	env?: Record<string, string>;
	[key: string]: unknown;
}

let cachedSettings: Settings | null = null;

/**
 * Load settings.json (cached)
 */
function loadSettings(): Settings {
	if (cachedSettings) return cachedSettings;

	try {
		const settingsPath = getSettingsPath();
		if (!existsSync(settingsPath)) {
			cachedSettings = {};
			return cachedSettings;
		}

		const content = readFileSync(settingsPath, "utf-8");
		const parsed: Settings = JSON.parse(content);
		cachedSettings = parsed;
		return parsed;
	} catch {
		cachedSettings = {};
		return cachedSettings;
	}
}

/**
 * Get DA (Digital Assistant) identity from settings.json
 */
export function getIdentity(): Identity {
	const settings = loadSettings();

	// Prefer settings.daidentity, fall back to env.DA for backward compat
	const daidentity = settings.daidentity || {};
	const envDA = settings.env?.DA;

	return {
		name: daidentity.name || envDA || DEFAULT_IDENTITY.name,
		fullName: daidentity.fullName || daidentity.name || envDA || DEFAULT_IDENTITY.fullName,
		displayName: daidentity.displayName || daidentity.name || envDA || DEFAULT_IDENTITY.displayName,
		voiceId: daidentity.voiceId || DEFAULT_IDENTITY.voiceId,
		color: daidentity.color || DEFAULT_IDENTITY.color,
		voice: daidentity.voice,
	};
}

/**
 * Get Principal (human owner) identity from settings.json
 */
export function getPrincipal(): Principal {
	const settings = loadSettings();

	// Prefer settings.principal, fall back to env.PRINCIPAL for backward compat
	const principal = settings.principal || {};
	const envPrincipal = settings.env?.PRINCIPAL;

	return {
		name: principal.name || envPrincipal || DEFAULT_PRINCIPAL.name,
		pronunciation: principal.pronunciation || DEFAULT_PRINCIPAL.pronunciation,
		timezone: principal.timezone || DEFAULT_PRINCIPAL.timezone,
	};
}

/**
 * Clear cache (useful for testing or when settings.json changes)
 */
export function clearCache(): void {
	cachedSettings = null;
}

/**
 * Get just the DA name (convenience function)
 */
export function getDAName(): string {
	return getIdentity().name;
}

/**
 * Get just the Principal name (convenience function)
 */
export function getPrincipalName(): string {
	return getPrincipal().name;
}

/**
 * Get just the voice ID (convenience function)
 */
export function getVoiceId(): string {
	return getIdentity().voiceId;
}

/**
 * Get the full settings object (for advanced use)
 */
export function getSettings(): Settings {
	return loadSettings();
}

/**
 * Get the default identity (for documentation/testing)
 */
export function getDefaultIdentity(): Identity {
	return { ...DEFAULT_IDENTITY };
}

/**
 * Get the default principal (for documentation/testing)
 */
export function getDefaultPrincipal(): Principal {
	return { ...DEFAULT_PRINCIPAL };
}

/**
 * Get voice prosody settings (convenience function)
 */
export function getVoiceProsody(): VoiceProsody | undefined {
	return getIdentity().voice;
}
