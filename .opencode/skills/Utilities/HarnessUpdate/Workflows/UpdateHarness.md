# UpdateHarness Workflow

Find out whether either engine has a newer version than the pinned one, and
what in it touches the assumption register.

## Notification

Running the **UpdateHarness** workflow in the **HarnessUpdate** skill to check the engines...

## Steps

### 1. Run the check

```bash
cd "$(git -C ~/.opencode rev-parse --show-toplevel)"   # the repo, on any machine
bun .opencode/PAI/Tools/HarnessSync.ts check --json
```

- `0`: both are on the latest version. Tell the user and **STOP**.
- `3`: a source did not answer (npm, GitHub or the changelog). Say which, and
  draw no conclusion for that engine. GitHub without a token allows 60 calls
  an hour.
- `1` or `2`: continue.

### 2. Read every flagged hit

For each line in `treff`: read all of it, and decide whether it actually changes
what the register row says. The patterns are broad on purpose, so many hits are
harmless (a TUI change that mentions a hook name). Sort them into three:

| Class | Means | Example |
|---|---|---|
| **May break** | changes the behaviour the row relies on | "hook output over the limit is now …", a new name for `Agent` |
| **Strengthens** | fixes something we have worked around | 2.1.281's warning about hooks in shell form (M-42) |
| **Harmless** | matches the pattern, not the contract | a TUI fix for `SessionStart` |

Everything in the first class is the reason for the smoke test. When in doubt,
it is the first class.

For v2 the hits are commit subjects and paths, not release notes. A hit on a
path under `plugin/` only says that the code around the plugin API changed:
read the diff on GitHub (`https://github.com/anomalyco/opencode/compare/v<pinned>...v<latest>`)
before you classify it.

### 3. Report

Per engine: pinned, latest (and `stable` for Claude Code, which the apt source
follows), the table above with one row per hit that is not harmless, and the
number of harmless ones.

### 4. Propose the bump, do not do it

The bump is the user's choice. The steps (the plan, phases 2 and 4):

**Claude Code:**
1. a branch, `pai.claudeCode` in `.opencode/package.json` set to the new version
2. `claude install <new>`
3. `bun Tools/ClaudeSmoke.ts`: green writes the receipt
4. a PR with the pinning and the receipt

**OpenCode v2:**
1. a branch, `@opencode/cli` and `@opencode/plugin` in `.opencode/package.json`
2. `cd .opencode && bun install`
3. `bun Tools/V2Smoke.ts`: green writes the receipt
4. The free models the setup starts with (#200), where `SETUP.md` exists:
   `bun PAI-Install/cli/zen-start.ts --dry-run` should answer with a model from
   `NULLLAGRING` (exit 0; exit 2 means none of them answered). Read "Privacy" on
   `https://opencode.ai/docs/zen/` and compare it with `NULLLAGRING` in
   `PAI-Install/cli/zen-start.ts`, `.opencode/profiles/zen.yaml` and the table in
   `SETUP.md` step 1. If the terms or the list have changed: fix all three in
   the same PR.
5. a PR with the pinning and the receipt

After the merge, every other machine with this repo pulls (`pai-pull` where
the repo syncs through a git server), and the self-test there names the
install command. If the repo has a delivery script for other copies
(`docs/jobb-harness/Leveranse.sh`), it carries the bump there.

**If a row is broken** (the smoke test is red, or a hit in the first class turns
out to be real): the register (`AssumptionRegister.md`) and the rule in `HarnessSync.ts` are
updated in the same PR as the fix.
