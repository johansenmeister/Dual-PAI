/**
 * Tests for model-sync.ts — fixture-based, no live registry required.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  applyReplace,
  buildReport,
  catalogToCache,
  classifyId,
  credentialedModels,
  collectReferences,
  collectGoverned,
  erGyldigModellId,
  extractModelIds,
  helsesjekk,
  planReplace,
  readCatalog,
  replaceWholeIds,
} from "../.opencode/tools/model-sync";

// ============================================================================
// extractModelIds — true positives and path false-positive guards
// ============================================================================

describe("extractModelIds", () => {
  test("extracts true model IDs", () => {
    const text = [
      "model: anthropic/claude-sonnet-5",
      "default: fireworks-ai/accounts/fireworks/models/kimi-k3",
      "use opencode/big-pickle for zen",
      "| xai/grok-4.3 | key |",
      "ollama/qwen3.5:9b",
      "openrouter/openai/gpt-4.1",
      "perplexity/sonar",
    ].join("\n");
    const ids = extractModelIds(text);
    expect(ids).toContain("anthropic/claude-sonnet-5");
    expect(ids).toContain("fireworks-ai/accounts/fireworks/models/kimi-k3");
    expect(ids).toContain("opencode/big-pickle");
    expect(ids).toContain("xai/grok-4.3");
    expect(ids).toContain("ollama/qwen3.5:9b");
    expect(ids).toContain("openrouter/openai/gpt-4.1");
    expect(ids).toContain("perplexity/sonar");
  });

  test("rejects file paths that look like provider IDs (baseline grep junk)", () => {
    // These strings produced false positives with the old workflow grep.
    const text = [
      "cd ~/.opencode && ./bin/opencode models",
      "see ~/.opencode/bin/opencode for the binary",
      "edit ~/.opencode/settings.json",
      "keys in ~/.opencode/.env",
      "file .opencode/profiles/local.yaml",
      "path ~/.opencode/auth.json here",
      "script ~/.opencode/PAI/Tools/SkillSearch.ts",
      "run ~/.opencode/scripts/aliases.sh",
      "dir ~/.opencode/tools/opencode",
      "~/.opencode/skills/ and ~/.opencode/observability-server",
    ].join("\n");
    const ids = extractModelIds(text);
    expect(ids).toEqual([]);
  });

  test("trims trailing punctuation from prose", () => {
    expect(extractModelIds("Try opencode/kimi-k2.5.")).toEqual(["opencode/kimi-k2.5"]);
    expect(extractModelIds("model: anthropic/claude-fable-5:")).toEqual(["anthropic/claude-fable-5"]);
  });

  test("rejects opencode multi-segment paths but keeps single-segment IDs", () => {
    const ids = extractModelIds("opencode/profiles/local.yaml vs opencode/deepseek-v4-flash-free");
    expect(ids).toEqual(["opencode/deepseek-v4-flash-free"]);
  });

  test("rejects npm scopes: @opencode/cli is a package, not a Zen model", () => {
    expect(extractModelIds("bun add @opencode/cli; model: opencode/big-pickle")).toEqual(["opencode/big-pickle"]);
  });

  test("rejects an elided example ending in …", () => {
    expect(extractModelIds("first segment: `fireworks-ai/accounts/…` → provider")).toEqual([]);
    expect(extractModelIds("xai/grok-4.7…")).toEqual([]);
  });

  test("dedupes and sorts", () => {
    const ids = extractModelIds("xai/grok-4.3 xai/grok-4.3 anthropic/claude-sonnet-5");
    expect(ids).toEqual(["anthropic/claude-sonnet-5", "xai/grok-4.3"]);
  });
});

// ============================================================================
// classifyId
// ============================================================================

describe("classifyId", () => {
  const credentialed = new Set(["anthropic/claude-sonnet-5"]);
  const cache = new Set(["anthropic/claude-sonnet-5", "xai/grok-4.3"]);

  test("ok when credentialed", () => {
    expect(classifyId("anthropic/claude-sonnet-5", credentialed, cache)).toBe("ok");
  });
  test("unverifiable when only in full cache (provider lacks key)", () => {
    expect(classifyId("xai/grok-4.3", credentialed, cache)).toBe("unverifiable");
  });
  test("retired when absent from both", () => {
    expect(classifyId("openai/gpt-4o", credentialed, cache)).toBe("retired");
  });
  test("external for ollama/local regardless of registry", () => {
    expect(classifyId("ollama/qwen3.5:9b", credentialed, cache)).toBe("external");
    expect(classifyId("local/qwen3.5:9b", credentialed, cache)).toBe("external");
  });
});

// ============================================================================
// The registry under v2 (M-38): opencode.db, kv["models-dev:catalog"]
// ============================================================================

/** Same shape as v2 2.0.18 writes it: {updatedAt, digest, body}, body a JSON string. */
function catalogDb(value: unknown, key = "models-dev:catalog"): string {
  const path = join(mkdtempSync(join(tmpdir(), "model-sync-db-")), "opencode.db");
  const db = new Database(path);
  db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
  db.query("INSERT INTO kv (key, value) VALUES (?, ?)").run(key, value as string);
  db.close();
  return path;
}

const CATALOG = {
  anthropic: { env: ["ANTHROPIC_API_KEY"], models: { "claude-sonnet-5": { name: "Claude Sonnet 5" } } },
  "fireworks-ai": {
    env: ["FIREWORKS_API_KEY"],
    models: { "accounts/fireworks/routers/kimi-latest": {}, "accounts/fireworks/routers/glm-latest": {} },
  },
  xai: { env: ["XAI_API_KEY"], models: { "grok-4.7": {} } },
};

describe("readCatalog", () => {
  test("reads body and updatedAt from the kv row", () => {
    const path = catalogDb(JSON.stringify({ updatedAt: 1790434268480, digest: "x", body: JSON.stringify(CATALOG) }));
    const r = readCatalog(path);
    expect(r?.updatedAt).toBe(1790434268480);
    expect(Object.keys(r?.catalog ?? {})).toEqual(["anthropic", "fireworks-ai", "xai"]);
  });

  test("a blob value reads the same as text", () => {
    const text = JSON.stringify({ updatedAt: 1, body: JSON.stringify(CATALOG) });
    const r = readCatalog(catalogDb(new TextEncoder().encode(text)));
    expect(Object.keys(r?.catalog ?? {})).toHaveLength(3);
  });

  test("unavailable, never empty, when the db, the row or the body is missing", () => {
    expect(readCatalog(join(tmpdir(), "finnes-ikke", "opencode.db"))).toBeNull();
    expect(readCatalog(catalogDb(JSON.stringify({ body: "{}" }), "annen-nøkkel"))).toBeNull();
    expect(readCatalog(catalogDb(JSON.stringify({ updatedAt: 1, body: "{}" })))).toBeNull();
    expect(readCatalog(catalogDb("ikke json"))).toBeNull();
  });
});

describe("credentialedModels — v1s regel for opencode models", () => {
  test("a login in v2's credential store counts the provider", () => {
    expect([...credentialedModels(CATALOG, new Set(["xai"]), {})]).toEqual(["xai/grok-4.7"]);
  });

  test("a catalog env key that is set counts the provider; empty or absent does not", () => {
    const ids = credentialedModels(CATALOG, new Set(), { FIREWORKS_API_KEY: "fw_x", ANTHROPIC_API_KEY: "" });
    expect([...ids].sort()).toEqual([
      "fireworks-ai/accounts/fireworks/routers/glm-latest",
      "fireworks-ai/accounts/fireworks/routers/kimi-latest",
    ]);
  });

  // #195: Zens gratismodeller svarer uten innlogging (MÅLT 2026-10-04).
  test("Zen's free models count without a login; its paid ones and other free ones do not", () => {
    const zen = {
      opencode: {
        env: ["OPENCODE_API_KEY"],
        models: {
          "longcat-2.5-preview-free": { cost: { input: 0, output: 0, cache_read: 0 } },
          "gpt-5.5": { cost: { input: 5, output: 30 } },
          "uten-pris": {},
          "halvgratis": { cost: { input: 0, output: 1 } },
        },
      },
      ollama: { env: ["OLLAMA_HOST"], models: { "qwen3:14b": { cost: { input: 0, output: 0 } } } },
    };
    expect([...credentialedModels(zen, new Set(), {})]).toEqual(["opencode/longcat-2.5-preview-free"]);
    expect(credentialedModels(zen, new Set(), { OPENCODE_API_KEY: "k" }).size).toBe(4);
  });

  test("nothing without login or key, and a malformed env field is not a crash", () => {
    expect(credentialedModels(CATALOG, new Set(), {}).size).toBe(0);
    expect(credentialedModels({ odd: { env: "XAI_API_KEY", models: { m: {} } } }, new Set(), { XAI_API_KEY: "k" }).size).toBe(0);
  });
});

describe("catalogToCache", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");

  test("ids and metadata from the catalog, aged by updatedAt", () => {
    const c = catalogToCache({ catalog: CATALOG, updatedAt: now - 2 * 3_600_000 }, now);
    expect(c.ids.size).toBe(4);
    expect(c.meta.get("anthropic/claude-sonnet-5")?.name).toBe("Claude Sonnet 5");
    expect(c.ageHours).toBe(2);
    expect(c.stale).toBe(false);
  });

  test("stale past 24 h, and when the age is unknown", () => {
    expect(catalogToCache({ catalog: CATALOG, updatedAt: now - 25 * 3_600_000 }, now).stale).toBe(true);
    expect(catalogToCache({ catalog: CATALOG, updatedAt: null }, now).stale).toBe(true);
    expect(catalogToCache(null, now)).toMatchObject({ ageHours: null, stale: true });
  });
});

// ============================================================================
// K29: helsesjekken `pai doctor` viser
// ============================================================================

describe("helsesjekk (K29)", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");
  const fersk = { catalog: CATALOG, updatedAt: now - 3_600_000 };
  const ref = (id: string, loc = "profiles/x.yaml:1") => ({ id, provider: id.split("/")[0], locations: [loc] });
  const nøkkel = { FIREWORKS_API_KEY: "fw_x" };

  test("taus når hver referanse finnes, også når leverandøren mangler nøkkel", () => {
    const refs = [ref("fireworks-ai/accounts/fireworks/routers/kimi-latest"), ref("xai/grok-4.7"), ref("ollama/qwen3:14b")];
    expect(helsesjekk(fersk, new Set(), nøkkel, refs, [], now)).toEqual({ problemer: [], varsler: [] });
  });

  test("en utgått modell er et problem, med fil:linje og ModelUpdate", () => {
    const refs = [ref("fireworks-ai/accounts/fireworks/routers/deepseek-pro-latest", "profiles/fireworks.yaml:79")];
    const h = helsesjekk(fersk, new Set(), nøkkel, refs, [], now);
    expect(h.problemer).toHaveLength(1);
    expect(h.problemer[0]).toContain("deepseek-pro-latest");
    expect(h.problemer[0]).toContain("profiles/fireworks.yaml:79");
    expect(h.problemer[0]).toContain("ModelUpdate");
  });

  test("manglende katalog og ingen nøkler er problemer, ikke en tom rapport", () => {
    expect(helsesjekk(null, new Set(), nøkkel, [], [], now).problemer[0]).toContain("the model catalog is missing");
    expect(helsesjekk(fersk, new Set(), {}, [ref("xai/grok-4.7")], [], now).problemer[0]).toContain("no provider");
  });

  test("bare Zens gratismodeller og ingen nøkkel: taus, og en gratismodell som er borte, er et problem (#195)", () => {
    const zen = { catalog: { ...CATALOG, opencode: { env: ["OPENCODE_API_KEY"], models: { "longcat-2.5-preview-free": { cost: { input: 0, output: 0 } } } } }, updatedAt: now - 3_600_000 };
    expect(helsesjekk(zen, new Set(), {}, [ref("opencode/longcat-2.5-preview-free")], [], now)).toEqual({ problemer: [], varsler: [] });
    const borte = helsesjekk(zen, new Set(), {}, [ref("opencode/space-bunny-free", "opencode.json:3")], [], now);
    expect(borte.problemer).toHaveLength(1);
    expect(borte.problemer[0]).toContain("space-bunny-free");
  });

  test("gammel katalog og en styrt fil som mangler er varsler, ikke problemer", () => {
    const gammel = { catalog: CATALOG, updatedAt: now - 30 * 3_600_000 };
    const h = helsesjekk(gammel, new Set(), nøkkel, [], [".opencode/profiles/borte.yaml"], now);
    expect(h.problemer).toEqual([]);
    expect(h.varsler).toHaveLength(2);
  });
});

// ============================================================================
// collectReferences + buildReport
// ============================================================================

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "model-sync-test-"));
  mkdirSync(join(dir, ".opencode", "profiles"), { recursive: true });
  mkdirSync(join(dir, ".opencode", "plugins", "lib"), { recursive: true });
  mkdirSync(join(dir, "runbooks"), { recursive: true });
  return dir;
}

describe("collectReferences", () => {
  test("collects IDs with file:line locations", () => {
    const dir = fixtureDir();
    const f = join(dir, "profiles.yaml");
    writeFileSync(f, "default_model: anthropic/claude-sonnet-5\nagents:\n  A:\n    model: xai/grok-4.3\n");
    const refs = collectReferences([f], dir);
    const sonnet = refs.find((r) => r.id === "anthropic/claude-sonnet-5");
    const grok = refs.find((r) => r.id === "xai/grok-4.3");
    expect(sonnet?.locations).toEqual(["profiles.yaml:1"]);
    expect(grok?.locations).toEqual(["profiles.yaml:4"]);
  });
});

describe("buildReport", () => {
  test("classifies references and finds new models", () => {
    const refs = [
      { id: "anthropic/claude-sonnet-5", provider: "anthropic", locations: ["a:1"] },
      { id: "openai/gpt-4o", provider: "openai", locations: ["b:2"] },
      { id: "xai/grok-4.3", provider: "xai", locations: ["c:3"] },
      { id: "ollama/qwen3.5:9b", provider: "ollama", locations: ["d:4"] },
    ];
    const credentialed = new Set(["anthropic/claude-sonnet-5", "anthropic/claude-opus-5"]);
    const cache = {
      ids: new Set(["anthropic/claude-sonnet-5", "anthropic/claude-opus-5", "xai/grok-4.3"]),
      meta: new Map([
        ["anthropic/claude-opus-5", { name: "Claude Opus 5", release_date: "2026-05-01", reasoning: true }],
      ]),
      ageHours: 2,
      stale: false,
    };
    const r = buildReport(refs, credentialed, cache, new Date("2026-08-01T00:00:00Z"));
    expect(r.ok.map((x) => x.id)).toEqual(["anthropic/claude-sonnet-5"]);
    expect(r.retired.map((x) => x.id)).toEqual(["openai/gpt-4o"]);
    expect(r.unverifiable.map((x) => x.id)).toEqual(["xai/grok-4.3"]);
    expect(r.external.map((x) => x.id)).toEqual(["ollama/qwen3.5:9b"]);
    expect(r.newModels.map((x) => x.id)).toEqual(["anthropic/claude-opus-5"]);
    expect(r.newModels[0].meta.name).toBe("Claude Opus 5");
    expect(r.warnings).toEqual([]);
  });

  test("warns on stale cache", () => {
    const r = buildReport([], new Set(), { ids: new Set(), meta: new Map(), ageHours: 50, stale: true });
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain("50h");
  });
});

// ============================================================================
// replace
// ============================================================================

describe("replace", () => {
  test("planReplace finds occurrences and produces patches", () => {
    const dir = fixtureDir();
    const f = join(dir, "a.yaml");
    writeFileSync(f, "model: anthropic/old-1\nother: text\nmodel2: anthropic/old-1\n");
    const plan = planReplace("anthropic/old-1", "anthropic/new-2", [f]);
    expect(plan.totalOccurrences).toBe(2);
    expect(plan.files.length).toBe(1);
    expect(plan.files[0].patch).toContain("-model: anthropic/old-1");
    expect(plan.files[0].patch).toContain("+model: anthropic/new-2");
  });

  test("planReplace returns empty when ID absent", () => {
    const dir = fixtureDir();
    const f = join(dir, "a.yaml");
    writeFileSync(f, "model: anthropic/claude-sonnet-5\n");
    const plan = planReplace("anthropic/nope", "anthropic/new-2", [f]);
    expect(plan.totalOccurrences).toBe(0);
  });

  test("applyReplace writes files and snapshots backups", () => {
    const dir = fixtureDir();
    const f = join(dir, "sub", "a.yaml");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(f, "model: anthropic/old-1\n");
    const plan = planReplace("anthropic/old-1", "anthropic/new-2", [f]);
    const backupDir = applyReplace(plan, dir);
    expect(readFileSync(f, "utf-8")).toBe("model: anthropic/new-2\n");
    const backupFile = join(backupDir, "sub", "a.yaml");
    expect(existsSync(backupFile)).toBe(true);
    expect(readFileSync(backupFile, "utf-8")).toBe("model: anthropic/old-1\n");
  });
});

// ============================================================================
// replace-sikkerhet — lagt til 2026-09-22 etter funksjonstest av ModelUpdate
//
// Begge feilmodusene under var DEMONSTRERT mot den gamle implementasjonen,
// ikke antatt. Den spleiset rå delstrenger (`content.split(oldId).join(newId)`)
// uten anker og uten å sjekke at `oldId` i det hele tatt var en modell-ID.
// Arbeidsdelingen var at workflow-prosaen ba operatøren lese diffen og kjøre
// erstatninger fra lengste til korteste ID — altså en regel håndhevet av den
// som husket den.
// ============================================================================

describe("replace — helhets-anker", () => {
  test("en ID som er PREFIKS av en annen røres ikke", () => {
    // Fireworks navngir hver modell som `<id>` og `<id>-priority`. Uten anker
    // ble `-priority`-varianten skrevet om sammen med den den er suffiks av,
    // og resultatet var en ID registeret aldri har hørt om.
    const før = [
      "a: fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest-priority",
      "b: fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest",
    ].join("\n");
    const { text, occurrences } = replaceWholeIds(
      før,
      "fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest",
      "xai/grok-4.7",
    );
    expect(occurrences).toBe(1);
    expect(text).toContain("a: fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest-priority");
    expect(text).toContain("b: xai/grok-4.7");
    // Den gamle oppførselen, eksplisitt: dette skal ALDRI oppstå igjen.
    expect(text).not.toContain("xai/grok-4.7-priority");
  });

  test("anker i begge ender — hverken suffiks- eller prefikstreff", () => {
    const { text, occurrences } = replaceWholeIds(
      "a: xai/grok-4.3\nb: xai/grok-4.30\nc: pre-xai/grok-4.3\n",
      "xai/grok-4.3",
      "xai/grok-4.7",
    );
    expect(occurrences).toBe(1);
    expect(text).toContain("a: xai/grok-4.7");
    expect(text).toContain("b: xai/grok-4.30");
    expect(text).toContain("c: pre-xai/grok-4.3");
  });

  test("planReplace teller det ankeret faktisk vil bytte", () => {
    const dir = mkdtempSync(join(tmpdir(), "model-sync-anker-"));
    const fil = join(dir, "p.yaml");
    writeFileSync(
      fil,
      "x: opencode/big-pickle-free\ny: opencode/big-pickle\n",
      "utf-8",
    );
    const plan = planReplace("opencode/big-pickle", "opencode/mimo-v2.6-flash-free", [fil]);
    expect(plan.totalOccurrences).toBe(1);
  });

  test("applyReplace bruker SAMME anker som dry-run", () => {
    // Sto de to på hver sin regel, ville diffen operatøren godkjente ikke
    // vært den som ble skrevet — og det er verre enn ingen dry-run.
    const dir = mkdtempSync(join(tmpdir(), "model-sync-apply-"));
    const fil = join(dir, "p.yaml");
    const før = "x: xai/grok-4.3-fast\ny: xai/grok-4.3\n";
    writeFileSync(fil, før, "utf-8");
    const plan = planReplace("xai/grok-4.3", "xai/grok-4.7", [fil]);
    applyReplace(plan, dir);
    const etter = readFileSync(fil, "utf-8");
    expect(etter).toBe("x: xai/grok-4.3-fast\ny: xai/grok-4.7\n");
  });
});

describe("erGyldigModellId", () => {
  test("godtar <kjent-leverandør>/<modell>", () => {
    expect(erGyldigModellId("xai/grok-4.7")).toBe(true);
    expect(erGyldigModellId("anthropic/claude-sonnet-5")).toBe(true);
    expect(erGyldigModellId("fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest")).toBe(true);
    expect(erGyldigModellId("ollama/qwen3.5:9b")).toBe(true);
  });

  test("avviser vilkårlig tekst — `replace old=model` rev YAML-nøklene", () => {
    expect(erGyldigModellId("model")).toBe(false);
    expect(erGyldigModellId("")).toBe(false);
    expect(erGyldigModellId("/leading")).toBe(false);
    expect(erGyldigModellId("trailing/")).toBe(false);
  });

  test("avviser ukjent leverandør — en ID vi ikke kan verifisere skal ikke skrives", () => {
    expect(erGyldigModellId("tullball/x")).toBe(false);
    expect(erGyldigModellId("claude-plugin/skills")).toBe(false);
  });
});

describe("collectGoverned", () => {
  test("rapporterer en styrt fil som MANGLER framfor å filtrere den bort", () => {
    // Dette er feilen verktøyet gjorde mot seg selv: `model-config.ts` flyttet
    // fra plugins/lib til pai-core/lib i batch 3, og `.filter(existsSync)`
    // svelget den gamle stien. Fallback-modellkartet var ustyrt uten at noe
    // feilet. En manglende styrt fil skal være HØYLYTT.
    const rot = mkdtempSync(join(tmpdir(), "model-sync-gov-"));
    mkdirSync(join(rot, ".opencode", "profiles"), { recursive: true });
    writeFileSync(join(rot, ".opencode", "profiles", "a.yaml"), "model: xai/grok-4.7\n", "utf-8");
    const g = collectGoverned(rot, join(rot, ".opencode"));
    expect(g.present.some((f) => f.endsWith("a.yaml"))).toBe(true);
    expect(g.missing.some((f) => f.includes("model-config.ts"))).toBe(true);
  });

  test("agentfilene og switch-provider er styrt", () => {
    // Jobbens harness fant begge som stille drift: en `model:` i en agents
    // frontmatter, og modell-ID-er skrevet for hånd i `--help`-teksten.
    const rot = mkdtempSync(join(tmpdir(), "model-sync-gov-"));
    mkdirSync(join(rot, ".opencode", "agents"), { recursive: true });
    mkdirSync(join(rot, ".opencode", "tools"), { recursive: true });
    writeFileSync(join(rot, ".opencode", "agents", "Engineer.md"), "---\nmodel: xai/grok-4.7\n---\n", "utf-8");
    writeFileSync(join(rot, ".opencode", "tools", "switch-provider.ts"), "// xai/grok-4.5\n", "utf-8");
    const g = collectGoverned(rot, join(rot, ".opencode"));
    expect(g.present.some((f) => f.endsWith("agents/Engineer.md"))).toBe(true);
    expect(g.present.some((f) => f.endsWith("tools/switch-provider.ts"))).toBe(true);
    const ids = collectReferences(g.present, rot).map((r) => r.id);
    expect(ids).toContain("xai/grok-4.7");
    expect(ids).toContain("xai/grok-4.5");
  });

  test("den manglende fila blir en advarsel i rapporten", () => {
    const r = buildReport([], new Set(), { ids: new Set(), meta: new Map(), stale: false, ageHours: 1 }, new Date(), [
      "/x/.opencode/pai-core/lib/model-config.ts",
    ]);
    expect(r.warnings.some((w) => w.includes("governed file missing"))).toBe(true);
  });

  test("model-config.ts ligger faktisk der governedFiles peker", () => {
    // Vaktposten som ville ha fanget batch 3-flyttingen med én gang.
    const g = collectGoverned();
    expect(g.missing).toEqual([]);
    expect(g.present.some((f) => f.endsWith("pai-core/lib/model-config.ts"))).toBe(true);
  });
});
