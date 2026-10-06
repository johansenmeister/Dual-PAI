---
title: Model updates
updated: 2026-10-07
---

# Model updates

In OpenCode, every PAI agent runs on a model named by its ID in a profile
(`.opencode/profiles/*.yaml`), such as
`fireworks-ai/accounts/fireworks/routers/kimi-latest`. Providers retire models and
release new ones. When a model a profile uses is retired, that agent's calls
fail, and the first sign may be an agent that never answers.

Claude Code is not affected: it chooses its Claude models itself.

## Checking

Ask your assistant to "update models". That runs the ModelUpdate skill. Run it
when you want to, never on a timer: a good time is when a provider announces new
models, or when an agent starts failing.

1. **It looks.** `bun run .opencode/tools/model-sync.ts check` compares every
   model ID PAI uses with OpenCode's model registry, for the providers you have a
   login or key for. Each ID is `ok`, `retired`, `unverifiable` (the provider has
   no key here, which is not the same as retired) or `external` (local models).
   It also lists models you could use but do not.
2. **It proposes.** For a retired ID it picks the closest current model in the
   same tier (fast for fast, coding for coding), and shows the change as a dry
   run first. New models are weighed against each agent's role, not added
   because they are new.
3. **You decide.** The change goes on a branch and touches only the files the
   skill governs (the profiles and the fallback model map); you merge it. If the
   profile you use changed, it is applied again with `switch-provider.ts`.

You can run the check yourself:

```bash
bun run .opencode/tools/model-sync.ts check           # the report
bun run .opencode/tools/model-sync.ts list fireworks  # what one provider offers
```

Exit code 3 means there is no registry to compare with: start `pai` once, so
OpenCode fetches its model catalog, or connect a provider.

## Routers and pinned IDs

The Fireworks profile mostly uses routers (`routers/*-latest`): the provider's
own alias, which follows a model family from version to version, so a renamed
model does not break the profile. The price is that the model behind the alias
can change without notice. A pinned ID (`models/…`) is used where one exact model
is being tried out. ModelUpdate is needed with routers too: a router survives a
rename, not a whole family disappearing.
