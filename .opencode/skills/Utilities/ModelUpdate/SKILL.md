---
name: ModelUpdate
description: Update model lists and provider profiles against OpenCode v2's model registry. USE WHEN update models, model list, new models, retired model, oppdater modeller, model IDs outdated. SkillSearch('modelupdate') for docs.
---

# ModelUpdate

Keeps every model reference in this repo in sync with what OpenCode v2's model
registry actually offers. Detects retired model IDs (referenced but no longer
available) and new models, then updates profiles, plugin fallbacks and docs.

## Notification

**When executing a workflow, output a text notification:**

```
Running **UpdateModels** in **ModelUpdate**...
```

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **UpdateModels** | "update models", "oppdater modell-listene", "new models available", "model X is retired" | `Workflows/UpdateModels.md` |

## Where it runs

In the repo, when the user asks — never on a timer. The change is a PR; if the
repo delivers to other copies, step 8 of the workflow says how.

## Files this skill governs

| File | Role |
|---|---|
| `.opencode/profiles/*.yaml` | Per-agent model routing per provider profile |
| `.opencode/profiles/researchers.yaml` | Native models for researcher agents |
| `.opencode/pai-core/lib/model-config.ts` | Plugin fallback model map |
| `.opencode/agents/*.md` | None of ours sets `model:`; models come from `opencode.json` and the profiles. Scanned so one that appears is reported |
| `.opencode/tools/switch-provider.ts` | Its `--help` researcher list is read from `researchers.yaml`; scanned so hand-written IDs do not creep back |
| `runbooks/install.md` | Key table referencing researcher models |

These are exactly the files `governedFiles()` in `model-sync.ts` returns. A
governed file that is missing is a warning in the report, not silence.

## Tool

`.opencode/tools/model-sync.ts` does the deterministic work: registry read,
reference collection, drift classification, and mechanical renames (`check` /
`replace`, with automatic backups). The UpdateModels workflow orchestrates it;
the LLM only acts on drift the script reports.

```bash
bun run .opencode/tools/model-sync.ts check          # markdown report
bun run .opencode/tools/model-sync.ts check --json   # machine-readable
bun run .opencode/tools/model-sync.ts list xai       # models you can use from one provider (--all: whole catalog)
bun run .opencode/tools/model-sync.ts replace old=<id> new=<id>          # dry-run diff
bun run .opencode/tools/model-sync.ts replace old=<id> new=<id> --apply  # write + backup + re-verify
```

Exit codes for `check`: `0` no drift · `1` retired IDs found · `2` only new
models · `3` registry unavailable. Every referenced ID is classified as `ok` /
`retired` / `unverifiable` (provider lacks credentials, **not** retired) /
`external` (ollama/local), and `new` lists models from the credentialed
registry.

**The registry is v2's own** (M-38): the models.dev catalog that v2 caches in
`~/.local/share/opencode/opencode.db` (`kv`, key `models-dev:catalog`), read
read-only. A provider counts as credentialed when it has a login (`opencode
auth login`, the `credential` table) or one of the catalog's `env` keys is set in
`.env` or the environment. v2 refreshes the catalog when it runs; a catalog
older than 24 h is a warning in the report, and `pai` once refreshes it. Exit 3
means the catalog is missing (v2 has never run on this machine) or no provider
has a login or key.

The tests live in `tests/model-sync.test.ts`. **Do not put a test file in
`.opencode/tools/`**: a test file there can stop opencode from loading.

## Examples

**Example 1: Routine check**
User: "Sjekk om modell-listene er oppdatert"
→ Run UpdateModels workflow; report drift or confirm all current.

**Example 2: Provider announced new models**
User: "xAI har sluppet Grok 5, oppdater"
→ Run UpdateModels workflow; verify the new ID exists in the registry before
  writing it anywhere.
