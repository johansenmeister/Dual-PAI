# PAI to PAI-OpenCode Mapping Guide

**Version:** 2.1
**Created:** 2026-01-24
**Updated:** 2026-02-19
**Purpose:** Reference document for correctly importing PAI components into PAI-OpenCode

---

## Executive Summary

PAI-OpenCode is a vanilla PAI implementation adapted for OpenCode's architecture. Currently synced to **Algorithm v1.8.0** (upstream v3.0). This document defines the mapping rules between Daniel Miessler's PAI structure and PAI-OpenCode's conventions.

---

## Architecture Comparison

| Aspect | PAI v3.0 (Claude Code) | PAI-OpenCode |
|--------|----------------------|--------------|
| **Root Directory** | `.claude/` | `.opencode/` |
| **Lifecycle Events** | `hooks/*.hook.ts` | `pai-core/handlers/*.ts` |
| **Config Schema** | Claude Code settings.json | OpenCode settings.json |
| **Meta File** | `CLAUDE.md` | `AGENTS.md` |
| **Path Variable** | `$PAI_DIR` → `~/.claude` | `$PAI_DIR` → `.opencode` |

---

## Component Mapping Rules

### 1. Skills (1:1 Mapping)

**Rule:** Direct copy, no structural changes.

```
PAI 2.4:        .claude/skills/{SkillName}/
PAI-OpenCode:   .opencode/skills/{SkillName}/

Structure preserved:
├── SKILL.md              # Required: Skill definition
├── Workflows/            # Optional: Markdown workflows
├── Tools/                # Optional: TypeScript tools
├── Data/                 # Optional: YAML/JSON data
└── README.md             # Optional: Documentation
```

**⚠️ CRITICAL:** Never create nested `SkillName/SkillName/` structures. That pattern is only for distribution Packs, not installed skills.

### 2. Agents (1:1 Mapping)

**Rule:** Direct copy, adjust color format for OpenCode.

```
PAI 2.4:        .claude/agents/*.md
PAI-OpenCode:   .opencode/agents/*.md
```

**OpenCode Requirement:** Colors must be hex format (`#00FFFF`), not names (`cyan`).

### 3. Hooks → Plugins (Architectural Adaptation)

**Rule:** Rewrite hooks as handlers in `pai-core/handlers/`. They are engine-independent; the OpenCode v2 adapter (`pai-adapters/opencode-v2/`) and the Claude Code plugin (`claude-plugin/`) map each engine's hooks onto them. See `PAI/THEPLUGINSYSTEM.md`.

| PAI 2.4 Hook | PAI-OpenCode Handler | Event |
|--------------|---------------------|-------|
| `LoadContext.hook.ts` | `context-loader.ts` | SessionStart |
| `SecurityValidator.hook.ts` | `security-validator.ts` | PreToolUse |
| `AgentOutputCapture.hook.ts` | `agent-capture.ts` | SubagentStop |
| `ExplicitRatingCapture.hook.ts` | `rating-capture.ts` | UserPromptSubmit |
| `WorkCompletionLearning.hook.ts` | `learning-capture.ts` | SessionEnd |
| `AutoWorkCreation.hook.ts` | `work-tracker.ts` | UserPromptSubmit |

**Structure:**
```
.opencode/
├── pai-core/               # Engine-independent core: dispatch(PaiEvent) → PaiResult
│   ├── dispatch/
│   ├── handlers/           # security-validator.ts, work-tracker.ts, …
│   └── lib/                # paths.ts, identity.ts, …
└── pai-adapters/
    └── opencode-v2/        # OpenCode v2 adapter (a directory with package.json)
claude-plugin/              # Claude Code adapter (repo root)
```

### 4. PAI Skill (Special Handling)

**Rule:** PAI skill has sub-structures that must be preserved.

```
.opencode/skills/PAI/
├── SKILL.md                # The Algorithm + Core Instructions
├── SYSTEM/                 # System documentation (updatable)
│   ├── PAISYSTEMARCHITECTURE.md
│   ├── SKILLSYSTEM.md
│   ├── THEHOOKSYSTEM.md → THEPLUGINSYSTEM.md (renamed)
│   └── ...
├── USER/                   # User customization (never overwrite)
│   ├── TELOS/
│   ├── SKILLCUSTOMIZATIONS/
│   └── ...
├── Tools/                  # TypeScript utilities
└── Workflows/              # Workflow guides
```

**Path References:** Replace all `~/.claude/` with `.opencode/` in documentation.

### 5. MEMORY (1:1 Mapping)

**Rule:** Direct copy, same subdirectory structure.

```
.opencode/MEMORY/
├── LEARNING/
│   └── ALGORITHM/
├── SECURITY/
├── STATE/
├── VOICE/
├── WISDOM/              # NEW in v1.8.0 — Domain wisdom frames
│   ├── README.md
│   ├── architecture.md
│   ├── communication.md
│   ├── deployment.md
│   ├── development.md
│   └── security.md
└── WORK/
```

### 6. Fabric Patterns (1:1 Mapping)

**Rule:** Copy to `skills/Fabric/Patterns/` ONLY. Never duplicate elsewhere.

```
PAI 2.4:        .claude/skills/Fabric/Patterns/
PAI-OpenCode:   .opencode/skills/Fabric/Patterns/

⚠️ DO NOT copy to PAI/Tools/fabric/ - that creates duplicates!
```

---

## Agent Type Mapping (CRITICAL)

⚠️ **CASE-SENSITIVE:** Agent type names must match EXACTLY. `explore` ≠ `Explore`.

OpenCode has **built-in agents** (part of the framework) plus **custom agents** (from `.opencode/agents/`).

### Built-in Agent Types (from OpenCode framework)

These work without any agent definition file:

| subagent_type | Purpose | Notes |
|---------------|---------|-------|
| `general` | General-purpose multi-step tasks | Default for complex tasks |
| `explore` | Fast codebase exploration | ⚠️ **lowercase!** Claude Code used `Explore` (TitleCase) — this WILL FAIL |

### Custom Agent Types (from `.opencode/agents/`)

Defined by `.md` files in the agents directory:

| subagent_type | Purpose |
|---------------|---------|
| `Algorithm` | ISC & Algorithm specialist |
| `Architect` | Elite system design |
| `Engineer` | Principal engineer, TDD |
| `Intern` | 176 IQ genius generalist, parallel grunt work |
| `Designer` | Elite UX/UI specialist |
| `QATester` | Quality assurance validation |
| `Pentester` | Offensive security specialist |
| `Artist` | Visual content creator |
| `writer` | Content creation, docs, technical writing |
| `researcher` | Web research, source verification |
| `DeepResearcher` | Academic researcher (Claude WebSearch) |
| `GeminiResearcher` | Multi-perspective researcher (Google Gemini) |
| `PerplexityResearcher` | Investigative journalist (Perplexity API) |
| `GrokResearcher` | Contrarian researcher (xAI Grok) |
| `CodexResearcher` | Technical archaeologist (O3, GPT-5-Codex, GPT-4) |

### Claude Code → OpenCode Migration

| Claude Code Agent | OpenCode Equivalent | Notes |
|-------------------|---------------------|-------|
| `Explore` (TitleCase) | `explore` (lowercase) | Built-in — just fix the case! |
| `Plan` | `Architect` | No direct equivalent, use Architect |
| `general-purpose` | `general` or `Intern` | `general` is built-in |

**When porting workflows:**
1. Replace `subagent_type: "Explore"` with `subagent_type: "explore"` (lowercase!)
2. Replace `subagent_type: "Plan"` with `subagent_type: "Architect"`
3. Replace `subagent_type: "general-purpose"` with `subagent_type: "general"`

---

## What NOT to Import

These PAI 2.4 components are not applicable to OpenCode:

| Component | Reason |
|-----------|--------|
| `Observability/` | Vue dashboard - not ported |
| `VoiceServer/` | macOS voice server - not ported |
| `lib/migration/` | PAI version migration tools |
| `PAIInstallWizard.ts` | Claude Code specific installer |
| `statusline-command.sh` | Terminal statusline integration |
| `settings.json` hooks section | Different plugin architecture |

---

## OpenCode-Specific Additions

These exist in PAI-OpenCode but not in PAI 2.4:

| Component | Purpose |
|-----------|---------|
| `plugins/` | OpenCode plugin system |
| `profiles/` | API provider profiles (anthropic, openai, local) |
| `PAISECURITYSYSTEM/` | Security documentation (moved from PAI/SYSTEM) |
| `package.json` | Bun dependencies |
| `tsconfig.json` | TypeScript configuration |

---

## Import Checklist

When importing a new PAI version:

### Pre-Import
- [ ] Read PAI release notes for structural changes
- [ ] Compare skill counts (should match)
- [ ] Check for new skills to add
- [ ] Check for removed/renamed skills

### During Import
- [ ] Copy skills maintaining flat structure (no nesting)
- [ ] Copy agents, convert color names to hex
- [ ] Review hook changes, update plugin handlers
- [ ] Update PAI/SYSTEM docs with new content
- [ ] Preserve PAI/USER (never overwrite)

### Post-Import
- [ ] Verify SKILL.md count matches
- [ ] Check for duplicate Fabric patterns
- [ ] Test OpenCode startup (no ConfigFrontmatterError)
- [ ] Run skill search to verify all skills load
- [ ] Update version in documentation

---

## Common Import Errors

### 1. Nested SKILL.md Files
**Error:** `ConfigFrontmatterError: Failed to parse YAML frontmatter`
**Cause:** Imported `SkillName/SkillName/SKILL.md` pattern from Packs
**Fix:** Delete inner nested directories, keep only `SkillName/SKILL.md`

### 2. Description Too Long
**Error:** `ConfigFrontmatterError` at high column number
**Cause:** YAML description exceeds ~300 characters
**Fix:** Shorten description to <220 characters

### 3. Invalid Color Format
**Error:** `Invalid hex color format color`
**Cause:** Using color names (`cyan`) instead of hex (`#00FFFF`)
**Fix:** Convert all agent colors to hex format

### 4. Duplicate Fabric Patterns
**Symptom:** Repo size unexpectedly large
**Cause:** Patterns copied to multiple locations
**Fix:** Keep only `skills/Fabric/Patterns/`, remove from `PAI/Tools/`

---

## v3.0 Feature Mapping

The following features were added in PAI v3.0 (Algorithm v1.2.0–v1.8.0):

### Algorithm v1.2.0 (Base)

| v3.0 Feature | Claude Code | OpenCode | Status |
|---|---|---|---|
| Constraint Extraction [EX-N] | In SKILL.md | In SKILL.md | ✅ Ported |
| Self-Interrogation | In SKILL.md | In SKILL.md | ✅ Ported |
| Build Drift Prevention | In SKILL.md | In SKILL.md | ✅ Ported |
| Verification Rehearsal | In SKILL.md | In SKILL.md | ✅ Ported |
| Mechanical Verification | In SKILL.md | In SKILL.md | ✅ Ported |
| 8 Effort Levels | FormatReminder hook | format-reminder.ts handler | ✅ Ported |
| 7 Quality Gates | In SKILL.md | In SKILL.md | ✅ Ported |
| 25-Capability Audit | In SKILL.md | In SKILL.md (adapted) | ✅ Ported |
| PRD System | ~/.claude/MEMORY/WORK/ | ~/.opencode/MEMORY/WORK/PRD/ | ✅ Ported |
| ISC Naming Convention | In SKILL.md | In SKILL.md | ✅ Ported |
| Anti-Criteria | In SKILL.md | In SKILL.md | ✅ Ported |
| Algorithm Reflection JSONL | In SKILL.md | In SKILL.md | ✅ Ported |
| Start Symbol ♻︎ | In SKILL.md | In SKILL.md | ✅ Ported |
| OBSERVE Hard Gate | In SKILL.md | In SKILL.md | ✅ Ported |
| AUTO-COMPRESS 150% | In SKILL.md | In SKILL.md | ✅ Ported |
| Loop Mode | algorithm.ts CLI | In SKILL.md (concept) | ✅ Ported |
| Agent Teams/Swarm | CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 | N/A | ❌ Not portable |
| Plan Mode | EnterPlanMode/ExitPlanMode | N/A | ❌ Not portable |
| StatusLine | Claude Code UI | N/A | ❌ Not portable |
| Voice Personality | settings.json personality block | settings.json personality block | ✅ Compatible |

### Algorithm v1.3.0–v1.8.0 (Upstream Sync 2026-02-19)

| Feature | Version | Claude Code | OpenCode | Status |
|---|---|---|---|---|
| Self-Interrogation effort scaling | v1.3.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| Constraint Extraction effort gate | v1.3.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| Steps 6-8 gated to Extended+ | v1.3.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| QG6/QG7 gated to Extended+ | v1.3.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| ISC Scale Tiers (4-500+) | v1.3.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| Constraint Fidelity System v1.3.0 | v1.3.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| Phase Separation Enforcement | v1.6.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| Verify Completion Gate | v1.6.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| Zero-Delay Output Section | v1.6.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| BUILD Capability Execution | v1.8.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| Wisdom Injection (OUTPUT 1.75) | v1.8.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| Wisdom Frame Update in LEARN | v1.8.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| Algorithm Reflection first in LEARN | v1.8.0 | In SKILL.md | In SKILL.md | ✅ Ported |
| Wisdom Frames system | v1.8.0 | ~/.claude/MEMORY/WISDOM/ | ~/.opencode/MEMORY/WISDOM/ | ✅ Ported |
| WisdomFrameUpdater.ts | v1.8.0 | Tools/WisdomFrameUpdater.ts | Tools/WisdomFrameUpdater.ts | ✅ Ported |
| Voice_id template variable | v1.6.0 | `{DAIDENTITY.ALGORITHMVOICEID}` | `{DAIDENTITY.ALGORITHMVOICEID}` | ✅ Ported |
| Security: env var prefix strip | #620 | SecurityValidator.hook.ts | security-validator.ts | ✅ Ported |
| Rating: 5/10 noise filter | commit | ExplicitRatingCapture.hook.ts | rating-capture.ts | ✅ Ported |
| Symlink skill support | commit | SkillIndexGenerator.hook.ts | GenerateSkillIndex.ts | ✅ Ported |
| SessionHarvester PAI_DIR | commit | SessionHarvester.ts | SessionHarvester.ts | ✅ Ported |
| PRD auto-creation hook | commit | AutoWorkCreation.hook.ts | N/A | ⏳ SHOULD-PORT |
| Dynamic version from LATEST | commit | Algorithm/LATEST | N/A | ⏳ SHOULD-PORT |
| SecurityValidator stdin fix #452 | #452 | SecurityValidator.hook.ts | N/A | ❌ Not applicable (in-process plugins) |

---

## v3.0 Hook → Handler Mapping

New hooks added in v3.0 and their handler equivalents. «Event» is the core's
event (`PaiEvent`), which both adapters map from their engine's hooks:

| v3.0 Hook | Handler (`pai-core/handlers/`) | Event | Status |
|---|---|---|---|
| AlgorithmTracker.hook.ts | algorithm-tracker.ts | tool.after | ✅ Created |
| AgentExecutionGuard.hook.ts | agent-execution-guard.ts | tool.before | ✅ Created |
| SkillGuard.hook.ts | skill-guard.ts | tool.before | ✅ Created |
| CheckVersion.hook.ts | check-version.ts | session.start | ✅ Created |
| IntegrityCheck.hook.ts | integrity-check.ts | session.end | ✅ Created |
| FormatReminder (update) | format-reminder.ts | user.message | ✅ Updated |

---

## Version History

| Date | Version | Changes |
|------|---------|---------|
| 2026-02-19 | 2.1 | Upstream sync v1.3.0–v1.8.0: 18 features mapped, MEMORY/WISDOM added, SHOULD-PORT items tracked |
| 2026-02-17 | 2.0 | Added v3.0 Feature Mapping, Hook → Handler Mapping |
| 2026-01-24 | 1.1 | Added Model Configuration section, Agent Type Mapping |
| 2026-01-24 | 1.0 | Initial mapping guide created |

---

## Model Configuration (CRITICAL)

**Claude Code uses short model names; OpenCode requires full provider/model format:**

| Claude Code | OpenCode |
|-------------|----------|
| `haiku` | `anthropic/claude-haiku-4-5` |
| `sonnet` | `anthropic/claude-sonnet-4-5` |
| `opus` | `anthropic/claude-opus-4-5` |

### opencode.json Configuration

The `model-config.ts` system supports TWO configuration formats:

**Format 1: PAI-specific (preferred for full control)**
```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "pai": {
    "model_provider": "anthropic"
  }
}
```

**Format 2: Standard OpenCode (auto-detects provider)**
```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5"
}
```

### Provider Presets

When a provider is detected, these model mappings are used:

| Purpose | Anthropic | OpenAI | ZEN (Free) |
|---------|-----------|--------|------------|
| **default** | claude-sonnet-4-5 | gpt-4o | grok-code |
| **agents.intern** | claude-haiku-4-5 | gpt-4o-mini | gpt-5-nano |
| **agents.architect** | claude-sonnet-4-5 | gpt-4o | big-pickle |
| **agents.engineer** | claude-sonnet-4-5 | gpt-4o | grok-code |
| **agents.explorer** | claude-sonnet-4-5 | gpt-4o | grok-code |
| **agents.reviewer** | claude-opus-4-5 | gpt-4o | big-pickle |

### When Porting Workflow Docs

**DO NOT use short model names in OpenCode documentation:**
```markdown
# WRONG (Claude Code style)
model: "haiku"

# RIGHT (OpenCode style)
model: "anthropic/claude-haiku-4-5"

# BEST (use model-config.ts)
Use getModel("agents.intern") from pai-core/lib/model-config.ts
```

---

## References

- PAI v3.0 Source: `github.com/danielmiessler/Personal_AI_Infrastructure`
- PAI-OpenCode: `github.com/Steffen025/pai-opencode`
- OpenCode v2 Plugin API: `@opencode/plugin` (pinned in `.opencode/package.json`)
- Upstream Sync Spec: `docs/specs/UPSTREAM-SYNC-v1.8.0-SPEC.md`

---

*This document should be updated whenever PAI releases a new version.*
