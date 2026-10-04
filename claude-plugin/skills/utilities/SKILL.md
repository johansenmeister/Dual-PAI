---
# GENERERT av Tools/BuildClaudePlugin.ts — ikke rediger.
# Kilde: .opencode/skills/Utilities/SKILL.md
# Endringer hører hjemme i kilden; kjør deretter generatoren på nytt.
name: utilities
description: Utility and helper skills. USE WHEN browser automation, Cloudflare, create CLI, build CLI, create skill, process documents, PDF, Word, Excel, evaluations, evals, hardening, property tests, fabric patterns, PAI upgrade, parser, prompting, templates.
---

# Utilities - Utility and Helper Skills

**Category for utility, helper, and infrastructure skills.**

## Skills in This Category

| Skill | Purpose | Trigger |
|-------|---------|---------|
| **Browser** | Browser automation and screenshots | "browser", "screenshots", "web automation" |
| **Cloudflare** | Cloudflare Workers, Pages, R2, DNS | "Cloudflare", "Workers", "Pages", "R2" |
| **CreateCLI** | Build command-line tools | "create CLI", "build CLI", "command line" |
| **CreateSkill** | Create new PAI skills | "create skill", "new skill", "build skill" |
| **Delegation** | Task delegation and orchestration | "delegate", "orchestrate", "assign" |
| **Documents** | Process documents (PDF, Word, Excel) | "process document", "PDF", "Word", "Excel" |
| **Evals** | Evaluation and benchmarking system | "eval", "evaluate", "benchmark", "test" |
| **Hardening** | Property-based testing of existing tests (fast-check) | "harden", "property test", "PBT" |
| **Fabric** | 240+ Fabric patterns for content analysis | "fabric", "extract wisdom", "summarize" |
| **PAIUpgrade** | Monitor and upgrade PAI system | "upgrade", "PAI upgrade", "check updates" |
| **Parser** | Parse and process various data formats | "parse", "extract", "process data" |
| **Prompting** | Prompt engineering and optimization | "prompting", "prompt engineering", "templates" |

## When to Use

- Processing files and documents
- Browser automation tasks
- Cloud infrastructure (Cloudflare)
- Building tools and skills
- Running evaluations and tests
- Content analysis with Fabric patterns
- System maintenance and upgrades

## Category Philosophy

Utility skills are the infrastructure layer. They handle the "plumbing" that enables higher-level capabilities.

## Customization

**Before executing, check for user customizations at:**
`~/.opencode/PAI/USER/SKILLCUSTOMIZATIONS/Utilities/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there.
