# AGENTS.md — PAI-OpenCode Repository

| Runtime | Linter | Lang |
|---------|--------|------|
| Bun (never npm/yarn/pnpm) | Biome (never ESLint/Prettier) | TypeScript ESM |

```bash
bun install                  # Install dependencies
bun test                     # Run tests
bun run lint                 # Lint — fails on warnings
```

`biome` is **not** on PATH and not in `node_modules`; always go through
`bun run lint`. A bare `biome check .` exits 0 with no output, so it looks
green when nothing ran. The formatter is off by design — Biome is a linter
here — and every remaining fix Biome offers is classed unsafe, so
`--write` is a no-op. Fix by hand, or suppress with a written reason.

**Types are gated too, but by `bun test`, not by the linter.** There is no
`tsconfig.json`; `tests/typecheck.test.ts` runs `tsc --noEmit` with the flags
inline over `pai-core`, `pai-adapters`, `claude-plugin/`, `Tools/` and
`PAI-Install/`, and
requires zero errors. Biome does not look across files, so a name that is
missing in the *consumer* is invisible to it — that gap cost M-20, M-21 and
M-31. Run one file ad hoc with the same flags the test uses.

**`bun test` is isolated by `tests/preload.ts`** (loaded via `bunfig.toml`):
`PAI_HOME` points at a temp dir for the whole suite, `inference()` is stubbed
so no test makes a model call, and the run fails if anything under the real
`MEMORY/` changed. A red "endret … i det EKTE MEMORY-treet" means a test wrote
around `PAI_HOME` — clean up the listed files and fix the test.

**After a change that turned up a silent failure** — a handler that ran and
did nothing, a guard that read the wrong field, a check that always fired —
it is worth asking whether a guard would have caught it, and at which layer:
development (`bun test`, smoke tests), self-test at startup, or an on-demand
doctor. Propose it alongside the fix rather than building it in the same
change.

**Commits:** `feat(scope):`, `fix(scope):`, `docs:`, `chore:` — `main` is the trunk: autosync commits directly; structured work via short-lived feature branches → PR to `main`.

**Docs:** Runbooks describe current state only. Keep one `oppdatert:` date in frontmatter; no per-file change log — `git log` is the ledger. Cross-cutting decisions live in the commit message.

**Sibling repos:** `infra-ansible`, `monitoring-stack` and `semaphore` (under `~/repos/`) each carry their own `AGENTS.md` with the same docs rule — read the repo's `AGENTS.md` before editing it.

**PAI System:** Loaded via skill system (`PAI/SKILL.md`, tier: always). Not in this file.
