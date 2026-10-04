---
name: HarnessUpdate
description: Check whether Claude Code or OpenCode v2 has a newer version than the pinned one, and flag every change that touches the assumption register. Never upgrades. USE WHEN harness update, new Claude Code version, new OpenCode version, bump claude code, bump opencode, oppdater harnesset, ny motorversjon, er det nye versjoner. SkillSearch('harnessupdate') for docs.
---

# HarnessUpdate

Both engines are pinned exactly in `.opencode/package.json`: `@opencode/cli`
(B3) and `pai.claudeCode` (C1). This skill tells the user when a newer version
exists, and which of its changes touch a row in the assumption register
(`AssumptionRegister.md` next to this file). It is the
`ModelUpdate` of the engines: it reads and reports, and **never upgrades**. A
bump is a branch, the smoke test and a PR.

## Notification

**When executing a workflow, output a text notification:**

```
Running **UpdateHarness** in **HarnessUpdate**...
```

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **UpdateHarness** | "check the engines for updates", "new Claude Code version", "bump claude code", "oppdater harnesset", "er det nye versjoner av motorene" | `Workflows/UpdateHarness.md` |

## Tool

`.opencode/PAI/Tools/HarnessSync.ts` does the deterministic work: reads the
pinning, asks the npm registry for `dist-tags`, fetches the changes since the
pinned version, and matches each line against the register.

```bash
bun .opencode/PAI/Tools/HarnessSync.ts check            # markdown report
bun .opencode/PAI/Tools/HarnessSync.ts check --json     # machine-readable
bun .opencode/PAI/Tools/HarnessSync.ts check --claude-fra 2.1.279 --v2-fra 2.0.16   # since a given version
```

Exit codes: `0` both on latest · `1` newer version, and something touches the
register · `2` newer version, nothing flagged · `3` a source did not answer (no
conclusion for that engine).

**The sources** (MÅLT 2026-09-27): Claude Code's `CHANGELOG.md` in
`anthropics/claude-code`, one `## X.Y.Z` per version. OpenCode v2 has no release
notes for 2.0.x; the tool reads GitHub's compare API between the tags
(`anomalyco/opencode`): commit subjects and changed paths. Test files are
skipped. A compare over 300 files is cut off, and the report says so.

The rules live in `CLAUDE_REGLER`, `V2_REGLER` and `V2_STIER` in the tool, one
per register row. **When a row is added to the register, add its rule too.**
The tests are `tests/harness-sync.test.ts`, with real lines from both sources.

## Examples

**Example 1: Routine check**
User: "Check the engines for updates."
→ Run UpdateHarness; report per engine, or confirm both are on latest.

**Example 2: A release was announced**
User: "Claude Code 2.1.290 is out, can we take it?"
→ Run UpdateHarness; for each flagged line, say which register row it touches
  and what the smoke test will prove. Propose the bump steps; do not run them.
