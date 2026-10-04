#!/usr/bin/env bun
/**
 * PAI Provider Switch Tool
 *
 * Switches ALL agent models by applying a provider profile.
 * Single command to change from ZEN → Anthropic → OpenAI → Google → Local.
 *
 * With --multi-research flag, researchers use their native providers
 * for diverse perspectives. A researcher counts as keyed when its provider is
 * logged in with `opencode auth login` (v2's credential store), or when its
 * `api_key_env` is set in the environment or in ~/.opencode/.env.
 *
 * Usage:
 *   bun run switch-provider.ts anthropic                  # All agents use Anthropic
 *   bun run switch-provider.ts anthropic --multi-research  # + native researchers
 *   bun run switch-provider.ts --list                      # Show profiles
 *   bun run switch-provider.ts --current                   # Show current config
 *   bun run switch-provider.ts --researchers               # Show researcher routing
 *
 * @version 3.0.0
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import { Database } from "bun:sqlite";

// Paths
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const OPENCODE_DIR = dirname(SCRIPT_DIR); // .opencode/
const PROJECT_ROOT = dirname(OPENCODE_DIR);
const PROFILES_DIR = join(OPENCODE_DIR, "profiles");
const OPENCODE_JSON_PATH = join(PROJECT_ROOT, "opencode.json");
const SETTINGS_JSON_PATH = join(OPENCODE_DIR, "settings.json");
const RESEARCHERS_YAML_PATH = join(PROFILES_DIR, "researchers.yaml");
const ENV_PATH = join(homedir(), ".opencode", ".env");
// v2 keeps `auth login` credentials in its own database, not in v1's
// auth.json: auth.json alone gave no stored integrations under v2 (MÅLT, v2
// plan phase 6).
const OPENCODE_DB_PATH = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
  "opencode.db",
);

// ANSI colors
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[38;2;34;197;94m",
  red: "\x1b[38;2;239;68;68m",
  cyan: "\x1b[38;2;6;182;212m",
  yellow: "\x1b[38;2;234;179;8m",
  gray: "\x1b[38;2;100;116;139m",
  dim: "\x1b[2m",
};

// Types
interface AgentConfig {
  model: string;
}

interface Profile {
  name: string;
  description: string;
  default_model: string;
  agents: Record<string, AgentConfig>;
}

interface ResearcherConfig {
  native_model: string;
  api_key_env: string;
  description: string;
  get_key_url: string;
}

interface ResearchersOverlay {
  enabled: boolean;
  researchers: Record<string, ResearcherConfig>;
}

// ============================================================================
// ENV LOADING
// ============================================================================

/**
 * Load environment variables from ~/.opencode/.env
 */
function loadEnvFile(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(ENV_PATH)) return env;

  try {
    const content = readFileSync(ENV_PATH, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      let value = trimmed.substring(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && value) env[key] = value;
    }
  } catch { /* ignore */ }

  return env;
}

/**
 * Provider ids that have a credential in v2's store (`opencode auth login`).
 *
 * Without this, a provider connected with `/connect` was reported as
 * "missing key" and its researchers stayed on the primary profile. Reads
 * only `integration_id`, never the secret, and read-only. An unknown schema
 * or a missing database gives an empty set: the `.env` check still applies.
 */
export function loadStoredIntegrations(dbPath = OPENCODE_DB_PATH): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(dbPath)) return ids;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.query("SELECT DISTINCT integration_id FROM credential").all() as Array<{ integration_id: unknown }>;
      for (const r of rows) if (typeof r.integration_id === "string") ids.add(r.integration_id);
    } finally {
      db.close();
    }
  } catch { /* ignore */ }
  return ids;
}

/** The provider is the part of the model id before the first `/`. */
function providerOf(model: string): string {
  return model.split("/")[0];
}

export function hasApiKey(
  cfg: Pick<ResearcherConfig, "api_key_env" | "native_model">,
  envFile: Record<string, string>,
  stored: Set<string> = loadStoredIntegrations(),
): boolean {
  if (envFile[cfg.api_key_env] || process.env[cfg.api_key_env]) return true;
  return stored.has(providerOf(cfg.native_model));
}

// ============================================================================
// RESEARCHER OVERLAY
// ============================================================================

export function loadResearchersOverlay(): ResearchersOverlay | null {
  if (!existsSync(RESEARCHERS_YAML_PATH)) return null;
  try {
    const content = readFileSync(RESEARCHERS_YAML_PATH, "utf-8");
    return parseYaml(content) as ResearchersOverlay;
  } catch {
    return null;
  }
}

/**
 * Apply researcher overlay — called ONLY when user explicitly opts in with --multi-research.
 * Checks that all required API keys exist. Fails fast if any key is missing.
 */
export function applyResearcherOverlay(
  agentModels: Record<string, AgentConfig>,
  overlay: ResearchersOverlay,
  envFile: Record<string, string>,
  stored: Set<string> = loadStoredIntegrations(),
): {
  updatedModels: Record<string, AgentConfig>;
  routed: Array<{ agent: string; model: string }>;
  missingKeys: Array<{ agent: string; keyNeeded: string; url: string }>;
} {
  const updatedModels = { ...agentModels };
  const routed: Array<{ agent: string; model: string }> = [];
  const missingKeys: Array<{ agent: string; keyNeeded: string; url: string }> = [];

  for (const [agentName, config] of Object.entries(overlay.researchers)) {
    if (!(agentName in updatedModels)) continue;

    if (hasApiKey(config, envFile, stored)) {
      // Override the agent's model with the researcher's native provider model.
      updatedModels[agentName] = {
        model: config.native_model,
      };
      routed.push({ agent: agentName, model: config.native_model });
    } else {
      missingKeys.push({
        agent: agentName,
        keyNeeded: config.api_key_env,
        url: config.get_key_url,
      });
    }
  }

  return { updatedModels, routed, missingKeys };
}

// ============================================================================
// PROFILE MANAGEMENT
// ============================================================================

export function loadProfile(profileName: string): Profile {
  const profilePath = join(PROFILES_DIR, `${profileName}.yaml`);
  if (!existsSync(profilePath)) {
    throw new Error(
      `Profile '${profileName}' not found at ${profilePath}\n` +
        `Available profiles: ${listProfileNames().join(", ")}`
    );
  }
  const content = readFileSync(profilePath, "utf-8");
  return parseYaml(content) as Profile;
}

export function listProfileNames(): string[] {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith(".yaml") && f !== "researchers.yaml")
    .map((f) => f.replace(".yaml", ""))
    .sort();
}

/**
 * Apply a provider profile to opencode.json and settings.json.
 *
 * @param multiResearch - If true, researchers get native provider models (requires API keys)
 */
export function applyProfile(profileName: string, multiResearch = false): {
  profile: Profile;
  agentCount: number;
  opencodeJsonPath: string;
  multiResearch: boolean;
  researcherRouted: Array<{ agent: string; model: string }>;
  researcherMissing: Array<{ agent: string; keyNeeded: string; url: string }>;
} {
  const profile = loadProfile(profileName);
  const { default_model, agents } = profile;

  let finalAgentModels = { ...agents };
  let researcherRouted: Array<{ agent: string; model: string }> = [];
  let researcherMissing: Array<{ agent: string; keyNeeded: string; url: string }> = [];

  // Multi-research: only when user explicitly asked for it
  if (multiResearch) {
    const overlay = loadResearchersOverlay();
    if (!overlay || !overlay.enabled) {
      throw new Error(
        "Multi-provider research is not configured.\n" +
        `Check ${RESEARCHERS_YAML_PATH}`
      );
    }

    const envFile = loadEnvFile();
    const result = applyResearcherOverlay(finalAgentModels, overlay, envFile);
    finalAgentModels = result.updatedModels;
    researcherRouted = result.routed;
    researcherMissing = result.missingKeys;
  }

  // --- 1. Update opencode.json ---
  let opencodeJson: Record<string, any> = {};
  if (existsSync(OPENCODE_JSON_PATH)) {
    opencodeJson = JSON.parse(readFileSync(OPENCODE_JSON_PATH, "utf-8"));
  }

  opencodeJson.model = default_model;

  // Merge new model into any existing per-agent config so non-model fields
  // (permission overrides, prompts, tool restrictions, etc.) are preserved.
  const existingAgentBlock: Record<string, Record<string, unknown>> =
    (opencodeJson.agent && typeof opencodeJson.agent === "object"
      ? (opencodeJson.agent as Record<string, Record<string, unknown>>)
      : {});

  const agentBlock: Record<string, Record<string, unknown>> = {};

  // Helper: strip legacy `model_tiers` from a preserved agent block, keep
  // everything else (permission, prompts, tool restrictions, etc.).
  const stripLegacy = (entry: Record<string, unknown>): Record<string, unknown> => {
    const { model_tiers: _drop, ...preserved } = entry as Record<string, unknown> & {
      model_tiers?: unknown;
    };
    return preserved;
  };

  // Helper: derive a canonical `model` string from a legacy agent entry
  // that may only have `model_tiers` and no top-level `model`. Fallback
  // order: standard > top-level > quick > advanced. Returns undefined if no
  // recognizable model can be extracted.
  const deriveLegacyModel = (entry: Record<string, unknown>): string | undefined => {
    if (typeof entry.model === "string" && entry.model.length > 0) {
      return entry.model;
    }
    const tiers = entry.model_tiers as
      | {
          quick?: { model?: string } | string;
          standard?: { model?: string } | string;
          advanced?: { model?: string } | string;
        }
      | undefined;
    if (!tiers) return undefined;

    const readTier = (t: unknown): string | undefined => {
      if (typeof t === "string") return t;
      if (t && typeof t === "object" && typeof (t as { model?: unknown }).model === "string") {
        return (t as { model: string }).model;
      }
      return undefined;
    };

    return readTier(tiers.standard) ?? readTier(tiers.quick) ?? readTier(tiers.advanced);
  };

  // 1. Write the profile's agents, merging with any pre-existing config.
  for (const [agentName, agentConfig] of Object.entries(finalAgentModels)) {
    const existing = existingAgentBlock[agentName] ?? {};
    agentBlock[agentName] = {
      ...stripLegacy(existing),
      model: agentConfig.model,
    };
  }

  // 2. Preserve any user-defined agents that are NOT in the profile.
  // Without this step, a user who added a custom agent to opencode.json
  // would lose it every time they ran `switch-provider`.
  //
  // For legacy-only agents (those with `model_tiers` but no top-level
  // `model`), derive a canonical model via deriveLegacyModel() so the
  // resulting block is never left in a no-model state after stripping.
  for (const [agentName, existing] of Object.entries(existingAgentBlock)) {
    if (agentName in agentBlock) continue; // already written above
    const stripped = stripLegacy(existing);
    if (typeof stripped.model === "string" && stripped.model.length > 0) {
      agentBlock[agentName] = stripped;
      continue;
    }
    const derived = deriveLegacyModel(existing);
    if (derived) {
      agentBlock[agentName] = { ...stripped, model: derived };
    } else {
      // No model anywhere — preserve the entry verbatim (minus model_tiers)
      // so the user's other fields (prompts, permissions) survive, and let
      // opencode report a more targeted error when it tries to run the agent.
      agentBlock[agentName] = stripped;
    }
  }

  opencodeJson.agent = agentBlock;

  writeFileSync(OPENCODE_JSON_PATH, JSON.stringify(opencodeJson, null, 2) + "\n");

  // --- 2. Update settings.json ---
  if (existsSync(SETTINGS_JSON_PATH)) {
    try {
      const settings = JSON.parse(readFileSync(SETTINGS_JSON_PATH, "utf-8"));
      settings.provider = {
        id: profile.name,
        name: profile.description,
        model: default_model,
        profile: profileName,
        multiResearch,
      };
      writeFileSync(SETTINGS_JSON_PATH, JSON.stringify(settings, null, 2) + "\n");
    } catch { /* ignore */ }
  }

  return {
    profile,
    agentCount: Object.keys(finalAgentModels).length,
    opencodeJsonPath: OPENCODE_JSON_PATH,
    multiResearch,
    researcherRouted,
    researcherMissing,
  };
}

function getCurrentProvider(): { id: string; model: string; multiResearch?: boolean } | null {
  try {
    if (!existsSync(SETTINGS_JSON_PATH)) return null;
    const settings = JSON.parse(readFileSync(SETTINGS_JSON_PATH, "utf-8"));
    return settings.provider || null;
  } catch {
    return null;
  }
}

// ============================================================================
// CLI (only executes when run directly, not when imported as module)
// ============================================================================

const isMainScript = typeof Bun !== "undefined" && Bun.main === import.meta.path;

if (isMainScript) {

/**
 * The researcher list in `--help`, read from researchers.yaml. It used to be
 * hardcoded, and had drifted to four models none of the researchers ran.
 */
function researcherLines(): string {
  const overlay = loadResearchersOverlay();
  if (!overlay?.researchers) return `    ${c.gray}(no researchers.yaml)${c.reset}`;
  return Object.entries(overlay.researchers)
    .map(([name, cfg]) => `    ${name.padEnd(22)} → ${c.cyan}${cfg.native_model}${c.reset} (${cfg.api_key_env} or ${providerOf(cfg.native_model)} login)`)
    .join("\n");
}

function printUsage() {
  console.log(`
${c.bold}PAI Provider Switch${c.reset}
${c.gray}Switch all agent models with a single command.${c.reset}

${c.bold}USAGE:${c.reset}
  bun run switch-provider.ts <profile>                  All agents use one provider
  bun run switch-provider.ts <profile> --multi-research  + researchers on native providers
  bun run switch-provider.ts --list                      List available profiles
  bun run switch-provider.ts --current                   Show current provider
  bun run switch-provider.ts --researchers               Show researcher routing info

${c.bold}PROFILES:${c.reset}`);

  for (const name of listProfileNames()) {
    try {
      const profile = loadProfile(name);
      console.log(`  ${c.cyan}${name.padEnd(12)}${c.reset} ${profile.description}`);
    } catch {
      console.log(`  ${c.cyan}${name}${c.reset} (error loading)`);
    }
  }

  console.log(`
${c.bold}WHAT IS --multi-research?${c.reset}
  By default, ALL agents (including researchers) use your chosen provider.
  With ${c.cyan}--multi-research${c.reset}, research agents use their native providers
  for more diverse results:

${researcherLines()}

  Log the providers in with ${c.cyan}opencode auth login${c.reset}, or set the keys in
  ${c.cyan}~/.opencode/.env${c.reset}, before using this flag.

${c.bold}EXAMPLES:${c.reset}
  bun run switch-provider.ts anthropic                  ${c.gray}# Everything on Claude${c.reset}
  bun run switch-provider.ts anthropic --multi-research ${c.gray}# Claude + native researchers${c.reset}
  bun run switch-provider.ts zen                        ${c.gray}# Free tier, no keys needed${c.reset}
`);
}

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  printUsage();
  process.exit(0);
}

if (args[0] === "--list" || args[0] === "-l") {
  console.log(`\n${c.bold}Available Provider Profiles:${c.reset}\n`);
  for (const name of listProfileNames()) {
    try {
      const profile = loadProfile(name);
      const current = getCurrentProvider();
      const marker = current?.id === name ? ` ${c.green}← current${c.reset}` : "";
      console.log(`  ${c.cyan}${name.padEnd(12)}${c.reset} ${profile.description}${marker}`);
    } catch {
      console.log(`  ${c.cyan}${name}${c.reset} (error loading)`);
    }
  }
  console.log("");
  process.exit(0);
}

if (args[0] === "--current" || args[0] === "-c") {
  const current = getCurrentProvider();
  if (current) {
    console.log(`\n${c.bold}Current Provider:${c.reset}    ${c.cyan}${current.id}${c.reset}`);
    console.log(`${c.bold}Main Model:${c.reset}          ${current.model}`);
    console.log(`${c.bold}Multi-Research:${c.reset}      ${current.multiResearch ? `${c.green}enabled${c.reset}` : `${c.gray}disabled${c.reset}`}\n`);
  } else {
    console.log(`\n${c.yellow}No provider configured yet. Run:${c.reset}`);
    console.log(`  bun run switch-provider.ts zen\n`);
  }
  process.exit(0);
}

if (args[0] === "--researchers" || args[0] === "-r") {
  const overlay = loadResearchersOverlay();
  if (!overlay) {
    console.log(`\n${c.yellow}No researchers.yaml found.${c.reset}\n`);
    process.exit(0);
  }

  const envFile = loadEnvFile();
  const stored = loadStoredIntegrations();
  const current = getCurrentProvider();

  console.log(`\n${c.bold}Multi-Provider Researcher Routing${c.reset}`);
  console.log(`${c.gray}Primary provider: ${current?.id || "none"}${c.reset}`);
  console.log(`${c.gray}Status: ${current?.multiResearch ? "ACTIVE" : "not active (use --multi-research to enable)"}${c.reset}\n`);

  let ready = 0;
  let missing = 0;

  for (const [agentName, cfg] of Object.entries(overlay.researchers)) {
    const keyFound = hasApiKey(cfg, envFile, stored);
    if (keyFound) {
      ready++;
      console.log(
        `  ${c.green}✓${c.reset} ${agentName.padEnd(26)} → ${c.cyan}${cfg.native_model}${c.reset} ${c.gray}(${cfg.api_key_env} or ${providerOf(cfg.native_model)} login found)${c.reset}`
      );
    } else {
      missing++;
      console.log(
        `  ${c.red}✗${c.reset} ${agentName.padEnd(26)} → ${c.gray}${cfg.native_model}${c.reset} ${c.red}(${cfg.api_key_env} missing)${c.reset}`
      );
      console.log(
        `    ${c.dim}Get key: ${cfg.get_key_url}${c.reset}`
      );
    }
  }

  console.log(`\n${c.bold}Summary:${c.reset} ${c.green}${ready} ready${c.reset} | ${c.red}${missing} missing keys${c.reset}`);

  if (missing > 0) {
    console.log(`\n${c.gray}Log the providers in with 'opencode auth login' (or add the keys to ~/.opencode/.env), then run:${c.reset}`);
    console.log(`  bun run switch-provider.ts ${current?.id || "anthropic"} --multi-research\n`);
  } else {
    console.log(`\n${c.green}All keys present!${c.reset} Enable with:`);
    console.log(`  bun run switch-provider.ts ${current?.id || "anthropic"} --multi-research\n`);
  }

  process.exit(0);
}

// Apply profile
const profileName = args.find((a) => !a.startsWith("--"))?.toLowerCase();
const multiResearch = args.includes("--multi-research") || args.includes("-m");

if (!profileName) {
  console.error(`\n${c.red}Error:${c.reset} No profile name provided.\n`);
  printUsage();
  process.exit(1);
}

try {
  const current = getCurrentProvider();
  const result = applyProfile(profileName, multiResearch);
  const { profile, agentCount, researcherRouted, researcherMissing } = result;

  console.log("");
  if (current?.id) {
    console.log(
      `${c.bold}Switched:${c.reset} ${c.gray}${current.id}${c.reset} → ${c.green}${profile.name}${c.reset}`
    );
  } else {
    console.log(`${c.bold}Applied:${c.reset} ${c.green}${profile.name}${c.reset}`);
  }
  console.log(`${c.bold}Model:${c.reset}     ${profile.default_model}`);
  console.log(`${c.bold}Agents:${c.reset}    ${agentCount} configured`);
  console.log(`${c.bold}Research:${c.reset}  ${multiResearch ? `${c.green}multi-provider${c.reset}` : `${c.gray}single provider${c.reset}`}`);

  // Show routed researchers
  if (researcherRouted.length > 0) {
    console.log(`\n${c.bold}Native Researchers:${c.reset}`);
    for (const r of researcherRouted) {
      console.log(`  ${c.green}✓${c.reset} ${r.agent.padEnd(26)} → ${c.cyan}${r.model}${c.reset}`);
    }
  }

  // Show missing keys (warning, not error — those researchers just stay on primary)
  if (researcherMissing.length > 0) {
    console.log(`\n${c.yellow}Missing API keys (these researchers stay on ${profile.name}):${c.reset}`);
    for (const m of researcherMissing) {
      console.log(`  ${c.yellow}○${c.reset} ${m.agent.padEnd(26)} → needs ${c.cyan}${m.keyNeeded}${c.reset}`);
      console.log(`    ${c.dim}Get key: ${m.url}${c.reset}`);
    }
  }

  console.log("");
  console.log(`${c.green}✓${c.reset} opencode.json updated`);
  console.log(`${c.green}✓${c.reset} settings.json updated`);
  console.log("");
  console.log(`${c.yellow}Restart OpenCode to apply changes.${c.reset}`);
  console.log("");
} catch (error: any) {
  console.error(`\n${c.red}Error:${c.reset} ${error.message}\n`);
  process.exit(1);
}

} // end if (isMainScript)
