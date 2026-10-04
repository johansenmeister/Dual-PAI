# MineReflections Workflow

## Announcement

Når denne workflowen kjøres, si fra i svaret:

```
Running the **MineReflections** workflow in the **PAIUpgrade** skill to mine internal algorithm reflections...
```

**Trigger:** "mine reflections", "check reflections", "what have we learned", "internal improvements", "reflection insights"

---

## Overview

The Algorithm writes a structured reflection after every Standard+ run to `MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl`. Each entry contains three questions focused on algorithm performance:

- **Q1 (Self):** What would I have done differently?
- **Q2 (Algorithm):** What would a smarter algorithm have done differently?
- **Q3 (AI):** What would a fundamentally smarter AI have done differently?

This workflow mines those reflections for **recurring themes** and produces **actionable upgrade candidates** for the Algorithm, skills, hooks, or system architecture.

---

## Data Schema

Each JSONL entry contains:

```json
{
  "timestamp": "ISO or epoch",
  "effort_level": "Standard|Extended|Advanced|...",
  "task_description": "What was being done",
  "criteria_count": 12,
  "criteria_passed": 12,
  "criteria_failed": 0,
  "prd_id": "PRD-YYYYMMDD-slug",
  "implied_sentiment": 8,
  "reflection_q1": "Self-reflection on algorithm execution",
  "reflection_q2": "What a smarter algorithm would do differently",
  "reflection_q3": "What a fundamentally smarter AI would do",
  "within_budget": true,
  "rework_count": 0
}
```

---

## Execution

### Step 1: Read All Reflections

```
Read ~/.opencode/MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl

Parse each line as JSON. Collect all entries into an array.
Report: "Found N reflections spanning [date range]"
```

If file doesn't exist or is empty: report "No reflections found — run some Standard+ tasks first" and stop.

### Step 2: Signal Prioritization

**Not all reflections are equally valuable.** Weight entries by signal strength:

| Signal | Weight | Rationale |
|--------|--------|-----------|
| `implied_sentiment` ≤ 5 | HIGH | Low satisfaction = something went wrong worth fixing |
| `implied_sentiment` 6-7 | MEDIUM | Room for improvement |
| `implied_sentiment` 8-10 | LOW | Things went well — less urgent |
| `within_budget: false` | BOOST | Over-budget = structural issue |
| `criteria_failed > 0` | BOOST | Failed criteria = verification gap |
| `rework_count > 0` | BOOST | Rework = initial approach was wrong |

**Highest signal entries:** Low sentiment + substantive Q2 answer + over-budget. These are the gold.

### Step 3: Theme Extraction

For each question category (Q1, Q2, Q3), cluster the answers into themes:

**Q2 Themes (Algorithm Improvements) — PRIMARY OUTPUT:**
- Group similar Q2 answers together
- Count frequency: how many reflections mention this theme?
- Identify the underlying structural issue each theme points to
- Example themes: "ISC quality gates too lenient", "Phase budgets not enforced", "Capability selection too conservative"

**Q1 Themes (Execution Patterns) — SECONDARY:**
- Recurring execution mistakes (e.g., "should have read file before editing", "agent overhead for simple tasks")
- These suggest workflow guardrails or pre-flight checks

**Q3 Themes (Fundamental Improvements) — ASPIRATIONAL:**
- Patterns in what a smarter AI would do differently
- These inform longer-term architecture decisions

### Step 4: Synthesize Upgrade Candidates

For each theme with **2+ occurrences** (or 1 occurrence if sentiment ≤ 4):

```
UPGRADE CANDIDATE: [Theme Name]
  Frequency: N reflections
  Signal strength: HIGH/MEDIUM/LOW
  Supporting reflections:
    - [timestamp] [task_description] — "[relevant Q2 quote]"
    - [timestamp] [task_description] — "[relevant Q2 quote]"
  Root cause: [What structural issue causes this pattern]
  Proposed fix: [Specific change to Algorithm, skill, hook, or system]
  Target: [Which PAI files would change]
  Effort estimate: [Instant/Fast/Standard/Extended]
```

### Step 5: Prioritize and Output

Sort upgrade candidates by:
1. Frequency (most recurring first)
2. Signal strength (highest first)
3. Effort estimate (lowest first — quick wins bubble up)

---

## Output Format

```markdown
# Internal Reflection Mining Report

**Source:** ~/.opencode/MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl
**Entries analyzed:** N
**Date range:** [earliest] to [latest]
**High-signal entries:** N (sentiment ≤ 5 or over-budget or failed criteria)

## Top Upgrade Candidates

### 1. [Theme Name] (N occurrences, HIGH signal)
**Root cause:** ...
**Proposed fix:** ...
**Target:** ...
**Effort:** ...
**Evidence:**
- ...

### 2. [Theme Name] ...

## Execution Pattern Warnings (from Q1)
- [Recurring mistake] — seen N times
- ...

## Aspirational Insights (from Q3)
- [Fundamental improvement] — seen N times
- ...

## Next Steps
- Run `algorithm upgrade` to generate section-targeted Algorithm spec changes
- Review upgrade candidates and prioritize implementation
```

---

## Mitigation Ledger

Every theme is checked against `MEMORY/LEARNING/MITIGATIONS/mitigations.jsonl` and lands in one of three buckets:

| Bucket | Condition | Why it matters |
|---|---|---|
| **Regression** | A mitigation exists, and supporting entries are dated *after* it | A fix that did not hold. Ranked above everything else |
| **New** | No mitigation recorded | Ranked by frequency, as before |
| **Addressed** | A mitigation exists and all supporting evidence predates it | Collapsed to one line so it stops competing for attention |

The model links a theme to a ledger id; the **dates** decide what that link means. The model cannot mark a theme resolved.

After implementing a fix, record it:

```bash
bun ~/.opencode/PAI/Tools/RecordMitigation.ts \
  --theme "phrase it the way the report phrases the theme" \
  --artifact PATH --commit SHA [--note "what changed"]
```

**Never trim the reflections log.** Deleting mined entries destroys the only evidence that can prove a fix did not hold — `infrastructure-safety-rules.md` was written 2026-08-14 and the same failure class recurred three times afterwards, which is visible only because those entries are still there.

---

## Integration with AlgorithmUpgrade

After this workflow runs, the user can invoke **AlgorithmUpgrade** to:
1. Take the theme list from this report
2. Cross-reference against the current Algorithm spec
3. Generate concrete, section-targeted diffs for the Algorithm itself
