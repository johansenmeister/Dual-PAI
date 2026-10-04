---
title: Engine updates
updated: 2026-10-04
---

# Engine updates

PAI runs inside an engine: OpenCode, or Claude Code. Both are **pinned**: PAI
uses one exact version of each, and neither updates itself.

```
.opencode/package.json
  "@opencode/cli": "<version>"          OpenCode
  "pai": { "claudeCode": "<version>" }  Claude Code
```

`pai version` shows the pinned and the installed version of each. `pai doctor`
and the check at every start say so if they differ.

## Why pinned

PAI hooks into the engines: their events, their tool names, the shape of the
data they send, their settings. A new engine version can rename or change one of
these without any error. Nothing crashes; PAI just stops guarding or remembering
something, silently. That has happened: one Claude Code version cut the context
PAI gives every session to its first 2 KB, and nothing said so.

So a new version comes in only after it has been checked.

## How a new version comes in

**Usually, with an update of PAI.** When we have checked a new engine version,
the new pin comes with `git pull` from where you cloned PAI. After the pull:

```
cd .opencode && bun install         # OpenCode: installs the pinned version
~/.local/bin/claude install <version>   # Claude Code: the version in pai version
```

**If you want it before that,** do the check yourself. Ask your assistant to
"check the engines for updates". That runs the HarnessUpdate skill:

1. **It looks.** `bun .opencode/PAI/Tools/HarnessSync.ts check` asks npm for the
   newest versions, then reads what changed since the pinned one: Claude Code's
   release notes (`CHANGELOG.md` in `anthropics/claude-code`), and for OpenCode,
   which has no release notes for 2.0, the commits and changed files between the
   two versions on GitHub.
2. **It flags.** Every change is matched against a list of what PAI depends on
   (hook names, tool names, the plugin interface). A match is not a verdict: the
   assistant reads each one and sorts it into "may break", "fixes something" or
   "harmless".
3. **It proposes, and stops.** It never upgrades. The decision is yours.

**The smoke tests decide.** If you go ahead, the upgrade is a branch:

| Engine | Steps |
|---|---|
| Claude Code | set `pai.claudeCode` in `.opencode/package.json` to the new version; `claude install <new>`; `bun Tools/ClaudeSmoke.ts` |
| OpenCode | set `@opencode/cli` and `@opencode/plugin` in `.opencode/package.json`; `cd .opencode && bun install`; `bun Tools/V2Smoke.ts` |

A smoke test runs the real engine with PAI loaded, and checks that every hook
fires, that the security guard blocks what it should, that agents start, and
that a session ends cleanly. Green writes a receipt
(`.opencode/claude-smoke-kvittering.json`, `.opencode/v2smoke-kvittering.json`),
which is committed with the new pin. Red means: stay on the pinned version, and
find out why before going on.

**What the smoke tests cost.** They make real model calls. `ClaudeSmoke` uses your
Claude login (your subscription's quota). `V2Smoke` uses a Fireworks model, so it
needs a Fireworks key (`--modell` picks another Fireworks model).
Run them once per upgrade, not in a loop.

**Never** `opencode upgrade`, `claude update` or the engines' own update prompts.
They move the engine past the pin without the check. If it happened anyway,
`pai version` shows it; install the pinned version again with the commands above.

## Known gaps

- The check reads OpenCode's commits, not its issue tracker, so a known bug in a
  new version is not flagged.
- `V2Smoke` cannot yet run on a free model only.
- The HarnessUpdate skill's texts are still written for the setup PAI was built
  on, and in Norwegian; the steps above are the same.
