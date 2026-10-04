---
# GENERERT av Tools/BuildClaudePlugin.ts — ikke rediger.
# Kilde: .opencode/skills/Utilities/OpenCodeSystem/SKILL.md
# Endringer hører hjemme i kilden; kjør deretter generatoren på nytt.
name: utilities-open-code-system
description: PAI-OpenCode system self-awareness. USE WHEN asking about tools, config, model routing, plugin handlers, MCP servers, troubleshooting, or operating environment.
---

## Customization

**Before executing, check for user customizations at:**
`~/.opencode/PAI/USER/SKILLCUSTOMIZATIONS/OpenCodeSystem/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

# OpenCodeSystem — System Self-Awareness

System self-awareness for PAI-OpenCode. Enables the Algorithm to answer questions about its own operating environment without asking the user or hallucinating.

## Visibility

This skill runs in the foreground. All lookups and diagnostic output should be visible to maintain transparency.

---

## MANDATORY — Quick Reference

Stier under `~/.opencode/` er relative til den. `runbooks/` og `docs/` ligger i
repoet, én katalog over (`~/.opencode` er en symlink til `<repo>/.opencode`).

| Question | Answer Location |
|----------|----------------|
| Hooks, handlere, adaptere | `~/.opencode/PAI/THEPLUGINSYSTEM.md` |
| Hooksystemet i detalj + defektregisteret | `runbooks/hooksystemet.md` |
| Daglig bruk, oppstart, feilsøking | `runbooks/daglig.md` |
| Hvilken motor til hva | `runbooks/harness-guide.md` |
| Installasjon og maskinene | `runbooks/install.md` |
| Model routing, agents, permissions | `~/.opencode/opencode.json` |
| Hvorfor v2-adapteren er som den er | `docs/opencode-v2/plan.md` |

---

## MANDATORY — Key Facts (Inline — No File Read Needed)

### Runtime Identity
- **Platform:** OpenCode v2 (`@opencode/cli`, pinnet i `.opencode/package.json`),
  startet med `pai`. PAI kjører også under Claude Code (`pai --claude`); da
  gjelder `claude-plugin/` i repoet, men MEMORY er det samme `~/.opencode/MEMORY/`
- **Correct path:** `~/.opencode/`
- **Project config:** `opencode.json` (root) + `settings.json` (~/.opencode/)
- **Adapter:** `.opencode/pai-adapters/opencode-v2/`, lastet av launcheren (ikke
  fra `opencode.json`). Kjernen er `.opencode/pai-core/`
- **Logg:** `/tmp/pai-opencode2-debug.log`

### Custom Tools Always Available

| Tool | Purpose |
|------|---------|
| `session_registry` | List subagent sessions for CONTEXT RECOVERY |
| `session_results` | Get a subagent's actual captured answer by session ID |
| `code_review` | ~~roborev~~ — the CLI is NOT installed; this tool is dead code today |

### Model Tiers
- `quick` → fast, cheap (exploration, simple tasks)
- `standard` → balanced (default for most agents)
- `advanced` → complex reasoning (Algorithm agent)
- Actual model names resolved from `opencode.json` — never hardcode

### The 2-Second Rule
If Grep, Glob, or Read can answer in <2 seconds → use them directly. Never spawn an agent for what a direct tool call can do instantly.

### Critical Path Rules
```text
bash workdir parameter → ALWAYS (never cd &&)
imports             → ALWAYS include .ts extension
package manager     → ALWAYS bun (never npm/yarn/pnpm)
memory paths        → ALWAYS ~/.opencode/ (never ~/.claude/)
```

---

## MANDATORY — When Something Doesn't Work

1. **Lastet adapteren?** `grep "v2-adapter lastet" /tmp/pai-opencode2-debug.log`.
   Startet økten uten `pai` (bar `opencode`), er PAI ikke lastet i det hele tatt.
2. **Kom konteksten inn?** `grep "Context injected" /tmp/pai-opencode2-debug.log`
3. **Fyrer hookene?** `bun Tools/V2Smoke.ts` i repoet (modellkall)
4. **`pai` dør med `ENOEXEC`?** v2-binæren er en plassholder:
   `cd ~/.opencode && rm -rf node_modules/@opencode/cli && bun install`
5. Resten: `runbooks/daglig.md`, feilsøkingsdelen

---

## OPTIONAL — Architecture in 30 Seconds

```text
opencode.json          → model routing, permissions, agent definitions
pai-adapters/opencode-v2/ → v2-adapteren: hooks → dispatch(PaiEvent)
pai-core/              → kjernen: dispatch/, handlers/ (26), lib/
AGENTS.md              → Algorithm's runtime operating instructions
skills/skill-index.json → skill discovery registry for CAPABILITY AUDIT
~/.opencode/MEMORY/    → PRDs, session data, reflections
```

Full details: `~/.opencode/PAI/THEPLUGINSYSTEM.md`

---

## OPTIONAL — USE WHEN Triggers

- "What tools do I have?"
- "What custom tools are available?"
- "How is model routing configured?"
- "What MCP servers are connected?"
- "Why isn't the plugin firing?" / "Hvorfor lastet ikke PAI?"
- "What's the difference between opencode.json and settings.json?"
- "How do I troubleshoot X not working?"
- "What agents can I spawn?"
- "Where is the memory stored?"
- "What hooks does the plugin register?"
- Any question about the operating environment, directory structure, or system configuration

---

## Tools

| Tool | Path | Purpose |
|------|------|---------|
| `V2Smoke.ts` | `Tools/V2Smoke.ts` | Røyktest: beviser at hver v2-hook fyrer, mot den ekte binæren. Kjøres ved hver versjonsbump. |
| `migration-v2-to-v3.ts` | `Tools/migration-v2-to-v3.ts` | Migrate existing v2.x PAI-OpenCode installations to v3.0 directory structure. Supports `--dry-run`, `--force`, `--backup-dir`. Run with `bun Tools/migration-v2-to-v3.ts`. |

## Workflows

_No dedicated workflow files. Operational procedures for the tools above are documented inline in each tool's source header._

---

## Related Skills

- **PAI** — Algorithm core, ISC creation, verification
- **System** — System maintenance, integrity check, documentation
