# PAI PRD Format Specification v2.0

The PRD (Product Requirements Document) is the single source of truth for every Algorithm run.
The AI writes all PRD content directly using Write/Edit tools. Hooks only read PRDs to sync state.

## Frontmatter (YAML)

The fields the hooks read (`prd-sync`, the phase tracker, the compaction context,
session cleanup). The loop mode (`algorithm.ts`) adds its own fields when it
creates a PRD; they are not needed interactively.

```yaml
---
id: PRD-20260928-kebab-task                # PRD-{YYYYMMDD}-{slug}, unique
title: "8 word task description"          # What this work is
status: ACTIVE                            # ACTIVE|COMPLETED|FAILED|BLOCKED
effort_level: Standard                    # Standard|Extended|Advanced|Deep|Comprehensive
last_phase: OBSERVE                       # OBSERVE|THINK|PLAN|BUILD|EXECUTE|VERIFY|LEARN
verification_summary: "0/8"               # checked criteria / total criteria
failing_criteria: []                      # inline list, e.g. ["ISC-3"]
iteration: 0                              # incremented on continuation
created: 2026-09-28                       # set once
updated: 2026-09-28                       # every Edit/Write
completed_at: null                        # set when done (or by session cleanup)
---
```

### Field Rules

- `id`: Set once. `PRD-{YYYYMMDD}-{slug}` with a short kebab slug.
- `title`: Imperative mood, max 60 chars. Describes the deliverable, not the process.
- `status`: `ACTIVE` from creation. Set `COMPLETED`, `FAILED` or `BLOCKED` when done; an `ACTIVE` PRD is marked `COMPLETED` at session end.
- `effort_level`: Determines ISC count range and time budget. See Algorithm for tier definitions.
- `last_phase`: Updated at the START of each Algorithm phase.
- `verification_summary`: `M/N` where M = checked ISC criteria, N = total. Updated immediately when a criterion passes (don't wait for VERIFY).
- `failing_criteria`: Inline list only; a multi-line YAML list is not read.
- `iteration`: `0` on the first run, incremented on each continuation.
- `updated`: Set on every Edit/Write.

## Body Sections

Four sections. Each appears only when populated — never create empty placeholder sections.

### ## Context

Written during OBSERVE. Captures:
- What was explicitly requested and not requested
- Why this task matters
- Key constraints and dependencies
- Risks and riskiest assumptions (merged here, no separate Risks section)

For Advanced+ effort, a `### Plan` subsection may be added with technical approach details.

### ## Criteria

ISC (Ideal State Criteria) checkboxes. Written during OBSERVE, checked during EXECUTE/VERIFY.

```markdown
- [ ] ISC-1: Criterion text (8-12 words, binary testable, state not action)
- [ ] ISC-2: Another criterion
- [ ] ISC-A-1: Anti: What must NOT happen
```

**Rules:**
- Each criterion: 8-12 words, describes an end state (not an action)
- Binary testable: either true or false, no judgment required
- **Atomic**: one verifiable thing per criterion — no compound statements
- Anti-criteria prefixed `ISC-A-`: things that must NOT be true
- ID format: `ISC-N` for criteria, `ISC-A-N` for anti-criteria
- Check (`- [x]`) immediately when satisfied — don't batch at VERIFY
- Update frontmatter `verification_summary` on every check change

**Atomicity — the Splitting Test (apply to every criterion):**
- Contains "and"/"with"/"including" joining two verifiable things? → split
- Can part A pass while part B fails independently? → split
- Contains "all"/"every"/"complete"? → enumerate what that means
- Crosses domain boundaries (UI/API/data/logic)? → one per boundary

**Count enforcement:** Total ISC must meet effort tier floor (Standard: 8, Extended: 16, Advanced: 24, Deep: 40, Comprehensive: 64). If below floor after first pass, decompose compound criteria until met.

### ## Decisions

Timestamped decision log. Written during any phase when non-obvious choices are made.

```markdown
- 2026-02-24 02:00: Chose X over Y because Z
- 2026-02-24 02:15: Rejected approach A due to performance concern
```

### ## Verification

Evidence for each criterion. Written during VERIFY phase.

```markdown
- ISC-1: Screenshot confirms layout renders correctly
- ISC-2: `bun test` passes, 14/14 tests green
- ISC-A-1: Confirmed no PII in output via grep
```

## File Location

```
<PAI work session directory>/PRD.md
```

The directory is given in context as «PAI work session directory»
(`MEMORY/WORK/{YYYY-MM}/{timestamp}_{slug}/`). It exists already; do not create
your own under `MEMORY/WORK/`. Session cleanup and the compaction context look
for the PRD there, and nowhere else.

## Continuation / Rework

When a follow-up prompt continues the same task:

1. AI detects recent PRD matching the task context
2. Edit existing PRD: set `last_phase: OBSERVE` and `status: ACTIVE`, increment `iteration`, update `updated`
3. Re-enter Algorithm phases as needed

When it's a genuinely new task: create a new PRD with a new slug.

## Sync Pipeline

PRD is read-only from hooks' perspective:

1. **AI writes PRD** via Write/Edit tools
2. **`prd-sync`** fires after the tool call and writes the frontmatter to `STATE/prd-registry.json` (keyed by `id`)
3. **The phase tracker** reads `last_phase` and the ISC checkboxes into the session's state
4. **Compaction** puts the PRD's status and criteria into the summary; **session cleanup** marks an `ACTIVE` PRD `COMPLETED`

The AI is the only writer of content; session cleanup only flips `status` and `completed_at`.

## Design Rationale

This format is informed by research across Kiro (AWS), spec-kit (GitHub), OpenSpec, BMAD,
Google Design Docs, Amazon 6-pagers, Shape Up pitches, and 48 production PAI PRDs.

Key design choices:
- **Only fields the hooks read**: Dead fields waste tokens. Loop-mode fields are added by `algorithm.ts`, not written by hand.
- **4 sections, not 7**: Risks merged into Context. Plan merged into Context. Changelog dropped (git serves this purpose).
- **Checkboxes over EARS/BDD**: Simpler to parse, write, and verify. ISC pattern proven over 48 PRDs.
- **YAML frontmatter over JSON**: Universal standard (Jekyll, Hugo, Astro, Kiro, spec-kit all use it).
- **Convention-based sections**: Sections appear when needed, not as empty boilerplate.
- **Reference file pattern**: This spec lives at `~/.opencode/PAI/PRDFORMAT.md`, not inline in AGENTS.md. Saves ~2,500 tokens/response.
