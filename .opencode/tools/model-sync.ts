#!/usr/bin/env bun
/**
 * PAI Model Sync Tool
 *
 * Deterministic core for the ModelUpdate skill. Reads the model registry that
 * OpenCode v2 keeps, collects every model reference in governed files, and
 * classifies drift — so the LLM only gets involved when judgement is required.
 *
 * Registry (M-38): v2 caches the models.dev catalog in its own database,
 * `opencode.db`, table `kv`, key `models-dev:catalog`, as
 * `{updatedAt, digest, body}` where `body` is the catalog JSON in the same
 * shape as v1's `~/.cache/opencode/models.json` (MÅLT 2026-09-27, 2.0.18).
 * v1's two sources — `opencode models` from `~/.opencode/bin/opencode` and
 * that cache file — went with v1, and v2's own `models --standalone` gives an
 * empty list. The credentialed list is derived the way v1's `opencode models`
 * did it (MÅLT against the 1.18.18 binary): a provider counts when it has a
 * login (v2's `credential` table) or one of the catalog's `env` keys is set.
 *
 * Usage:
 *   bun run model-sync.ts check [--json]        # fetch → collect → diff → report
 *   bun run model-sync.ts list [provider] [--all] # the models you can use (--all: whole catalog)
 *   bun run model-sync.ts replace old=id new=id  # unified diff (dry-run default)
 *   bun run model-sync.ts replace old=id new=id --apply  # write + backup + re-verify
 *
 * Exit codes (check):
 *   0 = no drift · 1 = retired IDs found · 2 = only new models · 3 = registry unavailable
 *
 * Classification:
 *   OK           referenced and present in the credentialed registry list
 *   RETIRED      absent from both the credentialed list and the full cache
 *   UNVERIFIABLE in the full cache but provider has no credentials (NOT retired)
 *   EXTERNAL     ollama/local models — never checked against the registry
 *   NEW          in the credentialed registry but never referenced
 *
 * Backups: --apply snapshots every touched file to
 *   ~/.cache/model-sync/backups/<timestamp>/ and prints the restore command.
 *
 * @version 1.0.0
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "fs";
import { join, dirname, relative, basename } from "path";
import { homedir } from "os";
import { Database } from "bun:sqlite";
import { createTwoFilesPatch } from "diff";
import { loadStoredIntegrations } from "./switch-provider";

// Paths
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const OPENCODE_DIR = dirname(SCRIPT_DIR); // <repo>/.opencode/
const PROJECT_ROOT = dirname(OPENCODE_DIR);
const PROFILES_DIR = join(OPENCODE_DIR, "profiles");
const HOME_OPENCODE_DIR = join(homedir(), ".opencode");
const ENV_PATH = join(HOME_OPENCODE_DIR, ".env");
const OPENCODE_DB_PATH = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
  "opencode.db",
);
const CATALOG_KEY = "models-dev:catalog";
const BACKUP_ROOT = join(homedir(), ".cache", "model-sync", "backups");
const CACHE_STALE_MS = 24 * 60 * 60 * 1000;

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

// ============================================================================
// TYPES
// ============================================================================

/** Providers whose IDs are verified against the opencode registry. */
const REGISTRY_PROVIDERS = [
  "anthropic",
  "xai",
  "google",
  "openai",
  "opencode",
  "openrouter",
  "perplexity",
  "fireworks-ai",
] as const;

/** Providers that live outside the opencode registry (never "retired"). */
const EXTERNAL_PROVIDERS = ["ollama", "local"] as const;

const ALL_PROVIDERS = [...REGISTRY_PROVIDERS, ...EXTERNAL_PROVIDERS] as const;

export type Classification = "ok" | "retired" | "unverifiable" | "external";

export interface ModelReference {
  id: string;
  provider: string;
  locations: string[]; // "file:line"
}

export interface RegistryModelMeta {
  name?: string;
  release_date?: string;
  cost?: unknown;
  reasoning?: boolean;
  tool_call?: boolean;
}

export interface SyncReport {
  generatedAt: string;
  registry: {
    credentialedCount: number;
    cacheCount: number;
    cacheAgeHours: number | null;
    cacheStale: boolean;
  };
  referenceCount: number;
  ok: ModelReference[];
  retired: ModelReference[];
  unverifiable: ModelReference[];
  external: ModelReference[];
  newModels: { provider: string; id: string; meta: RegistryModelMeta }[];
  warnings: string[];
}

// ============================================================================
// EXTRACTION (pure — unit-testable)
// ============================================================================

/** Substrings that mark a match as a file path, not a model ID. */
const JUNK_SUBSTRINGS = [".json", ".jsonc", ".ts", ".sh", ".md", ".yaml", ".yml", ".env"];

/**
 * Extract candidate model IDs (provider/model) from free text.
 *
 * Guards against file-path false positives (`~/.opencode/bin`, `.opencode/profiles/x.yaml`):
 *  - match must not be preceded by a path character (. ~ / _ or word char), or
 *    by `@`: `@opencode/cli` is an npm package, not a Zen model
 *  - a match followed by `…` is an elided example (`fireworks-ai/accounts/…`)
 *  - `opencode/` IDs are always single-segment (real Zen IDs have no inner slash)
 *  - IDs containing file-extension substrings are rejected
 *  - trailing punctuation (. : -) is trimmed
 */
export function extractModelIds(text: string): string[] {
  const providerGroup = ALL_PROVIDERS.map((p) => p.replace(/-/g, "\\-")).join("|");
  // Lookbehind: preceding char must not be a path/word char (kills `~/.opencode/…`,
  // `./bin/opencode…` won't match since we require `provider/`).
  const re = new RegExp(
    `(?<![A-Za-z0-9.~/_:@-])(${providerGroup})/([A-Za-z0-9][A-Za-z0-9._:/-]*)`,
    "g",
  );
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    const provider = m[1];
    let model = m[2];
    if (text[(m.index ?? 0) + m[0].length] === "…") continue;
    // Trim trailing punctuation picked up by the greedy charset (prose sentences).
    model = model.replace(/[.:/-]+$/, "");
    if (!model || model.startsWith(".")) continue;
    if (JUNK_SUBSTRINGS.some((s) => model.includes(s))) continue;
    // Zen/opencode IDs are single-segment — anything with an inner slash is a path.
    if (provider === "opencode" && model.includes("/")) continue;
    out.add(`${provider}/${model}`);
  }
  return [...out].sort();
}

// ============================================================================
// CLASSIFICATION (pure — unit-testable)
// ============================================================================

export function classifyId(
  id: string,
  credentialed: ReadonlySet<string>,
  cache: ReadonlySet<string>,
): Classification {
  const provider = id.split("/")[0];
  if ((EXTERNAL_PROVIDERS as readonly string[]).includes(provider)) return "external";
  if (credentialed.has(id)) return "ok";
  if (cache.has(id)) return "unverifiable";
  return "retired";
}

// ============================================================================
// FILE COLLECTION
// ============================================================================

/**
 * The files ModelUpdate governs (see skill SKILL.md table).
 *
 * `missing` reports governed paths that do not exist. That output is not
 * cosmetic: `model-config.ts` moved from `plugins/lib/` to `pai-core/lib/` in
 * batch 3, and because this function silently filtered the stale path away,
 * the plugin fallback model map went ungoverned without anything failing.
 * A governed file that vanishes is now a warning in the report, not silence.
 */
export function governedFiles(
  projectRoot = PROJECT_ROOT,
  opencodeDir = OPENCODE_DIR,
): string[] {
  return collectGoverned(projectRoot, opencodeDir).present;
}

export function collectGoverned(
  projectRoot = PROJECT_ROOT,
  opencodeDir = OPENCODE_DIR,
): { present: string[]; missing: string[] } {
  const files: string[] = [];
  const profilesDir = join(opencodeDir, "profiles");
  if (existsSync(profilesDir)) {
    for (const f of readdirSync(profilesDir).filter((f) => f.endsWith(".yaml")).sort()) {
      files.push(join(profilesDir, f));
    }
  }
  files.push(join(opencodeDir, "pai-core", "lib", "model-config.ts"));
  // Agents take their model from opencode.json and the profiles; a `model:` in
  // frontmatter is a second source that drifts on its own (erfaringer.md). None
  // of ours has one, so any ID found here is worth a line in the report.
  const agentsDir = join(opencodeDir, "agents");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort()) {
      files.push(join(agentsDir, f));
    }
  }
  // The `--help` text there listed four researcher models by hand and drifted
  // from researchers.yaml. It is generated now; scanning keeps it that way.
  files.push(join(opencodeDir, "tools", "switch-provider.ts"));
  // `runbooks/` does not ship with the public copy (#162, phase 7).
  if (existsSync(join(projectRoot, "runbooks"))) files.push(join(projectRoot, "runbooks", "install.md"));
  return {
    present: files.filter((f) => existsSync(f)),
    missing: files.filter((f) => !existsSync(f)),
  };
}

/** Scan governed files, returning every referenced model ID with locations. */
export function collectReferences(files: string[], projectRoot = PROJECT_ROOT): ModelReference[] {
  const byId = new Map<string, ModelReference>();
  for (const file of files) {
    const rel = relative(projectRoot, file) || basename(file);
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((line, i) => {
      for (const id of extractModelIds(line)) {
        const ref = byId.get(id) ?? { id, provider: id.split("/")[0], locations: [] };
        ref.locations.push(`${rel}:${i + 1}`);
        byId.set(id, ref);
      }
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ============================================================================
// REGISTRY
// ============================================================================

/** Load KEY=VALUE pairs from ~/.opencode/.env (no external dep). */
function loadEnvFile(path = ENV_PATH): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/** The models.dev catalog: provider id → its env keys and models. */
export type Catalog = Record<string, { env?: unknown; models?: Record<string, RegistryModelMeta> }>;

export interface CatalogReadResult {
  catalog: Catalog;
  /** When v2 last fetched the catalog (ms since epoch), or null if it did not say. */
  updatedAt: number | null;
}

/**
 * Read v2's cached models.dev catalog from `opencode.db`, read-only.
 *
 * Null when the database, the row or a parsable body is missing: that is
 * "registry unavailable", never an empty registry, because an empty one would
 * classify every reference as retired.
 */
export function readCatalog(dbPath = OPENCODE_DB_PATH): CatalogReadResult | null {
  if (!existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("SELECT value FROM kv WHERE key = ?").get(CATALOG_KEY) as { value: unknown } | null;
      if (!row) return null;
      const text = typeof row.value === "string" ? row.value : new TextDecoder().decode(row.value as Uint8Array);
      const entry = JSON.parse(text) as { updatedAt?: unknown; body?: unknown };
      const body = typeof entry.body === "string" ? JSON.parse(entry.body) : entry.body;
      if (typeof body !== "object" || body === null || Object.keys(body).length === 0) return null;
      return { catalog: body as Catalog, updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : null };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * The models you can actually use: every model of a provider that has a
 * login in v2's store, or one of whose catalog `env` keys is set and
 * non-empty. Same rule as v1's `opencode models` (MÅLT: no key → the provider
 * is absent; `FIREWORKS_API_KEY` in the environment or an `auth.json` entry →
 * all its models listed).
 *
 * One exception: Zen's free models need no login (MÅLT 2026-10-04, v2 2.0.18:
 * `run --model opencode/longcat-2.5-preview-free` answered with no key), so an
 * `opencode` model priced 0 in and 0 out counts without one (#195). Without it,
 * a new user who stays on the free models from the setup runbook got a red
 * «no provider has a login».
 */
/** Zen's provider id in the catalog. */
const ZEN = "opencode";

/** Priced 0 for both input and output in the catalog. A missing price is not free. */
function erGratis(meta: RegistryModelMeta | undefined): boolean {
  const cost = meta?.cost as { input?: unknown; output?: unknown } | undefined;
  return cost?.input === 0 && cost?.output === 0;
}

export function credentialedModels(
  catalog: Catalog,
  stored: ReadonlySet<string>,
  env: Readonly<Record<string, string | undefined>>,
): Set<string> {
  const ids = new Set<string>();
  for (const [providerId, provider] of Object.entries(catalog)) {
    const keys = Array.isArray(provider.env) ? provider.env.filter((k): k is string => typeof k === "string") : [];
    const innlogget = stored.has(providerId) || keys.some((k) => Boolean(env[k]));
    for (const [modelId, meta] of Object.entries(provider.models ?? {})) {
      if (innlogget || (providerId === ZEN && erGratis(meta))) ids.add(`${providerId}/${modelId}`);
    }
  }
  return ids;
}

interface CacheReadResult {
  ids: Set<string>;
  meta: Map<string, RegistryModelMeta>;
  ageHours: number | null;
  stale: boolean;
}

/** Catalog → full registry + per-model metadata, aged by v2's `updatedAt`. */
export function catalogToCache(registry: CatalogReadResult | null, now = Date.now()): CacheReadResult {
  const ids = new Set<string>();
  const meta = new Map<string, RegistryModelMeta>();
  if (!registry) return { ids, meta, ageHours: null, stale: true };
  for (const [providerId, provider] of Object.entries(registry.catalog)) {
    for (const [modelId, modelMeta] of Object.entries(provider.models ?? {})) {
      const full = `${providerId}/${modelId}`;
      ids.add(full);
      meta.set(full, {
        name: modelMeta.name,
        release_date: modelMeta.release_date,
        cost: modelMeta.cost,
        reasoning: modelMeta.reasoning,
        tool_call: modelMeta.tool_call,
      });
    }
  }
  const ageHours = registry.updatedAt === null ? null : (now - registry.updatedAt) / 3_600_000;
  return { ids, meta, ageHours, stale: ageHours === null || ageHours * 3_600_000 > CACHE_STALE_MS };
}

// ============================================================================
// CHECK COMMAND
// ============================================================================

export function buildReport(
  references: ModelReference[],
  credentialed: Set<string>,
  cache: CacheReadResult,
  now = new Date(),
  missingGoverned: string[] = [],
): SyncReport {
  const ok: ModelReference[] = [];
  const retired: ModelReference[] = [];
  const unverifiable: ModelReference[] = [];
  const external: ModelReference[] = [];
  for (const ref of references) {
    const cls = classifyId(ref.id, credentialed, cache.ids);
    if (cls === "ok") ok.push(ref);
    else if (cls === "retired") retired.push(ref);
    else if (cls === "unverifiable") unverifiable.push(ref);
    else external.push(ref);
  }
  const referenced = new Set(references.map((r) => r.id));
  const newModels = [...credentialed]
    .filter((id) => !referenced.has(id))
    .sort()
    .map((id) => ({ provider: id.split("/")[0], id, meta: cache.meta.get(id) ?? {} }));
  const warnings: string[] = [];
  // A governed file that has moved is the failure this whole tool exists to
  // prevent, turned on itself: nothing fails, the file simply stops being
  // checked. `model-config.ts` sat unchecked from batch 3 until someone read
  // the path by hand.
  for (const fil of missingGoverned) {
    warnings.push(`governed file missing: ${fil} — it is NOT being checked. Fix the path in governedFiles().`);
  }
  if (cache.stale) {
    warnings.push(
      cache.ageHours === null
        ? `models catalog has no updatedAt in ${OPENCODE_DB_PATH} — its age is unknown`
        : `models catalog is ${cache.ageHours.toFixed(0)}h old (>24h) — start pai once to refresh it`,
    );
  }
  return {
    generatedAt: now.toISOString(),
    registry: {
      credentialedCount: credentialed.size,
      cacheCount: cache.ids.size,
      cacheAgeHours: cache.ageHours === null ? null : Math.round(cache.ageHours * 10) / 10,
      cacheStale: cache.stale,
    },
    referenceCount: references.length,
    ok,
    retired,
    unverifiable,
    external,
    newModels,
    warnings,
  };
}

function locList(ref: ModelReference): string {
  const shown = ref.locations.slice(0, 4).join(", ");
  const extra = ref.locations.length > 4 ? ` (+${ref.locations.length - 4} more)` : "";
  return `${shown}${extra}`;
}

export function renderMarkdown(r: SyncReport): string {
  const L: string[] = [];
  L.push(`# Model Sync Report — ${r.generatedAt.slice(0, 10)}`);
  L.push("");
  L.push(
    `Registry: ${r.registry.credentialedCount} credentialed · cache ${r.registry.cacheCount} models` +
      (r.registry.cacheAgeHours !== null ? ` (${r.registry.cacheAgeHours}h old)` : " (missing)"),
  );
  L.push(`References: ${r.referenceCount} unique IDs in governed files`);
  for (const w of r.warnings) L.push(`${c.yellow}⚠ ${w}${c.reset}`);
  L.push("");
  if (r.retired.length) {
    L.push(`## ${c.red}RETIRED (${r.retired.length}) — must be replaced${c.reset}`);
    for (const ref of r.retired) L.push(`- \`${ref.id}\` — ${locList(ref)}`);
    L.push("");
  }
  if (r.unverifiable.length) {
    L.push(`## ${c.yellow}UNVERIFIABLE (${r.unverifiable.length}) — provider lacks credentials, NOT retired${c.reset}`);
    for (const ref of r.unverifiable) L.push(`- \`${ref.id}\` — ${locList(ref)}`);
    L.push("");
  }
  if (r.newModels.length) {
    L.push(`## ${c.cyan}NEW (${r.newModels.length}) — in registry, not referenced${c.reset}`);
    let cur = "";
    for (const m of r.newModels) {
      if (m.provider !== cur) {
        cur = m.provider;
        L.push(`\n**${cur}**`);
      }
      const bits = [m.meta.name, m.meta.release_date, m.meta.reasoning ? "reasoning" : ""]
        .filter(Boolean)
        .join(" · ");
      L.push(`- \`${m.id}\`${bits ? ` — ${bits}` : ""}`);
    }
    L.push("");
  }
  L.push(`## ${c.green}OK (${r.ok.length})${c.reset} · EXTERNAL (${r.external.length}, ollama/local — not registry-checked)`);
  if (!r.retired.length && !r.newModels.length) {
    L.push("");
    L.push(`${c.green}✓ No drift — every referenced model exists in the registry, no new models.${c.reset}`);
  }
  return L.join("\n");
}

// ============================================================================
// REPLACE COMMAND
// ============================================================================

export interface ReplaceResult {
  oldId: string;
  newId: string;
  files: { path: string; occurrences: number; patch: string }[];
  totalOccurrences: number;
  backupDir?: string;
}

/** Characters that continue a model ID. A match flanked by one is a PREFIX, not the ID. */
const ID_TEGN = /[A-Za-z0-9._:/-]/;

/**
 * Is `oldId` a whole model ID at this position, or merely a prefix of a longer one?
 *
 * This is the guard that makes `replace` safe, and it was missing. The old
 * implementation spliced raw substrings, so replacing
 * `…/routers/deepseek-flash-latest` ALSO rewrote
 * `…/routers/deepseek-flash-latest-priority` — silently minting an ID the
 * registry has never heard of. Fireworks names every model in exactly that
 * `<id>` / `<id>-priority` pair, so the collision is not hypothetical; it is
 * the shape of the provider the repo is about to start using.
 *
 * The workflow told the operator to "inspect the dry-run diff" and "run
 * replacements longest to shortest". That is a rule enforced by whoever
 * remembers it. This one is enforced by the code.
 */
function erHeleId(content: string, start: number, lengde: number): boolean {
  const før = start > 0 ? content[start - 1] : "";
  const etter = content[start + lengde] ?? "";
  return !ID_TEGN.test(før) && !ID_TEGN.test(etter);
}

/** Replace only whole-ID occurrences, returning the new text and the count. */
export function replaceWholeIds(
  content: string,
  oldId: string,
  newId: string,
): { text: string; occurrences: number } {
  let ut = "";
  let i = 0;
  let treff = 0;
  for (;;) {
    const funnet = content.indexOf(oldId, i);
    if (funnet === -1) break;
    if (erHeleId(content, funnet, oldId.length)) {
      ut += content.slice(i, funnet) + newId;
      treff++;
    } else {
      ut += content.slice(i, funnet + oldId.length);
    }
    i = funnet + oldId.length;
  }
  return { text: ut + content.slice(i), occurrences: treff };
}

/**
 * A model ID is `<known-provider>/<path>`. Anything else is rejected.
 *
 * Without this, `replace old=model new=modell` was a valid command that
 * rewrote every `model:` key in every governed profile. `old=` is operator
 * input, and an operator that can pass a bare word can destroy the file set
 * the tool exists to protect.
 */
export function erGyldigModellId(id: string): boolean {
  const skrå = id.indexOf("/");
  if (skrå <= 0 || skrå === id.length - 1) return false;
  return (ALL_PROVIDERS as readonly string[]).includes(id.slice(0, skrå));
}

export function planReplace(oldId: string, newId: string, files: string[]): ReplaceResult {
  const result: ReplaceResult = { oldId, newId, files: [], totalOccurrences: 0 };
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const { text: updated, occurrences } = replaceWholeIds(content, oldId, newId);
    if (occurrences === 0) continue;
    result.files.push({
      path: file,
      occurrences,
      patch: createTwoFilesPatch(file, file, content, updated, "current", "updated"),
    });
    result.totalOccurrences += occurrences;
  }
  return result;
}

/** Snapshot each touched file into ~/.cache/model-sync/backups/<ts>/ mirroring repo paths. */
export function applyReplace(plan: ReplaceResult, projectRoot = PROJECT_ROOT): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = join(BACKUP_ROOT, ts);
  for (const f of plan.files) {
    const rel = relative(projectRoot, f.path);
    const dest = join(backupDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.path, dest);
    const content = readFileSync(f.path, "utf-8");
    // Samme anker som dry-run. Sto de to på hver sin regel, ville diffen
    // operatøren godkjente ikke vært den som faktisk ble skrevet.
    writeFileSync(f.path, replaceWholeIds(content, plan.oldId, plan.newId).text);
  }
  plan.backupDir = backupDir;
  return backupDir;
}

// ============================================================================
// HEALTH CHECK (K29) — what `pai doctor` reports
// ============================================================================

export interface Helsesjekk {
  /** Something that needs fixing, with the command or workflow that fixes it. */
  problemer: string[];
  /** Worth knowing, not wrong: a stale catalog, a governed file that moved. */
  varsler: string[];
}

/**
 * The registry part of `pai doctor`: silent when every referenced model is
 * still offered, one line per problem otherwise. M-38 left `check` dead for a
 * day, and when it ran again, one of the Fireworks routers in the profiles was
 * already gone from the catalog; nothing runs `check` unless someone asks for
 * ModelUpdate. Reports only, never replaces: the model choice is the user's.
 *
 * `unverifiable` and `new` are not problems. A provider without a key is a
 * choice, and a new model is news.
 */
export function helsesjekk(
  registry: CatalogReadResult | null,
  stored: ReadonlySet<string>,
  env: Readonly<Record<string, string | undefined>>,
  references: ModelReference[],
  missingGoverned: string[] = [],
  now = Date.now(),
): Helsesjekk {
  if (!registry) {
    return {
      problemer: [`the model catalog is missing (${CATALOG_KEY} in ${OPENCODE_DB_PATH}). Start pai once`],
      varsler: [],
    };
  }
  const credentialed = credentialedModels(registry.catalog, stored, env);
  if (credentialed.size === 0) {
    return {
      problemer: [`no provider has a login (opencode auth login) or a key in ${ENV_PATH}`],
      varsler: [],
    };
  }
  const report = buildReport(references, credentialed, catalogToCache(registry, now), new Date(now), missingGoverned);
  return {
    problemer: report.retired.map(
      (r) => `${r.id} is no longer in the catalog: ${locList(r)}. Run ModelUpdate (“update the model lists”)`,
    ),
    varsler: report.warnings,
  };
}

/** `helsesjekk` against this machine: v2's database, `.env` and the governed files. */
export function helsesjekkHer(): Helsesjekk {
  const governed = collectGoverned();
  return helsesjekk(
    readCatalog(),
    loadStoredIntegrations(OPENCODE_DB_PATH),
    { ...loadEnvFile(), ...process.env },
    collectReferences(governed.present),
    governed.missing,
  );
}

// ============================================================================
// CLI
// ============================================================================

const USAGE = `
${c.bold}model-sync.ts${c.reset} — deterministic core for the ModelUpdate skill

${c.bold}Usage:${c.reset}
  bun run model-sync.ts check [--json]              fetch → collect → diff → report
  bun run model-sync.ts list [provider] [--all]     models you can use; --all: whole catalog
  bun run model-sync.ts replace old=id new=id        unified diff (dry-run default)
  bun run model-sync.ts replace old=id new=id --apply

${c.bold}Exit codes (check):${c.reset} 0 no drift · 1 retired found · 2 only new models · 3 registry unavailable
`;

function parseReplaceArgs(args: string[]): { oldId: string; newId: string } {
  let oldId = "";
  let newId = "";
  for (const a of args) {
    if (a.startsWith("old=")) oldId = a.slice(4);
    else if (a.startsWith("new=")) newId = a.slice(4);
    else if (a.includes("=") && !oldId) {
      // positional shorthand: old=new
      const [o, n] = a.split("=");
      oldId = o;
      newId = n ?? "";
    }
  }
  if (!oldId || !newId) {
    console.error(`${c.red}✗ replace requires old=<id> new=<id>${c.reset}${USAGE}`);
    process.exit(64);
  }
  for (const [flagg, id] of [["old", oldId], ["new", newId]] as const) {
    if (!erGyldigModellId(id)) {
      console.error(
        `${c.red}✗ ${flagg}=${id} is not a model ID${c.reset}\n` +
          `  Expected <provider>/<model> with a known provider ` +
          `(${ALL_PROVIDERS.join(", ")}).\n` +
          `  replace swaps model IDs, not arbitrary text in the profiles.`,
      );
      process.exit(64);
    }
  }
  return { oldId, newId };
}

export function main(argv = process.argv.slice(2)): number {
  const cmd = argv[0] ?? "check";
  const flags = new Set(argv.filter((a) => a.startsWith("--")));

  if (cmd === "help" || flags.has("--help") || flags.has("-h")) {
    console.log(USAGE);
    return 0;
  }

  if (cmd === "check") {
    const registry = readCatalog();
    if (!registry) {
      console.error(
        `${c.red}✗ Registry unavailable: no ${CATALOG_KEY} in ${OPENCODE_DB_PATH} — start pai (OpenCode v2) once${c.reset}`,
      );
      return 3;
    }
    const credentialed = credentialedModels(registry.catalog, loadStoredIntegrations(OPENCODE_DB_PATH), {
      ...loadEnvFile(),
      ...process.env,
    });
    if (credentialed.size === 0) {
      console.error(
        `${c.red}✗ Registry unavailable: no provider has a login (opencode auth login) or a key in ${ENV_PATH}${c.reset}`,
      );
      return 3;
    }
    const cache = catalogToCache(registry);
    const governed = collectGoverned();
    const files = governed.present;
    const references = collectReferences(files);
    const report = buildReport(references, credentialed, cache, new Date(), governed.missing);
    if (flags.has("--json")) console.log(JSON.stringify(report, null, 2));
    else console.log(renderMarkdown(report));
    if (report.retired.length > 0) return 1;
    if (report.newModels.length > 0) return 2;
    return 0;
  }

  if (cmd === "list") {
    // Replaces `opencode models | grep <provider>`: v2's `models --standalone` prints nothing.
    const registry = readCatalog();
    if (!registry) {
      console.error(`${c.red}✗ Registry unavailable: no ${CATALOG_KEY} in ${OPENCODE_DB_PATH} — start pai once${c.reset}`);
      return 3;
    }
    const provider = argv.slice(1).find((a) => !a.startsWith("--"));
    const ids = flags.has("--all")
      ? catalogToCache(registry).ids
      : credentialedModels(registry.catalog, loadStoredIntegrations(OPENCODE_DB_PATH), { ...loadEnvFile(), ...process.env });
    for (const id of [...ids].sort()) if (!provider || id.startsWith(`${provider}/`)) console.log(id);
    return 0;
  }

  if (cmd === "replace") {
    const { oldId, newId } = parseReplaceArgs(argv.slice(1).filter((a) => !a.startsWith("--")));
    const governed = collectGoverned();
    const files = governed.present;
    const plan = planReplace(oldId, newId, files);
    if (plan.totalOccurrences === 0) {
      console.log(`${c.yellow}⚠ "${oldId}" not found in any governed file — nothing to do.${c.reset}`);
      return 0;
    }
    // Warn if the replacement ID is unknown to both registry views (typo guard).
    // The catalog is a superset of the credentialed list, so one lookup covers both.
    if (!catalogToCache(readCatalog()).ids.has(newId)) {
      console.log(`${c.yellow}⚠ "${newId}" is not in v2's models catalog — verify the ID.${c.reset}`);
    }
    console.log(`${c.bold}${oldId} → ${newId}${c.reset}: ${plan.totalOccurrences} occurrence(s) in ${plan.files.length} file(s)\n`);
    for (const f of plan.files) console.log(f.patch);
    if (!flags.has("--apply")) {
      console.log(`${c.dim}Dry-run — re-run with --apply to write.${c.reset}`);
      return 0;
    }
    const backupDir = applyReplace(plan);
    console.log(`\n${c.green}✓ Applied.${c.reset} Backups in ${backupDir}`);
    console.log(`${c.dim}Restore: (cd "${backupDir}" && for f in $(find . -type f); do cp "$f" "${PROJECT_ROOT}/$f"; done)${c.reset}`);
    // Re-verify: old ID must be gone from governed files.
    const after = collectReferences(files);
    const remaining = after.find((r) => r.id === oldId);
    if (remaining) {
      console.log(`${c.red}✗ Re-verification FAILED: ${oldId} still referenced at ${locList(remaining)}${c.reset}`);
      return 1;
    }
    console.log(`${c.green}✓ Re-verified: ${oldId} no longer referenced in governed files.${c.reset}`);
    return 0;
  }

  console.error(`${c.red}✗ Unknown command "${cmd}"${c.reset}${USAGE}`);
  return 64;
}

if (import.meta.main) {
  process.exit(main());
}
