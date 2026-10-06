---
title: Where things are
updated: 2026-10-07
---

# Where things are

Everything PAI is lives in the folder you cloned: one git repository. Two links
make the engines find it: `~/.opencode` points to its `.opencode/` folder, and
`~/.config/opencode` to its `config/opencode/`.

## Yours: the files you change

| What | Where | Goes into every session? |
|---|---|---|
| your assistant's name and personality | `.opencode/PAI/USER/DAIDENTITY.md` | yes |
| about you | `.opencode/PAI/USER/ABOUTME.md` (optional) | yes |
| your machines and services | `.opencode/PAI/USER/INFRASTRUCTURE.md` | yes |
| your goals | `.opencode/PAI/USER/TELOS/TELOS.md` (optional, [TELOS](telos.md)) | yes |
| your own rules for the assistant | `.opencode/PAI/USER/AISTEERINGRULES.md` (optional) | yes |
| names, time zone | `.opencode/settings.json` | no |
| which model each agent uses (OpenCode) | `opencode.json`, set by a profile in `.opencode/profiles/` | no |
| tool keys | `~/.opencode/.env`, not in git ([API keys](api-keys.md)) | no |

"Goes into every session" means the file is sent to the model provider at the
start of each session, so the assistant knows it. Keep those files short, and
never put a password or key in them.

## PAI itself: the files an update changes

| What | Where |
|---|---|
| the core instructions and the Algorithm | `.opencode/PAI/` (except `USER/`) |
| skills: what PAI knows how to do | `.opencode/skills/` |
| agents: the specialists PAI can hand work to | `.opencode/agents/` |
| the hooks that guard and remember | `.opencode/pai-core/`, `.opencode/pai-adapters/` |
| the `pai` command | `.opencode/PAI/Tools/pai.ts` |
| the pinned engine versions | `.opencode/package.json` ([Engine updates](engine-updates.md)) |
| Claude Code's copy of the skills and agents | `claude-plugin/`, built from the above by `pai claude sync` |
| these guides, the setup runbook | `guide/`, `SETUP.md` |

You can change these too, they are yours to read and edit. But an update from
where you cloned (`git pull`) changes them as well, and two changes to the same
lines meet as a git conflict. For anything you want to keep, prefer a skill of
your own, or the files under `USER/`.

## What PAI writes while it works

| What | Where |
|---|---|
| one folder per piece of work, with its plan and checklist (`PRD.md`) | `.opencode/MEMORY/WORK/` |
| what was learned: ratings, failures, reflections | `.opencode/MEMORY/LEARNING/` |
| results from research agents | `.opencode/MEMORY/RESEARCH/` |
| the security log: what the guard allowed, blocked or asked about | `.opencode/MEMORY/STATE/` (not in git) |
| short-lived state for running sessions | `.opencode/MEMORY/STATE/` (not in git) |
| plans made in plan mode | `.opencode/Plans/` |
| the hooks' debug log | `/tmp/pai-opencode2-debug.log` (OpenCode), `/tmp/pai-claude-debug.log` (Claude Code) |

The engines keep their own data outside the repository: OpenCode in
`~/.local/share/opencode/` (sessions, logins), Claude Code in `~/.claude/`.

**`MEMORY/` is in git**, except `STATE/`. That lets it follow you to another
machine through your own git server. It also means your sessions' notes become
commits when you commit. **Push them only to a private repository**, never to a
public one. [Gitea for PAI](gitea.md) sets up exactly that, with `pai-pull` and
`pai-push`.

## Asking instead of looking

Your assistant knows this layout. "Where is my assistant's personality
described?" or "what did you write during the last task?" are fair questions.
