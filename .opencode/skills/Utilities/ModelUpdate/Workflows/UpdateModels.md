# UpdateModels Workflow

Sync every model reference in the repo with the live opencode registry.

## Notification

Running the **UpdateModels** workflow in the **ModelUpdate** skill to sync model lists...

## Overview

The deterministic heavy lifting is done by `.opencode/tools/model-sync.ts` in
the repo: it fetches the registry, collects every reference, classifies drift
and reports JSON/markdown. The LLM only acts when the script surfaces
something that needs judgement — choosing replacements, evaluating new
models, or editing prose.

**Where and when:** in the repo, and only when the user asks for it — never on a
timer (they hear about model releases elsewhere). The change is a PR (step 7);
if the repo delivers to other copies, step 8 says how.

Classification the script produces:

| Class | Meaning | LLM action |
|---|---|---|
| `ok` | Referenced and in the credentialed registry | None |
| `retired` | Absent from both registry and cache — calls will fail | Choose replacement (step 2) |
| `unverifiable` | In full cache, but provider has no credentials | Do NOT touch — not retired |
| `external` | ollama/local models — never registry-checked | None |
| `new` | In credentialed registry, never referenced — **not** necessarily recently released | Evaluate role fit (step 3) |

## Steps

### 1. Run the deterministic check

```bash
cd "$(git -C ~/.opencode rev-parse --show-toplevel)"   # the repo, on any machine
bun run .opencode/tools/model-sync.ts check --json
```

Exit codes:

- `0` — no drift → tell the user everything is in sync and **STOP**. No LLM work.
- `1` — retired IDs found → continue to step 2.
- `2` — only new models → skip to step 3.
- `3` — registry unavailable: v2's catalog is missing from `opencode.db` (start `pai` once), or no provider has a login or key. Stop and report which.
  Never conclude models are retired from a failed fetch.

### 2. Retired IDs (exit 1) — LLM judgement required

For each `retired` entry in the JSON report:

1. Inspect each `file:line` location first. A prose mention that *documents*
   the retirement (e.g. "X er utgått og fjernet fra registeret") is not a live
   reference — leave it.
2. For live references (profiles, `model-config.ts`, and any ID the report
   finds in `agents/*.md` or `switch-provider.ts`), choose the closest
   current model in the same tier from the report (`newModels` / registry):
   flagship→flagship, fast→fast, coding→coding. Use the exact registry ID —
   never construct IDs from marketing names.
3. Apply mechanical renames via the script — always dry-run first:

```bash
bun run .opencode/tools/model-sync.ts replace old=<retired-id> new=<chosen-id>
bun run .opencode/tools/model-sync.ts replace old=<retired-id> new=<chosen-id> --apply
```

`--apply` snapshots every touched file to `~/.cache/model-sync/backups/<ts>/`
and prints the restore command, then re-verifies the old ID is gone.

**Before applying**, inspect the dry-run diff for substring collisions: one
retired ID can be a substring of another (e.g. `codex` inside `codex-mini`).
Run replacements from **longest to shortest** ID to prevent accidental
partial matches.

Routing changes that alter philosophy (not a plain rename) are manual edits.

Keep the routing philosophy per profile: heaviest agent (Algorithm) gets the
deep model, explore/Intern get the fast/cheap one, coding agents
(Engineer/Architect/QATester) get the coding model if the provider has one.

### 3. New models (exit 1 or 2) — LLM judgement required

**Present findings as a mandatory comparison table, not a flat list:**

| Provider | Role | Current pick | New candidate | Released | Decision |
|---|---|---|---|---|---|
| anthropic | Algorithm | `claude-fable-5` | `claude-opus-5` | 2026-07-24 | Replace — real flagship |
| anthropic | all others | `claude-sonnet-5` | `claude-sonnet-4-6` | 2026-02-17 | Keep — current is newer |

Scan every active provider profile's current model picks against `newModels`.
Only replace where the candidate is **both newer and fills the role better**
than the current pick. "New to repo" ≠ "recently released" — always compare
`meta.release_date` against the current model's release to avoid proposing
downgrades.

Explain provider/channel boundaries: a model may exist via one provider but
not another (e.g. `fireworks-ai/kimi-k3` exists, but `opencode/kimi-k3` does
not — explaining this upfront avoids "why didn't you use the newer one?").

Watch dated suffix variants (`-0309`, `-20251001`) — always use the exact ID
from the report.

### 4. Unverifiable IDs — leave alone

The model exists upstream; the provider just lacks credentials in
`~/.opencode/.env`. Only mention it to the user if the provider is expected to be
configured.

### 5. Re-apply active profile if touched

> Dette steget skriver om `agent`-blokken i `opencode.json`, altså LIVE
> konfigurasjon. Kjører brukeren en `pai`-økt samtidig, plukker den opp
> endringen ved neste oppstart — spør før du kjører det hvis du ikke vet.

```bash
cd "$(git -C ~/.opencode rev-parse --show-toplevel)"   # the repo, on any machine
bun run .opencode/tools/switch-provider.ts --current
# if the active profile's yaml changed:
bun run .opencode/tools/switch-provider.ts <active-profile>
```

### 6. Verify

Retired list must now be empty (or only documented prose mentions):

```bash
bun run .opencode/tools/model-sync.ts check
```

Smoke test the default model:

```bash
cd ~/.opencode && set -a && . ./.env && set +a && \
  env PAI_ENABLED=1 ./bin/opencode run "Svar kun med modellnavnet ditt"
```

### 7. Commit — kun de styrte filene

**Aldri `git add -A`.** Dette repoet ER tilstandssynkingen: `MEMORY/` endrer
seg under hver økt, og annet arbeid er nesten alltid ukommittert samtidig.
En `git add -A` herfra sveiper begge deler inn i en commit merket «modeller:
sync», og den feilen er usynlig til noen leser historikken.

Legg til NØYAKTIG det denne skillen styrer, og ingenting mer:

```bash
cd "$(git -C ~/.opencode rev-parse --show-toplevel)"
git switch -c modeller/$(date +%Y-%m-%d) main
git status --short                      # les denne FØR du legger til noe
git add .opencode/profiles/*.yaml .opencode/pai-core/lib/model-config.ts
[ -f runbooks/install.md ] && git add runbooks/install.md   # not in every copy
git diff --cached --stat                 # bekreft at kun styrte filer står der
git commit -m "modeller: sync mot opencode-registeret ($(date +%Y-%m-%d))"
```

`git add` på en sti som ikke er endret er en no-op, så lista kan stå som den
er selv om bare én fil ble rørt.

Commit on a branch and open a PR: the change is model routing for every
agent, and it gets a look before it reaches other machines. Merge only when
the user says so.

### 8. Other copies, after the merge

If the repo has `docs/jobb-harness/modelupdate.md`, it delivers to other copies:
follow that file after the merge. Otherwise there is nothing more to do.

Report to the user: which IDs were retired/replaced, which new models appeared,
whether the active profile was re-applied, the PR, and what was delivered.
