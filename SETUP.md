# Setting up PAI

This is the setup runbook for PAI, a personal AI assistant that runs in your
terminal. `install.sh` has done the mechanical part. The rest of the setup is a
conversation with the assistant that runs this file.

---

## For the agent: how to run this file

You are guiding a new user through their setup. They may never have used an AI
agent in a terminal before. Follow these rules for the whole runbook:

1. **One step at a time, in order.** Say which step you are on (for example
   "Step 3 of 11: your assistant"). Finish a step before starting the next. The
   user can skip any step except step 1, and can stop and come back later.
2. **Ask with your question tool** whenever a step offers choices (OpenCode:
   `question`; Claude Code: `AskUserQuestion`). Ask one question at a time, and
   allow a free-text answer.
3. **Use the texts in this file for facts about a choice.** Each choice has a
   fixed description: what it is, what you get, what it needs, what it costs,
   whether it can be changed later, and what we recommend. Give the first line
   first. Give the rest when the user asks or seems unsure. Answer follow-up
   questions, but do not invent prices, limits or features that are not written
   here. If you don't know, say so.
4. **Never read `~/.opencode/.env`.** Do not open, print, grep, `source` or copy
   it, not even in part. The user fills it in themselves. `pai keys` shows which
   keys are set without showing any value; that is the only check you run.
5. **Run commands only from the "Run" lines in this file**, and say what each
   command does before you run it. They run from the repo root, so start each
   one with `cd "$(dirname "$(realpath ~/.opencode)")" && `. In your shell, the
   user's `pai` command is `bun .opencode/PAI/Tools/pai.ts`: `pai` is a function
   in their shell profile, which your shell does not load. If a command fails,
   show the error, explain it in plain words, and offer to retry or skip.
6. **Show before you write.** Before you change a file, show the user what you
   will write. Afterwards, show the result.
7. **Keep it short and conversational.** Skip the PAI Algorithm format during
   setup: no headers, no phases, no PRD. Plain sentences, a little at a time.
8. Things the user must do themselves (log in, paste a key, press a key in the
   TUI) are marked **You do this**. Tell them exactly what to type, then wait
   until they say it is done.

---

## Step 1: Language and welcome

Ask which language the user wants to talk in. Continue in that language for the
rest of the setup, but keep commands, file names and the choice names in this
file as they are.

Then explain, in four or five short sentences:

- **PAI** is a set of skills, agents, rules and memory that make an AI model
  work as a personal assistant. It runs inside an agent program in the terminal
  (here OpenCode). The program lets the model read files, run commands and
  remember things between sessions, but only with the permissions PAI gives it.
- **This folder is a git repository.** It holds everything PAI is: the skills,
  the assistant's identity, its memory and your settings. Git keeps the history,
  so every change can be seen and undone.
- **This conversation** sets up your copy: the assistant's name and personality,
  which AI models it uses, what it should know about your machines, and which
  services it may use.
- **The model right now** is a free model through OpenCode Zen. It is used only
  for this setup. You choose your own models in step 5. Free models have a limit
  on how much they answer in a while: if the screen says "Rate limit exceeded",
  wait and type "continue"; nothing is lost. The limit is per model: before step
  5, `bun PAI-Install/cli/zen-start.ts` in a terminal switches to the other free
  model that keeps no data, and PAI uses it from its next start.

Then show which model is running and what its provider does with data:

Run: `grep -m1 '"model"' opencode.json`

| Model | What Zen says about your data (opencode.ai/docs/zen, 2026-10-04) |
|-------|------|
| `opencode/longcat-2.5-preview-free` | The provider keeps no data and does not train on it |
| `opencode/space-bunny-free` | The provider keeps no data and does not train on it |
| any other `*-free` | Data may be used to improve the model, or is logged. Avoid personal or confidential details |

If the model is not one of the first two, say so plainly: the user can skip the
personal questions in step 3 and answer them after step 5, with a model of their
own choice.

## Step 2: Check what install.sh did

Run: `bun .opencode/PAI/Tools/pai.ts version`

Run: `ls -la ~/.opencode ~/.config/opencode`

Expected: the version command prints the pinned engine versions, and both paths are links
into this folder. If `pai` is not found, the shell has not reloaded the profile
yet. **You do this:** open a new terminal later; for now the setup continues
here.

## Step 3: Your assistant

The assistant has a neutral default identity called Juno. Here the user makes it
their own. Ask, one at a time:

1. **The assistant's name.** Suggest that they keep Juno or pick any short name.
2. **The user's own name**, as they want to be addressed.
3. **The time zone.** Run `timedatectl show -p Timezone --value 2>/dev/null || cat
   /etc/timezone 2>/dev/null` and suggest the result. It must be an IANA name such
   as `Europe/Oslo` or `America/New_York`.
4. **The personality.** Offer three styles plus their own words:
   - *Calm and precise*: plain language, a little dry humour, no hype (the
     default);
   - *Warm and encouraging*: friendly and patient, explains more;
   - *Brief and technical*: minimal words, straight to the point.

Then write the names and time zone:

Run: `bun PAI-Install/cli/identity.ts --ai-name "<name>" --user-name "<name>" --timezone "<zone>"`

It changes the name everywhere in `.opencode/PAI/USER/DAIDENTITY.md`, sets the
user as its principal, and writes both names to `.opencode/settings.json` and
`opencode.json`. Then edit the
**Personality:** line and the **Tone** section of `DAIDENTITY.md` yourself, in
the user's words. Keep the `**Name:**` line as it is: the tests read it.

Optionally, offer to write `.opencode/PAI/USER/ABOUTME.md`: three to six lines
about the user (role, what they work on, how they like answers). Say first that
this file, like the identity, goes to the model provider at the start of every
session.

Tell the user that the new name takes effect in the next session.

## Step 4: Your copy of the repository

Explain briefly: the user's changes (identity, settings, memory) are commits
in this repository. The `origin` remote points to where it was cloned from, and
pulling from it brings PAI updates.

Run: `git config user.name; git config user.email; git remote -v`

If the name or email is empty, ask for them and run
`git config --global user.name "<name>"` and `git config --global user.email "<email>"`.
Explain that the email is only written into commits on this machine, unless they
push to a server.

## Step 5: The engine and the models

PAI runs in two agent programs, called engines. Both load the same skills,
agents, identity and memory. Ask which one the user wants as the main engine.

**Engine choice: OpenCode**
- *What:* the open-source agent program running right now.
- *You get:* all of PAI, and a free choice of model provider, including several
  at once: PAI can give each agent its own model.
- *Needs:* nothing more than now. For better models: an account and an API key
  with a provider (next question).
- *Costs:* free with Zen's free models; otherwise pay per use at the provider.
- *Change later:* yes, any time. Start it with `pai`.
- *We recommend:* OpenCode if you want to choose and combine providers, or don't
  have a Claude subscription.

**Engine choice: Claude Code**
- *What:* Anthropic's own agent program, running Claude models.
- *You get:* all of PAI, through `pai --claude`, with a Claude subscription or an
  Anthropic API key.
- *Needs:* a Claude Pro or Max subscription, or an Anthropic API key.
- *Costs:* the subscription (see claude.com/pricing), or pay per use with a key.
- *Change later:* yes. Both engines can be installed side by side.
- *We recommend:* Claude Code if you already pay for a Claude subscription. A
  subscription works only in Anthropic's own programs, not in OpenCode.

### Both engines are pinned

Tell the user this before installing anything, in a few sentences:

- **What:** PAI runs on one exact version of each engine, written in
  `.opencode/package.json` (`@opencode/cli`, and `pai.claudeCode` for Claude Code).
  Neither engine updates itself here.
- **Why:** PAI hooks into the engines' events, tool names and settings. A new
  version can rename or change one of them without any error: PAI then stops
  guarding or remembering something, silently. This has happened, for example a
  Claude Code version that cut PAI's context to its first 2 KB.
- **How upgrades happen:** through PAI itself. Asking the assistant "check the
  engines for updates" runs the HarnessUpdate skill. It reads Claude Code's release
  notes and the changes in OpenCode between the pinned and the newest version,
  flags everything that touches what PAI depends on, and proposes the upgrade.
  The smoke tests (`Tools/V2Smoke.ts`, `Tools/ClaudeSmoke.ts`) decide: green
  means the new version is written into `.opencode/package.json`. `pai update`
  shows the steps. Never `opencode upgrade` or `claude update` by hand.
- **More:** `guide/engine-updates.md`.

### If the user chooses Claude Code

Claude Code is pinned to one version in `.opencode/package.json`, like
OpenCode, so updates are deliberate.

Run: `grep claudeCode .opencode/package.json`

Run: `curl -fsSL https://claude.ai/install.sh -o claude-install.sh && bash claude-install.sh; rm -f claude-install.sh`

(Anthropic's installer, saved to a file in the repo first: PAI's security guard blocks
`curl … | bash`, and a folder outside the repo makes OpenCode ask for permission.)

Run: `~/.local/bin/claude install <the pinned version>`

**You do this:** in a second terminal, run `claude`, type `/login`, choose the
subscription or an API key, and finish with `/exit`. On a machine without a browser,
Claude shows a link: open it on another computer and paste the code back. The first
time `pai --claude` starts, Claude Code asks whether you trust the folder: answer yes.

Run: `bun .opencode/PAI/Tools/pai.ts claude sync` (builds the PAI plugin and adds four settings to
`~/.claude/settings.json`; it changes nothing else there)

Run: `bun .opencode/PAI/Tools/pai.ts claude doctor`

Expected: green lines only. Then tell the user that `pai --claude` starts
Claude Code with PAI, and continue the setup there or here, as they prefer.

### The models for OpenCode

Ask this whether or not the user chose Claude Code, since OpenCode stays
installed. Explain first: OpenCode can use many providers at once. A provider is
connected once with `/connect`; a *profile* then sets which model each PAI agent
uses (`.opencode/profiles/`).

**Provider choice: stay on Zen's free models**
- *What:* the free model this setup runs on.
- *You get:* a working assistant at no cost. Free models change, and are slower
  and weaker than paid ones.
- *Needs:* nothing.
- *Costs:* nothing. Check the data terms in step 1's table.
- *Change later:* yes.
- *We recommend:* fine for trying PAI out. For daily use, a paid provider.

**Provider choice: Fireworks** (profile `fireworks`)
- *What:* a provider hosting many open models (DeepSeek, Kimi, GLM, Qwen and others).
- *You get:* strong open models at a low price per token; PAI's profile gives
  each agent a model that suits it.
- *Needs:* an account and an API key at fireworks.ai.
- *Costs:* pay per use.
- *Change later:* yes.
- *We recommend:* a good default for OpenCode.

**Provider choice: Anthropic API** (profile `anthropic`)
- *What:* Claude models with an API key, inside OpenCode.
- *Needs:* an API key from console.anthropic.com. A Claude subscription does not
  work here.
- *Costs:* pay per use.
- *Change later:* yes.

**Provider choice: OpenAI** (profile `openai`) and **xAI** (profile `grok`)
- *What:* GPT models, and Grok models.
- *Needs:* an API key from the provider.
- *Costs:* pay per use.
- *Change later:* yes.

**Provider choice: local models with Ollama** (profile `local`)
- *What:* models running on your own machine.
- *You get:* nothing leaves the machine.
- *Needs:* Ollama installed, and a machine with enough memory (a GPU helps a lot).
  Edit the model names in `.opencode/profiles/local.yaml` to the ones you pulled.
- *Costs:* nothing but hardware and power.
- *Change later:* yes.

**Other providers** (OpenRouter, Google Gemini and more than 70 others) connect
the same way, but have no ready profile. Then the models are set by hand in
`opencode.json`; list the exact names with
`.opencode/node_modules/.bin/opencode models <provider>`. Never guess a model name.

For a provider with a profile:

1. **You do this:** in the OpenCode window, type `/connect`, choose the provider
   and paste the API key. OpenCode stores it in its own database, not in this
   repository.
2. Run: `bun .opencode/tools/switch-provider.ts --list`
3. Run: `bun .opencode/tools/switch-provider.ts <profile>`
4. Run: `bun .opencode/tools/switch-provider.ts --current`

The new models take effect when PAI is restarted. The setup can continue in this
session first.

## Step 6: What PAI is for, and your lab

Ask what the user wants PAI for: **operations** (running and looking after
machines and services), **development** (writing and reviewing code), or
**both**. Then ask what their lab consists of, whatever the answer: a
developer has machines too. For example: this computer only; other Linux
machines over SSH; a Proxmox host; a Docker host with Portainer; a NAS; a
firewall; DNS.

For each machine or service, ask for a name, the address, how it is reached
(SSH, API, web), and the user name. Never ask for passwords or keys here.

Write the answers into `.opencode/PAI/USER/INFRASTRUCTURE.md`. Its template has
a short purpose section and two tables. Replace the "No lab is described yet"
paragraph. This file goes into the context of every session: keep it short and
put no secrets in it.

For each SSH machine, offer a check:

Run: `ssh -o BatchMode=yes -o ConnectTimeout=5 <user>@<address> true && echo reachable`

If it fails with "Permission denied", the user has no SSH key there yet. Offer to
explain `ssh-keygen` and `ssh-copy-id`, and let the user run them.

## Step 7: Integrations and keys

Integrations are skills and tools that use a service's API: the homelab skills,
research agents with their own models, email reports, security and OSINT tools.
Each needs a key in `~/.opencode/.env`. A missing key only turns off the tool
that needs it.

Run: `bun .opencode/PAI/Tools/pai.ts keys`

It lists the groups and keys from `.opencode/.env.example`, and which are set.
Go through the groups the user wants, using the comments in `.env.example`, which
say where each key comes from:

- **Research agents:** extra API keys (Anthropic, xAI, Fireworks) give the
  researchers their own model families. Afterwards:
  `bun .opencode/tools/switch-provider.ts <profile> --multi-research`.
- **Email reports:** a Gmail address and an app password (not the Gmail password).
- **Homelab:** an API URL and a token per service from step 6. Create a token
  with read rights first; give write rights only when the user wants PAI to make
  changes.
- **Security and OSINT**, **Other tools:** only the services the user uses.

**You do this:** open the file in an editor, for example `nano ~/.opencode/.env`,
copy the lines you need from `.opencode/.env.example`, paste the values, save
and close. Never paste a key into this chat.

Run: `chmod 600 ~/.opencode/.env && bun .opencode/PAI/Tools/pai.ts keys`

Expected: the keys the user added are marked as set, and no warnings.
Tell the user that `guide/api-keys.md` explains how to replace a key later, and
what to do if one leaks.

For a homelab service, offer one read-only check after the key is in place, from
the service's own skill, so the key never passes through the chat.

## Step 8: Faults and improvements

Explain in two sentences: PAI will sometimes get something wrong, and the user
will have ideas for it. Noting them in one place means they get fixed instead of
forgotten, and the assistant can do the noting when asked. Then ask which way
the user wants. `guide/issue-tracking.md` has the details for both.

**Choice: a file in the repository**
- *What:* `.opencode/PAI/USER/ISSUES.md`, one entry per finding. The assistant
  writes an entry when the user says "note this as an issue", and when it runs
  into a fault in PAI itself, it stops and asks first.
- *You get:* a list in the repository, with nothing to set up.
- *Needs:* nothing.
- *Costs:* nothing.
- *Change later:* yes, run this step again.
- *We recommend:* to start with, and when PAI runs on one machine.

**Choice: your own Gitea**
- *What:* a Gitea server with an organisation and a private repository for this
  PAI: the copy is synced between the user's machines, and its issue list holds
  the findings. It is how PAI itself is run.
- *You get:* the same PAI on every machine (`pai-pull` before a session,
  `pai-push` after), issues with links and comments, a history of every change,
  and a place to try changes before relying on them.
- *Needs:* a Gitea server. The assistant can build one on a Proxmox host, in a
  small virtual machine (2 GB of memory, 10 GB of disk), or use one the user runs.
- *Costs:* nothing but the machine it runs on.
- *Change later:* yes.
- *We recommend:* if the user changes PAI or runs it on more than one machine.

Users who already run GitLab or use GitHub can say so: they make the private
repository and the token there themselves (`guide/issue-tracking.md`, "The
token"). Steps 4 to 6 under "If the user chooses Gitea" then apply, with
`--gitlab <group>/<repo>` or `--github <owner>/<repo>` in step 5.

### If the user chooses the file

Run: `bun PAI-Install/cli/issue-tracking.ts --file`

Expected: `✓ the section in INFRASTRUCTURE.md: faults and ideas go to a new
.opencode/PAI/USER/ISSUES.md` (or "the", when the file was there before). Do not
write the section or `ISSUES.md` yourself.

### If the user chooses Gitea

`guide/gitea.md` is the procedure, with its own rules for the agent and a script
for every step. Follow it from the start:

1. Ask where Gitea should run: a new VM on Proxmox (if there is a Proxmox host in
   the lab, step 6), the user's own Docker host, or a Gitea they already run. The
   guide offers to guide the user through the Proxmox token, and through SSH
   access to a Docker host, when they are missing.
2. Part 2 of the guide: the choice between tightened and full access for PAI on
   Gitea (with its fixed texts), then `pai-setup.sh` for the organisation, the
   repository, the SSH key and PAI's token. With tightened access, the user
   deletes the setup token in Gitea's web page; any later change to PAI's access
   is also made there, by hand.
3. Ask whether the user wants their PAI copy kept on Gitea and synced
   (`pai-pull`, `pai-push`), and run `sync.sh` after a yes.

4. Run: `bun .opencode/PAI/Tools/pai.ts keys`

   Expected: `GITEA_API_URL` and `GITEA_TOKEN` are set.
5. Run: `bun PAI-Install/cli/issue-tracking.ts --gitea <org>/<repo>`

   Expected: `✓ the section in INFRASTRUCTURE.md: faults and ideas go to the
   issues of <org>/<repo> (gitea)`. It writes the section and the recipe; do not
   write them yourself.
6. Offer a test: an issue titled "Test from the PAI setup", using the recipe now
   at the end of `.opencode/PAI/USER/INFRASTRUCTURE.md`. Show the link it prints.
   The user can close the issue afterwards.

The guide's last step does 5 and 6 for Gitea; skip what is done. The guide can be
split over two sessions, after Part 1: if this conversation is getting long, end
it there and give the user the line the guide shows.

## Step 9: Reaching PAI from another computer

Ask whether the user wants to reach PAI from another computer.

**Choice: remote access with tmux and SSH**
- *What:* tmux keeps PAI's terminal session alive on this machine. The user can
  disconnect and connect again, also from another computer, and find the
  conversation where they left it.
- *You get:* one command on your own computer, `ssh pai`, that takes you into
  that session.
- *Needs:* an SSH server on this machine, and the SSH client on the other
  computer (built into Linux, macOS and Windows 10 and 11). `install.sh` installed
  tmux.
- *Costs:* nothing.
- *Change later:* yes, run this step again.
- *We recommend:* yes if PAI runs on a server, a virtual machine or a computer in
  another room. Not needed if PAI runs on the computer the user sits at.

If yes:

Run: `tmux -V && command -v tmux`

Expected: a version and a path. If tmux is missing, `./install.sh` installs it
when run again (on macOS: `brew install tmux`).

Run: `ssh -o BatchMode=yes -o ConnectTimeout=5 localhost true 2>&1 | head -1`

"Connection refused" means no SSH server runs here. On Debian or Ubuntu, offer
`sudo apt-get install -y openssh-server`. On macOS, **You do this:** System
Settings, General, Sharing, turn on Remote Login. Any other answer, or none,
means the server runs.

Run: `whoami; pwd; hostname -I 2>/dev/null || ipconfig getifaddr en0`

Ask which of the addresses the other computer reaches this machine on (on a
home network, usually the first). Then fill in the user, the address and the
folder in this line, and show it:

**You do this:** on the other computer (Linux, macOS or WSL), in a terminal:
`scp <user>@<address>:<folder>/scripts/pai-client.sh /tmp/ && bash /tmp/pai-client.sh --host <address> --user <user>`

`scp` asks for the password on this machine once. The script makes an SSH key
if there is none, copies it here, and adds `ssh pai` and `ssh pai-shell` to the
other computer's SSH settings. It can be run again; it replaces its own lines.

On Windows without WSL, the script does not run. Show these instead, filled in,
for PowerShell (not tested yet on Windows):

```
ssh-keygen -t ed25519
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh <user>@<address> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
notepad $env:USERPROFILE\.ssh\config
```

and the lines to paste at the top of that file, with `<tmux path>` from the first
command in this step:

```
Host pai
  HostName <address>
  User <user>
  RequestTTY yes
  RemoteCommand <tmux path> -u new-session -A -s pai
Host pai-shell
  HostName <address>
  User <user>
Host *
```

Then explain how it is used, in three short lines:

- `ssh pai` opens the session. The first time, it is a shell: type `pai`.
  After that, it is PAI, where the user left it.
- **Ctrl+b**, then **d**, leaves the session running and disconnects.
- From outside the home network: use a VPN, never an SSH port open to the
  internet. `guide/remote-access.md` explains WireGuard and Tailscale.

## Step 10: Goals (TELOS), optional and last

TELOS is a short file about the user's mission, goals and challenges. With it,
PAI can weigh advice against what matters to the user. It goes into the context
of every session, so its contents reach the model provider each time.

Before asking anything, say which model is running and its data terms (step 1's
table). If the model is a free one that uses data, recommend switching to the
user's own model first (step 5) or skipping this step. Ask whether to go on.

If yes, ask a few open questions: what they are working towards this year, what
gets in the way, and what they want the assistant to keep in mind. Write the
answers, in their words, to `.opencode/PAI/USER/TELOS/TELOS.md` under the
headings **Mission**, **Goals** and **Challenges**. Keep it under a page. It can
grow later with the Telos skill; `guide/telos.md` explains how.

## Step 11: Finish

Run: `bun .opencode/PAI/Tools/pai.ts doctor`

Explain any red line in plain words; most are fixed by a step above. Then tell
the user:

- **Start PAI** with `pai` (OpenCode) or `pai --claude` (Claude Code), in a new
  terminal. The new name and models apply from then on. From another computer:
  `ssh pai` (step 9).
- **Their files:** the identity and lab in `.opencode/PAI/USER/`, the keys in
  `~/.opencode/.env`, the models in `opencode.json`, the memory in
  `.opencode/MEMORY/`.
- **New engine versions** come through PAI, not by themselves: ask the assistant
  to check the engines for updates now and then (step 5, "Both engines are pinned").
- **The guides** in `guide/` (start with `guide/README.md`) explain where things
  are, keys, faults and improvements, engine updates and remote access.
- **To change something later,** ask the assistant, or run this file again:
  `pai --prompt "Read SETUP.md and take me through step <n>"`.

Summarise what was set up and what was skipped, in a short list.
