# PAI — a personal AI assistant in your terminal

PAI is a set of skills, agents, rules and memory that turn an AI model into a
personal assistant. It runs inside an agent program in the terminal, and works
with two of them: **OpenCode** (any model provider, including free models) and
**Claude Code** (Anthropic's, with a Claude subscription). Both share the same
skills, memory and settings, so you can switch between them.

Everything PAI is lives in one git repository: this one, once you have cloned
it. Git keeps the history, so every change can be seen and undone.

## Install

Linux and WSL2 are supported. macOS works (tested on an Intel Mac with macOS 15
and Apple's Command Line Tools); Apple Silicon is not tested yet.

You need no account and no API key to start. In a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/johansenmeister/dual-pai/main/install.sh | bash
```

or, on a system with `wget` and no `curl`:

```bash
wget -qO- https://raw.githubusercontent.com/johansenmeister/dual-pai/main/install.sh | bash
```

To clone from somewhere else, such as your own fork, add `-s -- --repo <git url>`
after `bash`. If you have cloned already, run `./install.sh` in the clone.

`install.sh` does the parts that have one right answer: it checks the system,
installs git, Bun and a few tools, clones PAI to `~/repos/pai` (`--dir` picks
another folder), installs the two engines at the versions PAI is tested with,
and picks a free model. Then it opens OpenCode with the setup conversation.

## The setup conversation

`SETUP.md` is a runbook the assistant follows with you, one step at a time:
your language, your assistant's name and personality, which engine and models
you want, your machines, the services it may use and their keys, where faults
and ideas go, and access from another computer. Each choice comes with a short
text on what it is, what it needs, what it costs and whether you can change it
later. You can skip steps and come back.

The free model is only for the setup; you choose your own in step 5. Your keys
go in `~/.opencode/.env`, which you fill in yourself: the assistant never reads
it.

## Every day

| Command | What it does |
|---|---|
| `pai` | starts PAI in OpenCode |
| `pai --claude` | starts PAI in Claude Code |
| `pai keys` | shows which keys are set, never their values |
| `pai doctor` | checks the installation and says what to fix; changes nothing |

`guide/` has short guides for you: where things are, API keys, faults and
improvements, your own Gitea, engine updates, remote access and your goals
(TELOS). Start with [guide/README.md](guide/README.md).

## For developers

Parts of the code comments and the skills are in Norwegian: they come from the
repository PAI is copied from.

| | |
|---|---|
| **`.opencode/pai-core/`** | The engine-independent core. Never imports an engine SDK |
| **`.opencode/pai-adapters/opencode-v2/`** | The OpenCode side, with OpenCode pinned exactly in `.opencode/package.json` |
| **`claude-plugin/`** | The Claude Code side: hooks, MCP server, a generated mirror of the skills and agents |
| **`.opencode/skills/`** | About 50 skills, including `Infrastructure/` |
| **`.opencode/skills/Utilities/HarnessUpdate/AssumptionRegister.md`** | What PAI assumes about each engine, and what the smoke tests guard |

```bash
bun install
(cd .opencode && bun install)   # the OpenCode binary and types, about 780 MB
bun test                        # green out of the box
bun run lint
```

Both installs are needed: the one in the root does not cover `.opencode/`, and
without it the type check in `bun test` has neither the binary nor the types.

**The self-test.** Both engines are pinned exactly in `.opencode/package.json`
(`@opencode/cli` and `pai.claudeCode`), and each has a smoke test that writes a
receipt: `bun Tools/V2Smoke.ts` and `bun Tools/ClaudeSmoke.ts`. Before an
engine starts, `pai` and `pai --claude` check that the installed version is the
pinned one and that the smoke test has passed against it and against the
adapter code as it is now. If something is wrong, you get one line with the
command that fixes it; otherwise they say nothing. `pai doctor` runs the same
checks and the slower ones: the model registry, the MCP servers, handlers that
run without effect, and the database. Neither engine reports a hook that stops
firing, so a bump is not done until the smoke test is green. The skill
`HarnessUpdate` reads the engines' release notes against its assumption register
and says what must be measured again; it never upgrades anything ([guide/engine-updates.md](guide/engine-updates.md)).

**Three things worth knowing before you change anything:**

- **The core never imports an engine SDK.** The two-engine design rests on
  `pai-core/` taking primitives and returning data. A grep for `harness ===`
  should hit only `runtime.ts` and the adapters, and a test guards it.
- **`claude-plugin/skills/` and `claude-plugin/agents/` are generated.** Edit
  the source under `.opencode/skills/` and run `pai claude sync`. The mirror is
  tracked in git and built from what git tracks, not from what is on disk, and a
  test fails if it drifts from the source.
- **The hook binary is a build artefact.** `bin/pai-hook` falls back to the
  source when it is missing, so everything works without it, only slower. `pai
  claude sync` builds it.

## Where this comes from

PAI is Daniel Miessler's
[Personal AI Infrastructure](https://github.com/danielmiessler/Personal_AI_Infrastructure).
This repository started as a fork of Steffen's port to OpenCode,
[pai-opencode](https://github.com/Steffen025/pai-opencode), and has since been
rebuilt around two engines. [OpenCode](https://github.com/anomalyco/opencode)
is by Anomaly.

The repository is a copy of a private one whose history is mostly its owner's
memory. It starts from a single commit on purpose; later commits are updates
from the original, added on top.

MIT License, see [LICENSE](LICENSE).
