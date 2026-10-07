---
title: API keys
updated: 2026-10-07
---

# API keys

PAI uses two kinds of keys, and they live in different places.

| Kind | What it is for | Where it lives | How you add it |
|---|---|---|---|
| **Model keys** | the AI models the engine talks to | OpenCode: its own database (`~/.local/share/opencode/opencode.db`). Claude Code: its own login | OpenCode: `/connect` in the window, or `opencode auth login`. Claude Code: `/login` |
| **Tool keys** | skills and tools that use a service: the homelab, research agents, email reports, security tools | `~/.opencode/.env` | you edit the file |

Neither is in the git repository: `.env` is ignored by git, and the engines keep
their logins outside it.

## Tool keys in `~/.opencode/.env`

`.opencode/.env.example` lists every key a skill or tool reads, in groups, with a
comment on where to get it. Copy the lines you need into `~/.opencode/.env` and
fill in the values. A key you leave out turns off only the tool that needs it.

```
nano ~/.opencode/.env        # or any editor
chmod 600 ~/.opencode/.env   # only you can read it
pai keys                     # which keys are set, never their values
```

`pai doctor` warns if the file can be read by others, and lists keys that are not
in `.env.example` (often a typo in the name).

**Three rules**

- **Never paste a key into the chat.** Everything you type goes to the model
  provider. Put it in the file yourself.
- **Your assistant does not read `.env`.** Tools read the keys they need; the
  model sees only whether a key is set.
- **Start with read rights.** For a homelab service, create a token that can only
  read. Give it write rights when you want PAI to change things there.

## Model keys

**OpenCode.** In the OpenCode window, type `/connect`, choose the provider and
paste the key. From a terminal, the same with the engine's own command:

```
.opencode/node_modules/.bin/opencode auth list --standalone     # which providers are connected
.opencode/node_modules/.bin/opencode auth login --standalone    # add one
.opencode/node_modules/.bin/opencode auth logout --standalone   # remove one
```

(run from the PAI folder). Then choose models with a profile:
`bun .opencode/tools/switch-provider.ts <profile>`; see `SETUP.md`, "The engine
and the models".

**Claude Code.** Run `claude`, type `/login`, and choose your subscription or an
API key. A Claude subscription works only in Claude Code, not in OpenCode.

## When a key shows up in a session

PAI masks secrets in what tools print before the assistant sees them: the keys in
`~/.opencode/.env`, and anything shaped like a key, a password in a URL or an
`Authorization` header. The assistant sees `[MASKED:GITEA_TOKEN]` instead, and
PAI's own logs and memory files get the same treatment. Each masking is a line
in the security log, with the key's name and never its value.

So a key that a command prints is no longer a leak by itself. It still is when
you paste it into a prompt (that goes to the model before anything can mask
it), or when it is not in `.env` and has no recognisable shape. Rotate it then.

## Rotating a key

Replace a key now and then, and at once if it may have leaked: shown on screen
in a recording, pasted into a chat, committed, or on a machine you no longer
trust.

1. **Create the new key** at the provider, next to the old one.
2. **Put it in place:** edit the line in `~/.opencode/.env`, or for a model key,
   run `/connect` again (or `opencode auth login`) with the new key.
3. **Check:** `pai keys` shows it as set; run something that uses it (ask your
   assistant to do a small, read-only task with that service).
4. **Delete the old key at the provider.** Until you do, it still works for
   whoever has it.

**If it leaked, swap steps 1 and 4:** delete or disable the old key at the
provider first, then make the new one. A few minutes without the service is
better than a leaked key that still works.

If a key was committed to git, deleting the file is not enough: it stays in the
history. Rotate the key; that is what makes the old one harmless.

## Where else keys are not

- Not in `opencode.json`, `settings.json` or any file under `.opencode/PAI/USER/`:
  those go into the repository, and some go into every session's context.
- Not in shell profiles (`~/.bashrc` and the like) for PAI's sake. Most tools
  read `~/.opencode/.env` themselves. The few marked "(env)" in `.env.example`
  read only the environment; their workflows load the file for that one command
  (`set -a; . ~/.opencode/.env; set +a`), so the keys don't sit in every shell.
