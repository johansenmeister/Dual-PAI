#!/usr/bin/env bun
/**
 * pai - Personal AI CLI Tool
 *
 * Comprehensive CLI for managing OpenCode with dynamic MCP loading,
 * updates, version checking, and profile management.
 *
 * Usage:
 *   pai                  Launch OpenCode (default profile)
 *   pai -m bd            Launch with Bright Data MCP
 *   pai -m bd,ap         Launch with multiple MCPs
 *   pai -r / --resume    Resume last session
 *   pai --local          Stay in current directory (don't cd to ~/.opencode)
 *   pai update           Update OpenCode
 *   pai version          Show version info
 *   pai profiles         List available profiles
 *   pai mcp list         List available MCPs
 *   pai mcp set <profile>  Set MCP profile
 */

import { spawn, spawnSync } from "bun";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, basename } from "node:path";
import { claudeInstallKommando, installertClaude, pinnetClaudeVersjon, selvtestClaude, selvtestV2, sjekkTreet } from "./selvtest";
import type { NøkkelHelse } from "./nokkel-helse";

// ============================================================================
// Configuration
// ============================================================================

const OPENCODE_DIR = process.env.OPENCODE_DIR || join(homedir(), ".opencode");
const MCP_DIR = join(OPENCODE_DIR, "MCPs");
const ACTIVE_MCP = join(OPENCODE_DIR, ".mcp.json");
const BANNER_SCRIPT = join(OPENCODE_DIR, "PAI", "Tools", "Banner.ts");
/** `.opencode` i treet denne fila ligger i. Er det et annet enn OPENCODE_DIR, sier K40 fra. */
const EGET_TRE = join(import.meta.dir, "..", "..");

/**
 * Repo-roten, gjennom symlinken.
 *
 * `~/.opencode` ER en symlink inn i repoet, og `join()` på symlink-stien gir
 * `~/claude-plugin` — som ikke finnes. `realpathSync` er derfor påkrevd, ikke
 * defensivt. Samme felle som plugin-loaderen går i (se handover).
 */
function repoRot(): string {
  try {
    return join(realpathSync(OPENCODE_DIR), "..");
  } catch {
    return join(OPENCODE_DIR, "..");
  }
}

const CLAUDE_PLUGIN_DIR = process.env.PAI_CLAUDE_PLUGIN_DIR || join(repoRot(), "claude-plugin");

// ============================================================================
// OpenCode v2
// ============================================================================

/**
 * v1 er slettet (fase 7, 2026-09-26). `pai` er v2, og `claude` er et eget flagg.
 *
 * `--v2` godtas fortsatt og gjør ingenting, fordi det sto i runbookene og i
 * vanene fram til da. `--v1` avvises med denne meldingen framfor «Unknown
 * command»: den som skriver det, leter etter reserven, og den finnes ikke lenger.
 * `PAI_MOTOR` leses ikke.
 */
export const V1_ER_SLETTET =
  "OpenCode v1 has been removed (2026-09-26). `pai` starts v2";

/** v2-binæren, pinnet i `.opencode/package.json` (B3). `node_modules/.bin/opencode` peker hit. */
export function v2Binær(opencodeDir: string): string {
  return join(opencodeDir, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
}

/** v2-adapteren. En KATALOG med `package.json`, ikke en fil (MÅLT, fase 0). */
export function v2Adapter(opencodeDir: string): string {
  return join(opencodeDir, "pai-adapters", "opencode-v2");
}

/**
 * Kommandolinja og miljøet v2 startes med.
 *
 * Tre ting her er bærende, og testen låser alle tre:
 *
 * - **`--standalone`, alltid (B6).** Uten den går TUI-en til den delte
 *   bakgrunnstjenesten under `systemd --user`: miljøet er fra CLI-en som
 *   startet tjenesten først, så `PAI_ENABLED` herfra kommer kanskje aldri fram,
 *   og tjenesten gjenopptok krasjede økter og kjørte verktøykallene på nytt
 *   uten at noen så på (MÅLT, fase 0).
 * - **Aldri `--auto`.** Den gjør en `ask` PAI setter i `permission.evaluate`
 *   til `allow` (MÅLT). Kjernens advarsler ville blitt stille.
 * - **Adapteren registreres med `OPENCODE_CONFIG_CONTENT`**, som flettes oppå
 *   prosjektkonfigen (MÅLT), og aldri i den delte `plugin`-nøkkelen i
 *   `opencode.json`: der ville en manuell `opencode` uten `--standalone` lastet den
 *   i den delte bakgrunnstjenesten (B2, B6).
 *
 * `opencodeDir` må være realpath-et. `~/.opencode` er en symlink inn i repoet,
 * og en plugin-sti gjennom den løses ikke til repoet.
 *
 * `PAI_HARNESS` settes IKKE her. Adapteren setter den selv i `setup`, og
 * fjerner en arvet `PAI_OWNER_PID` (fase 4).
 *
 * `OPENCODE_DISABLE_AUTOUPDATE=1`, alltid (#198). Uten den tilbyr TUI-en
 * «/update to install …» forbi pinningen, og `/update` svarer «Installation
 * method not found» (MÅLT 2026-10-04, 2.0.18: binæren uendret). Den lover noe
 * som ikke virker, og en ny bruker ser den i første økt. Variabelen gir «update
 * check skipped reason=disabled» i loggen; `autoupdate: false` i
 * `OPENCODE_CONFIG_CONTENT` gjorde det ikke, og installeren skriver
 * `opencode.json` uten nøkkelen. En bump er bevisst uansett (`pai update`).
 *
 * `--prompt` går rett til TUI-en, som sender meldingen med en gang (MÅLT 2.0.22;
 * 2.0.18 fylte den bare inn). Slik starter `install.sh` kjøreplanen (#162).
 */
export function v2Oppstart(
  opencodeDir: string,
  options: { resume?: boolean; prompt?: string },
  env: NodeJS.ProcessEnv = process.env
): { args: string[]; env: Record<string, string> } {
  const args = [env.PAI_OPENCODE2_BIN || v2Binær(opencodeDir), "--standalone"];
  if (options.resume) args.push("--continue");
  if (options.prompt) args.push("--prompt", options.prompt);

  const miljø: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) miljø[k] = v;
  miljø.PAI_ENABLED = "1";
  miljø.OPENCODE_DISABLE_AUTOUPDATE = "1";
  miljø.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: [v2Adapter(opencodeDir)] });

  return { args, env: miljø };
}

/**
 * Hvordan `pai --claude` starter Claude Code.
 *
 * KONTEKSTEN GÅR SOM SYSTEMPROMPT, ikke gjennom SessionStart-hooken (K-10).
 * Claude Code legger hook-kontekst over 10 000 tegn i en fil og gir modellen
 * bare de første 2 KB (MÅLT 2.1.283, konstanten er fast i binæren). PAI-
 * konteksten er 26 KB hjemme og 40 KB på jobb, så algoritmen, identiteten og
 * skill-registeret nådde aldri modellen. `--append-system-prompt-file` har
 * ingen slik grense, hopes ikke opp og overlever kompaktering, som systemdelen
 * i v2. Det er også slik LifeOS (oppstrøms) gjør det.
 *
 * `PAI_CONTEXT_FILE` forteller hookene at konteksten allerede er der, så
 * SessionStart ikke injiserer den en gang til.
 */
export function claudeOppstart(
  claudeBin: string,
  pluginDir: string,
  kontekstFil: string | null,
  options: { resume?: boolean },
  env: NodeJS.ProcessEnv = process.env
): { args: string[]; env: Record<string, string> } {
  const args = [claudeBin, "--plugin-dir", pluginDir];
  const miljø: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) miljø[k] = v;
  delete miljø.PAI_CONTEXT_FILE;
  if (kontekstFil) {
    args.push("--append-system-prompt-file", kontekstFil);
    miljø.PAI_CONTEXT_FILE = kontekstFil;
  }
  // Claude Code: -c/--continue gjenopptar siste økt, som OpenCode.
  if (options.resume) args.push("--continue");
  miljø.PAI_ENABLED = "1";
  miljø.PAI_HARNESS = "claude";
  return { args, env: miljø };
}

/**
 * Kjenner `claude` flagget? Svaret leses av en fil som ikke finnes (MÅLT 2.1.283):
 * flagget finnes → «Append system prompt file not found», ukjent → «unknown
 * option». `--help` nevner det bare som `--append-system-prompt[-file]`, og
 * `--version` kortslutter før opsjonene sjekkes, så ingen av dem kan brukes.
 * Alt annet er «ukjent», ikke «nei»: en sjekk som roper feil, er verre enn ingen.
 */
export function tolkFlaggsjekk(stderr: string): "ja" | "nei" | "ukjent" {
  if (stderr.includes("Append system prompt file not found")) return "ja";
  if (/unknown option '--append-system-prompt-file'/.test(stderr)) return "nei";
  return "ukjent";
}

/**
 * Bygg PAI-konteksten til en privat fil for `--append-system-prompt-file`.
 *
 * Samme kjernefunksjon som hooken og v2 bruker, så innholdet er det samme i
 * begge motorene. Katalogen er `mkdtemp` (0700) og fila 0600: den inneholder
 * TELOS og identiteten. Null når konteksten ikke lot seg bygge; da faller
 * hooken tilbake på seg selv, og sier fra hvis den er for stor.
 */
async function byggClaudeKontekst(): Promise<{ fil: string; katalog: string } | null> {
  try {
    const { loadUserSystemContext } = await import(
      join(repoRot(), ".opencode", "pai-core", "dispatch", "context.ts")
    );
    const res = await loadUserSystemContext();
    if (!res?.context) return null;
    const katalog = mkdtempSync(join(tmpdir(), "pai-claude-"));
    const fil = join(katalog, "kontekst.md");
    writeFileSync(fil, res.context, { mode: 0o600 });
    return { fil, katalog };
  } catch (e) {
    log(`Could not build the context — the hook will try on its own: ${e instanceof Error ? e.message : String(e)}`, "⚠️");
    return null;
  }
}

/** Pinnet versjon av `@opencode/cli` i `.opencode/package.json`, eller null. */
function pinnetV2Versjon(opencodeDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(opencodeDir, "package.json"), "utf-8"));
    return pkg?.dependencies?.["@opencode/cli"] ?? null;
  } catch {
    return null;
  }
}

/** Installert v2-versjon, fra binæren selv. Null hvis den mangler eller ikke kjører. */
function installertV2Versjon(opencodeDir: string): string | null {
  const bin = v2Binær(opencodeDir);
  if (!existsSync(bin)) return null;
  // stdin fra /dev/null: binæren henger av og til på en stdin som ikke er en TTY.
  const r = spawnSync([bin, "--version"], { stdin: "ignore" });
  const m = r.stdout.toString().match(/([0-9]+\.[0-9]+\.[0-9]+)/);
  return m ? m[1] : null;
}
const LOCAL_CLAUDE_BIN = join(homedir(), ".local", "bin", "claude");
const WALLPAPER_DIR = join(homedir(), "Projects", "Wallpaper");
// Note: RAW archiving removed - OpenCode handles its own cleanup (30-day retention in projects/)

// MCP shorthand mappings
const MCP_SHORTCUTS: Record<string, string> = {
  bd: "Brightdata-MCP.json",
  brightdata: "Brightdata-MCP.json",
  ap: "Apify-MCP.json",
  apify: "Apify-MCP.json",
  cu: "ClickUp-MCP.json",
  clickup: "ClickUp-MCP.json",
  chrome: "chrome-enabled.mcp.json",
  dev: "dev-work.mcp.json",
  sec: "security.mcp.json",
  security: "security.mcp.json",
  research: "research.mcp.json",
  full: "full.mcp.json",
  min: "minimal.mcp.json",
  minimal: "minimal.mcp.json",
  none: "none.mcp.json",
};

// Profile descriptions
const PROFILE_DESCRIPTIONS: Record<string, string> = {
  none: "No MCPs (maximum performance)",
  minimal: "Essential MCPs (content, daemon, Foundry)",
  "chrome-enabled": "Essential + Chrome DevTools",
  "dev-work": "Development tools (Shadcn, Codex, Supabase)",
  security: "Security tools (httpx, naabu)",
  research: "Research tools (Brightdata, Apify, Chrome)",
  clickup: "Official ClickUp MCP (tasks, time tracking, docs)",
  full: "All available MCPs",
};

// ============================================================================
// Utilities
// ============================================================================

function log(message: string, emoji = "") {
  console.log(emoji ? `${emoji} ${message}` : message);
}


function error(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function displayBanner(engine: "opencode" | "claude") {
  if (existsSync(BANNER_SCRIPT)) {
    // Bunen som kjører launcheren, ikke `bun` fra PATH: `pai()` kaller den med
    // full sti fordi `~/.bun/bin` ikke alltid er på PATH, og da kastet
    // `spawnSync` ENOENT her, før motoren startet.
    spawnSync([process.execPath, BANNER_SCRIPT, `--engine=${engine}`], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  }
}

/**
 * Kjører `<navn> --version` fra PATH. Buns `spawnSync` KASTER ENOENT når
 * navnet ikke finnes på PATH, og returnerer ikke en exit-kode, så uten
 * fangsten fikk brukeren en stacktrace i stedet for meldingen under.
 */
function finnesPåPath(navn: string): boolean {
  try {
    return spawnSync([navn, "--version"], { stdin: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

function resolveClaudeExecutable(): string {
  // Overstyring finnes for to grunner: en `claude` på uvanlig sti, og for at
  // launcheren skal kunne røyktestes uten å starte en interaktiv TUI.
  if (process.env.PAI_CLAUDE_BIN) return process.env.PAI_CLAUDE_BIN;

  const isExecutable = (path: string): boolean => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (existsSync(LOCAL_CLAUDE_BIN) && isExecutable(LOCAL_CLAUDE_BIN)) {
    return LOCAL_CLAUDE_BIN;
  }

  if (finnesPåPath("claude")) {
    return "claude";
  }

  error("Could not find the claude executable. Install Claude Code first.");
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

// ============================================================================
// MCP Management
// ============================================================================

function getMcpProfiles(): string[] {
  if (!existsSync(MCP_DIR)) return [];
  return readdirSync(MCP_DIR)
    .filter((f) => f.endsWith(".mcp.json"))
    .map((f) => f.replace(".mcp.json", ""));
}

function getIndividualMcps(): string[] {
  if (!existsSync(MCP_DIR)) return [];
  return readdirSync(MCP_DIR)
    .filter((f) => f.endsWith("-MCP.json"))
    .map((f) => f.replace("-MCP.json", ""));
}

function getCurrentProfile(): string | null {
  if (!existsSync(ACTIVE_MCP)) return null;
  try {
    const stats = lstatSync(ACTIVE_MCP);
    if (stats.isSymbolicLink()) {
      // For symlink, we need the real target name
      const realpath = Bun.spawnSync(["readlink", ACTIVE_MCP]).stdout.toString().trim();
      return basename(realpath).replace(".mcp.json", "");
    }
    return "custom";
  } catch {
    return null;
  }
}

function mergeMcpConfigs(mcpFiles: string[]): { mcpServers: Record<string, unknown> } {
  const merged: { mcpServers: Record<string, unknown> } = { mcpServers: {} };

  for (const file of mcpFiles) {
    const filepath = join(MCP_DIR, file);
    if (!existsSync(filepath)) {
      log(`Warning: MCP file not found: ${file}`, "⚠️");
      continue;
    }
    try {
      const config = JSON.parse(readFileSync(filepath, "utf-8"));
      if (config.mcpServers) {
        Object.assign(merged.mcpServers, config.mcpServers);
      }
    } catch {
      log(`Warning: Failed to parse ${file}`, "⚠️");
    }
  }

  return merged;
}

function setMcpProfile(profile: string) {
  const profileFile = join(MCP_DIR, `${profile}.mcp.json`);
  if (!existsSync(profileFile)) {
    error(`Profile '${profile}' not found`);
  }

  // Remove existing
  if (existsSync(ACTIVE_MCP)) {
    unlinkSync(ACTIVE_MCP);
  }

  // Create symlink
  symlinkSync(profileFile, ACTIVE_MCP);
  log(`Switched to '${profile}' profile`, "✅");
  log("Restart OpenCode to apply", "⚠️");
}

function setMcpCustom(mcpNames: string[]) {
  const files: string[] = [];

  for (const name of mcpNames) {
    const file = MCP_SHORTCUTS[name.toLowerCase()];
    if (file) {
      files.push(file);
    } else {
      // Try direct file match
      const directFile = `${name}-MCP.json`;
      const profileFile = `${name}.mcp.json`;
      if (existsSync(join(MCP_DIR, directFile))) {
        files.push(directFile);
      } else if (existsSync(join(MCP_DIR, profileFile))) {
        files.push(profileFile);
      } else {
        error(`Unknown MCP: ${name}`);
      }
    }
  }

  const merged = mergeMcpConfigs(files);

  // Remove symlink if exists, write new file
  if (existsSync(ACTIVE_MCP)) {
    unlinkSync(ACTIVE_MCP);
  }
  writeFileSync(ACTIVE_MCP, JSON.stringify(merged, null, 2));

  const serverCount = Object.keys(merged.mcpServers).length;
  if (serverCount > 0) {
    log(`Configured ${serverCount} MCP server(s): ${mcpNames.join(", ")}`, "✅");
  }
}

// ============================================================================
// Wallpaper Management
// ============================================================================

function getWallpapers(): string[] {
  if (!existsSync(WALLPAPER_DIR)) return [];
  return readdirSync(WALLPAPER_DIR)
    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort();
}

function getWallpaperName(filename: string): string {
  return basename(filename).replace(/\.(png|jpg|jpeg|webp)$/i, "");
}

function findWallpaper(query: string): string | null {
  const wallpapers = getWallpapers();
  const queryLower = query.toLowerCase();

  // Exact match (without extension)
  const exact = wallpapers.find((w) => getWallpaperName(w).toLowerCase() === queryLower);
  if (exact) return exact;

  // Partial match
  const partial = wallpapers.find((w) => getWallpaperName(w).toLowerCase().includes(queryLower));
  if (partial) return partial;

  // Fuzzy: any word match
  const words = queryLower.split(/[-_\s]+/);
  const fuzzy = wallpapers.find((w) => {
    const name = getWallpaperName(w).toLowerCase();
    return words.some((word) => name.includes(word));
  });
  return fuzzy || null;
}

function setWallpaper(filename: string): boolean {
  const fullPath = join(WALLPAPER_DIR, filename);
  if (!existsSync(fullPath)) {
    log(`Wallpaper not found: ${fullPath}`, "❌");
    return false;
  }

  let success = true;

  // Set Kitty background
  try {
    const kittyResult = spawnSync(["kitty", "@", "set-background-image", fullPath]);
    if (kittyResult.exitCode === 0) {
      log("Kitty background set", "✅");
    } else {
      log("Failed to set Kitty background", "⚠️");
      success = false;
    }
  } catch {
    log("Kitty not available", "⚠️");
  }

  // Set macOS desktop background
  try {
    // Escape path for AppleScript: backslashes and double quotes must be escaped
    // to prevent injection via malicious filenames containing special characters.
    const safePath = fullPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `tell application "System Events" to tell every desktop to set picture to "${safePath}"`;
    const macResult = spawnSync(["osascript", "-e", script]);
    if (macResult.exitCode === 0) {
      log("macOS desktop set", "✅");
    } else {
      log("Failed to set macOS desktop", "⚠️");
      success = false;
    }
  } catch {
    log("Could not set macOS desktop", "⚠️");
  }

  return success;
}

function cmdWallpaper(args: string[]) {
  const wallpapers = getWallpapers();

  if (wallpapers.length === 0) {
    error(`No wallpapers found in ${WALLPAPER_DIR}`);
  }

  // No args or --list: show available wallpapers
  if (args.length === 0 || args[0] === "--list" || args[0] === "-l" || args[0] === "list") {
    log("Available wallpapers:", "🖼️");
    console.log();
    wallpapers.forEach((w, i) => {
      console.log(`  ${i + 1}. ${getWallpaperName(w)}`);
    });
    console.log();
    log("Usage: pai -w <name>", "💡");
    log("Example: pai -w circuit-board", "💡");
    return;
  }

  // Find and set the wallpaper
  const query = args.join(" ");
  const match = findWallpaper(query);

  if (!match) {
    log(`No wallpaper matching "${query}"`, "❌");
    console.log("\nAvailable wallpapers:");
    wallpapers.forEach((w) => {
      console.log(`  - ${getWallpaperName(w)}`);
    });
    process.exit(1);
  }

  const name = getWallpaperName(match);
  log(`Switching to: ${name}`, "🖼️");

  const success = setWallpaper(match);
  if (success) {
    log(`Wallpaper set to ${name}`, "✅");
  } else {
    error("Failed to set wallpaper");
  }
}


// ============================================================================
// Commands
// ============================================================================

/**
 * Start Claude Code med PAI-pluginen.
 *
 * MÅLT (batch 6): `--plugin-dir` er et SESJONSFLAGG på `claude`, ikke et flagg
 * på `claude plugin install`, og den kopierer ingenting — `CLAUDE_PLUGIN_ROOT`
 * peker rett på kildekatalogen. Launcheren trenger derfor bare å sende
 * flagget; et regenerert artefakt tar effekt uten reinstall.
 *
 * `PAI_ENABLED=1` settes HER og ikke i `settings.json`: nøkkelen er porten
 * til kontekstinjeksjonen, og i settings ville den slått PAI på for hver
 * Claude Code-økt på maskinen.
 */
async function launchClaude(options: { resume?: boolean; local?: boolean; mcp?: string }): Promise<number> {
  if (!existsSync(CLAUDE_PLUGIN_DIR)) {
    error(`Plugin directory missing: ${CLAUDE_PLUGIN_DIR}\nRun: pai claude sync`);
  }

  // Selvtesten (C1, C2): er installert den pinnede versjonen, er
  // selvoppdateringen av, og er ClaudeSmoke kjørt mot pinningen? Taus når alt
  // stemmer, og starter motoren uansett, se `selvtest.ts`.
  const varsler = [...sjekkTreet(OPENCODE_DIR, EGET_TRE), ...selvtestClaude(realpathSync(OPENCODE_DIR), repoRot()).varsler];
  for (const varsel of varsler) log(`PAI: ${varsel}`, "⚠️");

  // Den kompilerte hook-binæren bygges HER, ikke i hver hook. Sjekken koster
  // 11 ms og bygget ~900 ms, og begge deler betales én gang per økt framfor
  // på hvert eneste verktøykall. Gevinsten er målt: 74 → 30 ms per hook.
  //
  // Et feilet bygg er IKKE fatalt. Shell-oppstarteren faller tilbake på
  // `bun bin/pai-hook.ts`, så PAI virker — bare tregere. Å nekte å starte
  // fordi en optimalisering ikke lot seg bygge ville vært feil avveining.
  try {
    const { byggHvisStale } = await import(join(repoRot(), "Tools", "BuildClaudeHook.ts"));
    const bygget = await byggHvisStale(repoRot());
    if (bygget) log(`Rebuilt the hook binary (${bygget.ms} ms)`, "🔧");
  } catch (e) {
    log(`Could not build the hook binary — running from source: ${e instanceof Error ? e.message : String(e)}`, "⚠️");
  }

  if (options.mcp) {
    // MCP-profilene er OpenCodes `.mcp.json`-bytting. Claude-siden får sin
    // MCP-server fra pluginen, og profilene gjelder ikke der.
    log("--mcp only applies to OpenCode — ignored", "⚠️");
  }

  const kontekst = await byggClaudeKontekst();
  const oppstart = claudeOppstart(resolveClaudeExecutable(), CLAUDE_PLUGIN_DIR, kontekst?.fil ?? null, options);

  if (!options.local) {
    process.chdir(OPENCODE_DIR);
  }

  const proc = spawn(oppstart.args, {
    stdio: ["inherit", "inherit", "inherit"],
    env: oppstart.env,
  });

  await proc.exited;
  if (kontekst) rmSync(kontekst.katalog, { recursive: true, force: true });
  return motorensExitkode(proc.exitCode);
}

/** `pai claude sync` — regenerer plugin-artefaktene og flett settings. */
async function cmdClaudeSync() {
  const rot = repoRot();
  log("Regenerating plugin artifacts...", "🔧");

  const { byggPlan, skrivPlan } = await import(join(rot, "Tools", "BuildClaudePlugin.ts"));
  const plan = await byggPlan(rot);
  await skrivPlan(rot, plan);
  log(`Wrote ${plan.filer.length} files and ${plan.lenker.length} symlinks`, "✅");

  try {
    const { byggHookBinær } = await import(join(rot, "Tools", "BuildClaudeHook.ts"));
    const b = await byggHookBinær(rot);
    log(`Built the hook binary: ${(b.bytes / 1024 / 1024).toFixed(1)} MB in ${b.ms} ms`, "✅");
  } catch (e) {
    log(`The hook binary could not be built — hooks run from source: ${e instanceof Error ? e.message : String(e)}`, "⚠️");
  }

  const { patch } = await import(join(rot, "Tools", "PatchClaudeSettings.ts"));
  const endringer = patch();
  const lagtTil = endringer.filter((e: { utfall: string }) => e.utfall === "lagt-til");
  const avvik = endringer.filter((e: { utfall: string }) => e.utfall === "avvik");

  for (const e of avvik) {
    log(`${e.nøkkel}: is “${e.nåværende}”, PAI wants “${e.ønsket}” — leaving it alone`, "⚠️");
  }
  if (lagtTil.length === 0) {
    log("settings.json was already up to date", "✅");
  } else {
    for (const e of lagtTil) console.log(`  + ${e.nøkkel}=${e.ønsket}`);
    log(`Wrote ${lagtTil.length} key(s) to settings.json`, "✅");
  }
}

/**
 * `pai doctor` — det harnesset sjekker på forespørsel, uten å endre noe.
 *
 * Doctor-laget i handoverens ramme: det som er for dyrt eller for sjeldent for
 * øktstart. Selvtesten er med, så én kommando viser alt, og modellregisteret
 * (K29) kommer i tillegg. Avslutter med 1 når noe må rettes; varsler alene gir 0.
 * Claude-siden: selvtesten (C1, C2) her, resten i `pai claude doctor`.
 * En ny seksjon trenger en rad i `tests/pai-doctor.test.ts` (K51), og en
 * melding den testen kan fremkalle fra temp-treet.
 */
async function cmdDoctor() {
  const dir = realpathSync(OPENCODE_DIR);
  let feil = 0;
  const nei = (m: string) => {
    console.log(`  ❌ ${m}`);
    feil++;
  };

  console.log("\nThe launcher (K40: the tree PAI loads from)");
  const tre = sjekkTreet(OPENCODE_DIR, EGET_TRE);
  for (const varsel of tre) nei(varsel);
  if (tre.length === 0) console.log(`  ✅ ${dir}`);

  console.log("\nOpenCode v2 (self-test: binary, pinning, smoke test, v1, plugin leftovers)");
  const selvtest = selvtestV2(dir, repoRot());
  if (selvtest.stopp) nei(selvtest.stopp);
  for (const varsel of selvtest.varsler) nei(varsel);
  if (!selvtest.stopp && selvtest.varsler.length === 0) console.log("  ✅ no issues");

  console.log("\nModel registry (the models in the profiles and the config exist in the v2 catalog)");
  try {
    const { helsesjekkHer } = await import(join(dir, "tools", "model-sync.ts"));
    const h = helsesjekkHer() as { problemer: string[]; varsler: string[] };
    for (const p of h.problemer) nei(p);
    for (const v of h.varsler) console.log(`  ⚠️  ${v}`);
    if (h.problemer.length === 0) console.log("  ✅ every referenced model exists");
  } catch (e) {
    nei(`could not read the registry: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\nv2 database (K10: free pages after the migration)");
  try {
    const { dbHelse } = await import(join(dir, "PAI", "Tools", "db-helse.ts"));
    const h = dbHelse() as { varsler: string[]; ledig: number | null; totalt: number | null };
    for (const v of h.varsler) console.log(`  ⚠️  ${v}`);
    if (h.varsler.length === 0)
      console.log(h.totalt === null ? "  ✅ no opencode.db to check" : `  ✅ ${Math.round(h.totalt / 2 ** 20)} MB, below the threshold`);
  } catch (e) {
    nei(`could not read the database: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\nMCP servers (K26: both engines have them, K32: the local ones start)");
  try {
    const { mcpHelse } = await import(join(dir, "PAI", "Tools", "mcp-helse.ts"));
    const h = (await mcpHelse(dir)) as { problemer: string[]; varsler: string[] };
    for (const p of h.problemer) nei(p);
    for (const v of h.varsler) console.log(`  ⚠️  ${v}`);
    if (h.problemer.length === 0) console.log("  ✅ no issues");
  } catch (e) {
    nei(`could not check the MCP servers: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\nHandlers that run without effect (K5, the latest completed work sessions)");
  try {
    const { effektHelse } = await import(join(dir, "PAI", "Tools", "effekt-helse.ts"));
    const h = effektHelse(join(dir, "MEMORY", "WORK")) as { problemer: string[]; økter: number };
    for (const p of h.problemer) nei(p);
    if (h.problemer.length === 0) console.log(`  ✅ no issues (${h.økter} sessions with markers)`);
  } catch (e) {
    nei(`could not read the effect markers: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\nRead-only mirrors (K57: no local changes before the next sync)");
  try {
    const { speilHelse } = await import(join(dir, "PAI", "Tools", "speil-helse.ts"));
    const h = speilHelse(dir) as { problemer: string[]; varsler: string[]; stier: number; repoer: number };
    for (const p of h.problemer) nei(p);
    for (const v of h.varsler) console.log(`  ⚠️  ${v}`);
    if (h.problemer.length === 0)
      console.log(h.stier === 0 ? "  ✅ no paths in PAI/USER/SKRIVEBESKYTTET.json" : `  ✅ ${h.repoer} repo(s) clean`);
  } catch (e) {
    nei(`could not check the mirrors: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\nThe keys in .env (#162: the full list with pai keys)");
  try {
    const { nøkkelHelse } = await import(join(dir, "PAI", "Tools", "nokkel-helse.ts"));
    const h = nøkkelHelse(dir, homedir()) as NøkkelHelse;
    for (const p of h.problemer) nei(p);
    for (const v of h.varsler) console.log(`  ⚠️  ${v}`);
    if (h.problemer.length === 0 && h.varsler.length === 0) {
      const alle = h.grupper.flatMap((g) => g.nøkler);
      console.log(
        h.envFinnes
          ? `  ✅ ${alle.filter((n) => n.satt).length} of ${alle.length} set, no issues`
          : "  ✅ no .env yet (every key is optional)"
      );
    }
  } catch (e) {
    nei(`could not check the keys: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\nClaude Code (self-test: pinning, self-update, smoke test; the rest in pai claude doctor)");
  const claude = selvtestClaude(dir, repoRot());
  for (const varsel of claude.varsler) nei(varsel);
  if (claude.varsler.length === 0) console.log("  ✅ no issues");

  console.log();
  if (feil === 0) {
    log("Nothing to fix", "✅");
  } else {
    log(`${feil} problem(s)`, "❌");
    process.exit(1);
  }
}

/**
 * `pai keys` — hvilke nøkler i `.env` som er satt, gruppert etter `.env.example`.
 * Viser aldri en verdi. For brukeren som fyller ut fila, og for kjøreplanen.
 */
async function cmdKeys() {
  const dir = realpathSync(OPENCODE_DIR);
  const { nøkkelHelse } = await import(join(dir, "PAI", "Tools", "nokkel-helse.ts"));
  const h = nøkkelHelse(dir, homedir()) as NøkkelHelse;
  console.log(`\nKeys in ${h.env} (values are never shown)`);
  if (!h.envFinnes) console.log(`  No .env yet. Start from the template: cp ${dir}/.env.example ${h.env}`);
  for (const g of h.grupper) {
    console.log(`\n${g.navn}`);
    for (const n of g.nøkler) console.log(`  ${n.satt ? "✅" : "· "} ${n.navn}`);
  }
  const alle = h.grupper.flatMap((g) => g.nøkler);
  console.log(`\n${alle.filter((n) => n.satt).length} of ${alle.length} set. Every key is optional.`);
  for (const p of h.problemer) console.log(`  ❌ ${p}`);
  for (const v of h.varsler) console.log(`  ⚠️  ${v}`);
}

/** `pai claude doctor` — sjekk uten å endre noe. */
async function cmdClaudeDoctor() {
  const rot = repoRot();
  let feil = 0;
  const ok = (m: string) => console.log(`  ✅ ${m}`);
  const nei = (m: string) => {
    console.log(`  ❌ ${m}`);
    feil++;
  };

  console.log("\nClaude Code");
  let ver: ReturnType<typeof spawnSync> | null = null;
  try {
    ver = spawnSync(["claude", "--version"], { stdin: "ignore" });
  } catch {
    // ENOENT kastes, se `finnesPåPath`.
  }
  if (ver?.exitCode === 0) {
    ok(`binary: ${new TextDecoder().decode(ver.stdout).trim()}`);
    const selvtest = selvtestClaude(realpathSync(OPENCODE_DIR), rot).varsler;
    for (const varsel of selvtest) nei(varsel);
    if (selvtest.length === 0) ok("pinned, self-update off, and ClaudeSmoke has passed against this version");
    // K-10: konteksten går som systemprompt. Uten prompt kan dette aldri bli
    // et modellkall («Input must be provided»); se `tolkFlaggsjekk`.
    const sjekk = spawnSync(["claude", "--append-system-prompt-file", "/finnes/ikke/pai-doctor.md", "-p"], {
      stdin: "ignore",
      timeout: 10_000,
    });
    const svar = tolkFlaggsjekk(new TextDecoder().decode(sjekk.stderr));
    if (svar === "ja") ok("--append-system-prompt-file (the context goes in as the system prompt)");
    else if (svar === "nei") nei("`claude` does not know --append-system-prompt-file — bump the pinning, see: pai update");
    else console.log("  ⚠️  could not tell whether `claude` has --append-system-prompt-file");
  } else {
    nei("`claude` not found on PATH");
  }

  console.log("\nPlugin");
  if (existsSync(CLAUDE_PLUGIN_DIR)) ok(`directory: ${CLAUDE_PLUGIN_DIR}`);
  else nei(`directory missing: ${CLAUDE_PLUGIN_DIR}`);

  for (const rel of [".claude-plugin/plugin.json", "hooks/hooks.json", ".mcp.json", "bin/pai-hook", "bin/pai-mcp"]) {
    if (existsSync(join(CLAUDE_PLUGIN_DIR, rel))) ok(rel);
    else nei(`missing: ${rel}`);
  }

  console.log("\nHook binary");
  try {
    const { sjekkFerskhet } = await import(join(rot, "Tools", "BuildClaudeHook.ts"));
    const f = sjekkFerskhet(rot);
    if (!f.finnes) {
      console.log("  ⚠️  not built — hooks run from source (74 ms/call vs 30)");
    } else if (f.fersk) {
      ok("built and fresh");
    } else {
      nei(
        `STALE: the source is ${Math.round((f.nyesteKilde - f.bygget) / 1000)} s newer than the binary — run: pai claude sync`
      );
    }
  } catch (e) {
    nei(`could not check the binary: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\nGenerated artifacts");
  try {
    const { byggPlan, finnDrift } = await import(join(rot, "Tools", "BuildClaudePlugin.ts"));
    const plan = await byggPlan(rot);
    const avvik = await finnDrift(rot, plan);
    if (avvik.length === 0) {
      ok(`the mirror is fresh (${plan.filer.length} files, ${plan.lenker.length} links)`);
    } else {
      nei(`${avvik.length} differences between source and mirror — run: pai claude sync`);
      for (const linje of avvik.slice(0, 5)) console.log(`     ${linje}`);
    }
  } catch (e) {
    nei(`could not build the plan: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\nsettings.json");
  try {
    const { patch, standardSti } = await import(join(rot, "Tools", "PatchClaudeSettings.ts"));
    for (const e of patch(standardSti(), true) as Array<{
      nøkkel: string;
      utfall: string;
      ønsket: string;
      nåværende?: string;
    }>) {
      if (e.utfall === "uendret") ok(`${e.nøkkel}=${e.ønsket}`);
      else if (e.utfall === "lagt-til") nei(`${e.nøkkel} missing — run: pai claude sync`);
      else console.log(`  ⚠️  ${e.nøkkel}: is “${e.nåværende}”, PAI wants “${e.ønsket}”`);
    }
  } catch (e) {
    nei(`${e instanceof Error ? e.message : String(e)}`);
  }

  console.log();
  if (feil === 0) {
    log("The Claude side is ready", "✅");
  } else {
    log(`${feil} problem(s)`, "❌");
    process.exit(1);
  }
}

/**
 * Start OpenCode v2 med PAI-adapteren. Formen står i `v2Oppstart`.
 *
 * stdin arves: TUI-en trenger terminalen. Fellen fra fase 0 var `run` med en
 * stdin som aldri gir EOF, ikke en TTY.
 */
async function launchV2(options: { resume?: boolean; local?: boolean; prompt?: string }): Promise<number> {
  const dir = realpathSync(OPENCODE_DIR);
  const oppstart = v2Oppstart(dir, options);

  // Selvtesten (K4, K9, K11). Taus når alt er i orden, se `selvtest.ts`.
  const selvtest = selvtestV2(dir, repoRot());
  if (selvtest.stopp) error(selvtest.stopp);
  const varsler = [...sjekkTreet(OPENCODE_DIR, EGET_TRE), ...selvtest.varsler];
  if (varsler.length > 0) {
    for (const varsel of varsler) log(`PAI: ${varsel}`, "⚠️");
    // TUI-en dekker terminalen straks den starter, og da står varselet bak
    // den til økten er over. Det er for sent for en røyktest som mangler.
    // Linja leses av et barn, så stdin aldri har vært åpnet her når TUI-en
    // arver den.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      log("Press Enter to start anyway, Ctrl+C to abort", "↵");
      spawnSync(["sh", "-c", "read -r _"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    }
  }

  if (!options.local) {
    process.chdir(OPENCODE_DIR);
  }

  const proc = spawn(oppstart.args, {
    stdio: ["inherit", "inherit", "inherit"],
    env: oppstart.env,
  });

  await proc.exited;
  return motorensExitkode(proc.exitCode);
}

/**
 * Launcherens exitkode er motorens (M-51). Før rettingen avsluttet `pai` med 0
 * uansett, så et skript, og røyktestens exitsjekk gjennom launcheren, så en
 * motor som feilet som en som lyktes. `null` er en motor drept av et signal.
 */
export function motorensExitkode(exitCode: number | null): number {
  return exitCode ?? 1;
}

async function cmdLaunch(options: {
  mcp?: string;
  resume?: boolean;
  local?: boolean;
  claude?: boolean;
  prompt?: string;
}): Promise<number> {
  // CLAUDE.md is now static — no build step needed.
  // Algorithm spec is loaded on-demand when Algorithm mode triggers.
  // (InstantiatePAI.ts is retired — kept for reference only)

  displayBanner(options.claude ? "claude" : "opencode");

  if (options.claude) {
    if (options.prompt) error("--prompt only applies to v2: `pai --prompt <text>`");
    return launchClaude(options);
  }

  // Handle MCP configuration
  if (options.mcp) {
    const mcpNames = options.mcp.split(",").map((s) => s.trim());
    setMcpCustom(mcpNames);
  }

  return launchV2(options);
}

/**
 * Ingen av motorene oppdateres herfra. `opencode upgrade` ville byttet binæren
 * bak pinningen (B3), og v2 validerer ikke hooknavn: et navn som endres i en
 * patch, feiler stille. Claude Code er pinnet på samme måte (C1): K-10 var en
 * versjon som kuttet PAI-konteksten uten at noe ble rødt. En bump er en
 * bevisst handling med røyktest.
 */
function cmdUpdate() {
  const dir = realpathSync(OPENCODE_DIR);
  const claude = installertClaude();
  const pinnetClaude = pinnetClaudeVersjon(dir) ?? "?";
  log(`v2 is pinned exactly: @opencode/cli ${pinnetV2Versjon(dir) ?? "?"} (installed: ${installertV2Versjon(dir) ?? "missing"})`, "📌");
  log(`Claude Code is pinned exactly: ${pinnetClaude} (installed: ${claude?.versjon ?? "missing"})`, "📌");
  console.log(`
A bump is done by hand, on a branch, and never with \`opencode upgrade\` or \`claude update\`.

OpenCode v2:
  1. change @opencode/cli and @opencode/plugin in ${join(dir, "package.json")}
  2. cd ${dir} && bun install
  3. cd ${repoRot()} && bun Tools/V2Smoke.ts   (must be green before commit)

Claude Code:
  1. change pai.claudeCode in ${join(dir, "package.json")}
  2. ${claudeInstallKommando(claude?.form ?? "installer", "<new version>")}
  3. cd ${repoRot()} && bun Tools/ClaudeSmoke.ts   (must be green before commit)

Commit the pinning and the receipt together. The other machines are told by
the self-test after \`git pull\`, with the command that installs the new version.
`);
}

async function getLatestV2Version(): Promise<string | null> {
  try {
    const response = await fetch("https://registry.npmjs.org/@opencode/cli/latest");
    const data = (await response.json()) as { version?: string };
    if (data?.version && /^[0-9]+\.[0-9]+\.[0-9]+/.test(data.version)) return data.version;
  } catch {
    return null;
  }
  return null;
}

async function getLatestClaudeVersion(): Promise<string | null> {
  try {
    const response = await fetch("https://registry.npmjs.org/@anthropic-ai/claude-code/latest");
    const data = (await response.json()) as { version?: string };
    if (data?.version && /^[0-9]+\.[0-9]+\.[0-9]+/.test(data.version)) return data.version;
  } catch {
    return null;
  }
  return null;
}

async function cmdVersion() {
  log("Checking versions...", "🔍");

  const dir = realpathSync(OPENCODE_DIR);
  const installert = installertV2Versjon(dir);
  const pinnet = pinnetV2Versjon(dir);
  const siste = await getLatestV2Version();
  console.log(`Installed:  ${installert ? `v${installert}` : "missing"}`);
  console.log(`Pinned:     ${pinnet ? `v${pinnet}` : "?"}`);
  if (siste) console.log(`Latest:     v${siste}`);
  if (!installert || installert !== pinnet) {
    log(`Installed is not the pinned version — run: cd ${dir} && bun install`, "⚠️");
  } else if (siste && compareVersions(installert, siste) < 0) {
    log("A newer v2 exists — bump deliberately, see: pai update", "ℹ️");
  } else {
    log("Pinned and installed match", "✅");
  }

  console.log("\nClaude Code");
  const claude = installertClaude();
  const pinnetClaude = pinnetClaudeVersjon(dir);
  const sisteClaude = await getLatestClaudeVersion();
  console.log(`Installed:  ${claude ? `v${claude.versjon} (${claude.form})` : "missing"}`);
  console.log(`Pinned:     ${pinnetClaude ? `v${pinnetClaude}` : "?"}`);
  if (sisteClaude) console.log(`Latest:     v${sisteClaude}`);
  if (!claude) {
    log("Claude Code is not installed — see SETUP.md, step 5", "ℹ️");
  } else if (pinnetClaude && claude.versjon !== pinnetClaude) {
    log(`Installed is not the pinned version — run: ${claudeInstallKommando(claude.form, pinnetClaude)}`, "⚠️");
  } else if (sisteClaude && compareVersions(claude.versjon, sisteClaude) < 0) {
    log("A newer Claude Code exists — bump deliberately, see: pai update", "ℹ️");
  } else {
    log("Pinned and installed match", "✅");
  }
}

function cmdProfiles() {
  log("Available MCP Profiles:", "📋");
  console.log();

  const current = getCurrentProfile();
  const profiles = getMcpProfiles();

  for (const profile of profiles) {
    const isCurrent = profile === current;
    const desc = PROFILE_DESCRIPTIONS[profile] || "";
    const marker = isCurrent ? "→ " : "  ";
    const badge = isCurrent ? " (active)" : "";
    console.log(`${marker}${profile}${badge}`);
    if (desc) console.log(`    ${desc}`);
  }

  console.log();
  log("Usage: pai mcp set <profile>", "💡");
}

function cmdMcpList() {
  log("Available MCPs:", "📋");
  console.log();

  // Individual MCPs
  log("Individual MCPs (use with -m):", "📦");
  const mcps = getIndividualMcps();
  for (const mcp of mcps) {
    const shortcut = Object.entries(MCP_SHORTCUTS)
      .filter(([_, v]) => v === `${mcp}-MCP.json`)
      .map(([k]) => k);
    const shortcuts = shortcut.length > 0 ? ` (${shortcut.join(", ")})` : "";
    console.log(`  ${mcp}${shortcuts}`);
  }

  console.log();
  log("Profiles (use with 'pai mcp set'):", "📁");
  const profiles = getMcpProfiles();
  for (const profile of profiles) {
    const desc = PROFILE_DESCRIPTIONS[profile] || "";
    console.log(`  ${profile}${desc ? ` - ${desc}` : ""}`);
  }

  console.log();
  log("Examples:", "💡");
  console.log("  pai -m bd          # Bright Data only");
  console.log("  pai -m bd,ap       # Bright Data + Apify");
  console.log("  pai mcp set research  # Full research profile");
}

function cmdHelp() {
  console.log(`
pai - Personal AI CLI Tool (v2.0.0)

USAGE:
  pai                        Launch OpenCode v2 (private server, never --auto)
  pai -m <mcp>               Launch with specific MCP(s)
  pai -m bd,ap               Launch with multiple MCPs
  pai -r, --resume           Resume last session
  pai -l, --local            Stay in current directory (don't cd to ~/.opencode)
  pai -c, --claude           Launch Claude Code with the PAI plugin instead
  pai --prompt <text>        Start v2 and send <text> as the first message

COMMANDS:
  pai update                 Show how to bump the pinned OpenCode v2 and Claude Code
  pai version, -v            Show version information
  pai profiles               List available MCP profiles
  pai mcp list               List all available MCPs
  pai mcp set <profile>      Set MCP profile permanently
  pai claude sync            Regenerate the Claude plugin + patch settings.json
  pai claude doctor          Check the Claude side without changing anything
  pai doctor                 Check the v2 side and the model registry, change nothing
  pai keys                   Show which keys in .env are set, never their values
  pai -w, --wallpaper        List/switch wallpapers (Kitty + macOS)
  pai help, -h               Show this help

MCP SHORTCUTS:
  bd, brightdata           Bright Data scraping
  ap, apify                Apify automation
  cu, clickup              Official ClickUp (tasks, time tracking, docs)
  chrome                   Chrome DevTools
  dev                      Development tools
  sec, security            Security tools
  research                 Research tools (BD + Apify + Chrome)
  full                     All MCPs
  min, minimal             Essential MCPs only
  none                     No MCPs

EXAMPLES:
  pai                        Start with current profile
  pai -m bd                  Start with Bright Data
  pai -m bd,ap,chrome        Start with multiple MCPs
  pai -r                     Resume last session
  pai mcp set research       Switch to research profile
  pai -w                     List available wallpapers
  pai -w circuit-board       Switch wallpaper (Kitty + macOS)
  pai --claude               Start Claude Code with PAI loaded
  pai --claude -l            …in the current directory
`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  // No args - launch without touching MCP config (use native /mcp commands)
  if (args.length === 0) {
    process.exitCode = await cmdLaunch({});
    return;
  }

  // Parse arguments
  let mcp: string | undefined;
  let resume = false;
  let local = false;
  let claude = false;
  let prompt: string | undefined;
  let command: string | undefined;
  let subCommand: string | undefined;
  let subArg: string | undefined;
  let wallpaperArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "-m":
      case "--mcp": {
        const nextArg = args[i + 1];
        // -m with no arg, or -m 0, or -m "" means no MCPs
        if (!nextArg || nextArg.startsWith("-") || nextArg === "0" || nextArg === "") {
          mcp = "none";
          if (nextArg === "0" || nextArg === "") i++;
        } else {
          mcp = args[++i];
        }
        break;
      }
      case "-r":
      case "--resume":
        resume = true;
        break;
      case "-l":
      case "--local":
        local = true;
        break;
      case "-c":
      case "--claude":
        claude = true;
        break;
      case "--prompt":
        prompt = args[++i];
        if (!prompt) error("--prompt needs a text");
        break;
      case "--v1":
        error(V1_ER_SLETTET);
        break;
      case "--v2":
        // Standarden. Se V1_ER_SLETTET.
        break;
      case "claude":
        command = "claude";
        subCommand = args[++i];
        break;
      case "-v":
      case "--version":
      case "version":
        command = "version";
        break;
      case "-h":
      case "--help":
      case "help":
        command = "help";
        break;
      case "update":
        command = "update";
        break;
      case "doctor":
        command = "doctor";
        break;
      case "keys":
        command = "keys";
        break;
      case "profiles":
        command = "profiles";
        break;
      case "mcp":
        command = "mcp";
        subCommand = args[++i];
        subArg = args[++i];
        break;
      case "-w":
      case "--wallpaper":
        command = "wallpaper";
        wallpaperArgs = args.slice(i + 1);
        i = args.length; // Exit loop
        break;
      default:
        if (!arg.startsWith("-")) {
          // Might be an unknown command
          error(`Unknown command: ${arg}. Use 'pai help' for usage.`);
        }
    }
  }

  // Handle commands
  switch (command) {
    case "version":
      await cmdVersion();
      break;
    case "help":
      cmdHelp();
      break;
    case "update":
      cmdUpdate();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "keys":
      await cmdKeys();
      break;
    case "profiles":
      cmdProfiles();
      break;
    case "mcp":
      if (subCommand === "list") {
        cmdMcpList();
      } else if (subCommand === "set" && subArg) {
        setMcpProfile(subArg);
      } else {
        error("Usage: pai mcp list | pai mcp set <profile>");
      }
      break;
    case "wallpaper":
      cmdWallpaper(wallpaperArgs);
      break;
    case "claude":
      if (subCommand === "sync") {
        await cmdClaudeSync();
      } else if (subCommand === "doctor") {
        await cmdClaudeDoctor();
      } else {
        error("Usage: pai claude sync | pai claude doctor  (start with: pai --claude)");
      }
      break;
    default:
      // Launch with options
      process.exitCode = await cmdLaunch({ mcp, resume, local, claude, prompt });
  }
}

// Vakten lar testene importere de rene funksjonene uten å starte en motor.
if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
