---
name: Telos
description: "Dual-context skill: Personal TELOS reads and updates goals, beliefs, narratives, strategies with timestamped backups; Project TELOS analyzes .md/.csv directories for dependency chains, bottlenecks, and alignment, generating reports, narrative points, or dashboards. USE WHEN telos, life goals, projects, dependencies, update telos, narrative points, McKinsey report, dashboard, what am I wrong about, life frames, mental models, tracking, books, movies."
---

# Telos

Reads and updates two kinds of context. **Personal TELOS**: {principal.name}'s life context — goals, beliefs, wisdom, books, movies, challenges, narratives, strategies, mission, models, predictions, lessons, wrong-beliefs — at `~/.opencode/PAI/USER/TELOS/`, updated through the Update workflow with timestamped backups. **Project TELOS**: analyzes a directory of .md/.csv files to extract dependency chains (PROBLEMS→GOALS→STRATEGIES→PROJECTS), bottlenecks, alignment, and progress, then produces a report, narrative points, or a Next.js dashboard.

## Notification

**When executing a workflow, output text notification:**

```
Running the **WorkflowName** workflow in the **Telos** skill to ACTION...
```

## Context Detection

| User Request | Context | Location |
|---------------|---------|----------|
| "my TELOS", "my goals", "my beliefs", "add to TELOS" | Personal TELOS | `~/.opencode/PAI/USER/TELOS/` |
| "analyze [project]", "dashboard for", "TELOS report for" | Project TELOS | User-specified directory |

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Update** | "add to TELOS", "update my goals", "add book to TELOS" | `Workflows/Update.md` |
| **InterviewExtraction** | "extract content", "extract interviews", "analyze interviews" | `Workflows/InterviewExtraction.md` |
| **CreateNarrativePoints** | "create narrative", "narrative points", "TELOS report", "n=24" | `Workflows/CreateNarrativePoints.md` |
| **WriteReport** | "write report", "McKinsey report", "professional report" | `Workflows/WriteReport.md` |

For general project analysis, dashboards, and dependency mapping without a report deliverable, the skill handles these directly without a separate workflow file.

---

# Part 1: Personal TELOS

**CRITICAL PATH:** `~/.opencode/PAI/USER/TELOS/` — never directly under the skill directory.

### Files (created lazily as life data accumulates; skip any not yet present)
- **Core:** TELOS.md, MISSION.md, BELIEFS.md, WISDOM.md
- **Life data:** BOOKS.md, MOVIES.md, LESSONS.md, WRONG.md
- **Mental models:** FRAMES.md, MODELS.md, NARRATIVES.md, STRATEGIES.md
- **Goals:** GOALS.md, PROJECTS.md, PROBLEMS.md, CHALLENGES.md, PREDICTIONS.md, TRAUMAS.md
- **Change tracking:** updates.md

**Never manually edit.** Use `Workflows/Update.md` — it creates a timestamped backup in `backups/`, logs the change in `updates.md`, and preserves version history.

---

# Part 2: Project TELOS (Organizational Analysis)

Point the skill at any project directory (`find $TARGET_DIR -type f \( -name "*.md" -o -name "*.csv" \)`) and it surfaces:

1. **Relationship discovery** — how files/entities connect
2. **Dependency mapping** — PROBLEMS→GOALS→STRATEGIES→PROJECTS chains
3. **Goal extraction** — stated and implied objectives
4. **Progress analysis** — advancement and metrics
5. **Narrative generation** — executive summaries
6. **Visual dashboards** — Next.js UI with data

Deliver in whatever format was asked: markdown report (Mermaid diagrams), interactive dashboard, JSON export, or executive summary — grounded in what the files actually say, never cached assumptions.

### Building Dashboards

Start from the shipped scaffold at `DashboardTemplate/` (working Next.js app: file browser, markdown/CSV rendering, dependency views) rather than from scratch, then adapt pages to the analysis. Stack: Next.js + TypeScript + shadcn/ui + Tailwind.

### McKinsey-Style Reports

`WriteReport` first runs `CreateNarrativePoints` to generate story content, then maps the narrative to a report structure: cover page, executive summary, findings, recommendations, roadmap. Output at `{project_dir}/report` — run `bun dev` to view.

---

## Security & Privacy

**Personal TELOS:** Never commit to public repos, never share publicly, always backup before changes, use Update workflow only.

**Project TELOS:** May contain sensitive data — ask before sharing externally, redact sensitive info in examples.

## Gotchas

- **Telos data is personal and private.** Never include in public repos, skills, or outputs.
- **Goals and dependencies change — always read current state before advising.** Don't rely on cached knowledge.
- **Project dashboards pull from multiple sources.** Verify data freshness before presenting.

## Customization

**Before executing, check for user customizations at:**
`~/.opencode/PAI/USER/SKILLCUSTOMIZATIONS/Telos/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there.
