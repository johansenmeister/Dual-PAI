# Scan — discover skill gaps from work history and low ratings

Read-only. Proposes only. Never creates a skill (that is CreateSkill, after the user approves).

Running **Scan** in **SuggestSkills**...

## Step 0 — Sufficiency check

The corpus is the context. If the tool reports the ratings store missing, or the window holds only a few low ratings, the frustration signal is weak for this run: say so in the report rather than presenting a topic-only result as complete. If the user asked about a specific domain ("am I missing anything around backups?"), scope the clustering to it and say you did.

## Step 1 — Gather deterministically (tool, not prose)

```bash
corpus="$(mktemp -d)/corpus.json"
bun ~/.opencode/skills/Utilities/SuggestSkills/Tools/CollectSignals.ts --days 45 > "$corpus"
echo "$corpus"
```

Read the file in parts (`warnings` and `missing` first, then `frustrations`, then `sessions`); the session list can be long. Do not re-gather by hand: the tool is the single source of evidence, so two runs judge the same corpus.

### Intent-to-flag mapping

| User says | Flag | Effect |
|-----------|------|--------|
| (default), "recently", "lately" | `--days 45` | 45-day window |
| "this quarter", "last few months" | `--days 90` | wider window; a much longer session list |
| "all time", "everything" | `--days 3650` | full history (clamped at 3650) |
| "only the really bad ones" | `--max-rating 2` | tighter frustration cut (default 4) |
| "scan another install / another tree" | `--root <dir>` | every store under a different PAI home |
| a store lives somewhere non-standard | `--ratings <file>` `--work <dir>` `--skills <dir>` | override one store; a bad explicit path is reported, never silently defaulted |

The root is `--root`, else `$PAI_HOME`, else the `.opencode` the tool lives in. The corpus is `{ window, sessions[], frustrations[], registries[], warnings[], missing[], sources }`:

- `sessions`: `{ slug, date, title, harness }` — one per work session in the window.
- `frustrations`: `{ date, rating, source, harness, note }` — ratings at or below `--max-rating`; `source` is `explicit` (the user typed a score) or `implicit` (inferred from the message).
- `registries`: `{ kind, name, path, description }` — every skill and workflow; `path` is relative to the skills tree, so the body can be read for Step 3.

## Step 2 — Cluster by pain

Group `sessions` and `frustrations` into recurring themes. For each theme carry two numbers: recurrence (how many sessions) and friction (how many low ratings, plus recurrence markers in the titles like "again", "still", "fortsatt", "igjen"). Frustration outweighs raw topic frequency.

## Step 3 — Classify each cluster

- **BEHAVIOR-FEEDBACK** — verbosity, scope misreads, reminder cadence. Not a skill; route to the steering rules or memory. Exclude.
- **COVERED** — an existing skill or workflow genuinely handles the *discipline*. Confirm by reading the covering unit's body (`skills/<path>`), not its name; map the specific failure class to explicit guidance in it. If the body does not address the failure, it is not covered.
- **GAP** — recurs (severity-weighted; a high-severity repeated pain qualifies even below ~3 sessions) AND is uncovered, including a discipline gap under a topic another skill nominally covers.

## Step 4 — Two independent passes, report the UNION

Spawn two subagents that classify the clusters from the same corpus file, without seeing each other's result. Report every cluster either flags as GAP, tagged by agreement: `both` (high confidence) or `one` (needs review). Do NOT drop single-pass gaps: strict intersection hides the subtle discipline gaps this skill exists to surface.

## Step 5 — Propose, never create

Emit a ranked shortlist. Each proposal: name, one-line description, and evidence (recurrence, friction, the specific recurring failure it would prevent). Redact secrets, client and project names, and personal paths from anything written outside the chat. Accepted proposals go to `CreateSkill` as a separate, user-approved step. This workflow writes no skill.

Answer in the user's language; the session titles are in theirs.

## Output

```
## Skill-gap scan (last N days, M sessions, K low ratings)
### Gaps worth building
- <Name> [confidence: both|one] — <desc>. Evidence: N sessions, K frustration signals, recurring failure = "<...>". → CreateSkill?
### Covered (verified against bodies, no action)
- <theme> → <skill/workflow>
### Behavior-feedback (route to steering rules or memory, not a skill)
- <theme>
### Recommendation
<1-2 sentences; "nothing new" is valid ONLY when the frustration signals are also clean>
```
