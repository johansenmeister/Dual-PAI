---
title: Faults and improvements
updated: 2026-10-04
---

# Faults and improvements

Sooner or later PAI does something wrong, or you think of something it should
do. Write it down in one place, so it can be fixed later instead of forgotten.
Your assistant can do the writing: say "note this as an issue". When the
assistant runs into a fault in PAI itself, it stops and tells you, and asks
whether to note it, instead of trying to fix PAI on its own.

There are two ways. The setup conversation (`SETUP.md`, "Faults and
improvements") asks which one you want, and `PAI-Install/cli/issue-tracking.ts`
writes the instructions below into `.opencode/PAI/USER/INFRASTRUCTURE.md`, so the
assistant knows them in every session. To switch later, run the tool again with
the other choice: it replaces its own section.

| | A file in the repository | A git server with issues |
|---|---|---|
| **What** | `.opencode/PAI/USER/ISSUES.md`, one entry per finding | your own Gitea, with a private copy of PAI and its issue list |
| **Needs** | nothing | a Gitea server (your assistant can build one on Proxmox), an account and a token |
| **You get** | a list you and the assistant can read and edit | issues with links, comments and notifications, the same PAI on every machine (`pai-pull`, `pai-push`), and a place to test changes before you use them |
| **Costs** | nothing | nothing for a server of your own or a free account; a server needs a machine |
| **We recommend** | to start with, and if PAI runs on one machine | if you change PAI yourself, or run it on more than one machine |

## A file in the repository

The assistant adds an entry at the top of `.opencode/PAI/USER/ISSUES.md`:

```
## 2026-10-04 · Short title
- **Status:** open
- **What happened:** what you or the assistant saw
- **Expected:** what should have happened
- **Where:** machine, engine and version (`pai version`), skill or file
- **Idea:** a fix or improvement, if there is one
```

When something is fixed, its status becomes `done`, with a line on what fixed it.
Old entries can be deleted; git keeps them in the history.

The section for `INFRASTRUCTURE.md`:

```markdown
## Faults and improvements

When you find a fault in PAI itself (its hooks, launcher, skills, tools or these
instructions), stop what you are doing and tell the user what you found, before
you try to fix anything. Ask whether to note it. If the user says yes, or asks
you to note a fault or an idea, add an entry at the top of
`.opencode/PAI/USER/ISSUES.md` in the form described in `guide/issue-tracking.md`.
Do not change PAI's code for it unless the user asks.

No secrets, keys, tokens or personal data in an entry, not even in a log excerpt:
remove what looks like one and say it was removed.
```

## A git server with issues

PAI's own setup: a **Gitea** with an organisation and one private repository for
the harness. The repository is your PAI copy, synced between your machines, and
its issue list is where findings go. [Gitea for PAI](gitea.md) sets it all up,
and can build the server on Proxmox first.

**The two remotes.** `origin` is your Gitea: `pai-pull` and `pai-push` sync with
it. `upstream` is where you cloned PAI from: `git pull --no-rebase --no-edit
upstream main` brings PAI's updates, and `pai-push` passes them on to your
machines.

**Testing a change first.** When you or the assistant change PAI itself (a skill,
a rule), do it on a branch: `git switch -c staging`, try it in a session, and
merge it when it works: `git switch main && git merge staging`. With more than one
machine, one of them can run the branch for a while before the others get it.
That machine is your staging machine.

**Never push to a public repository.** Your identity, your lab and the
assistant's memory are in the repository.

**Already on GitLab or GitHub?** Then you know how to make a private repository
and a token there. The table and the recipes below cover them too.

### The token

PAI's token can write issues and nothing else, unless you give it more: on Gitea,
[Gitea for PAI](gitea.md) lets you choose full access instead. It goes in
`~/.opencode/.env` ([API keys](api-keys.md)):

| Server | Lines in `~/.opencode/.env` | Token |
|---|---|---|
| Gitea | `GITEA_API_URL=http://<host>:3000` (no `/api/v1`) and `GITEA_TOKEN=` | Settings, Applications; scope `write:issue` |
| GitLab | `GITLAB_URL=https://<host>` and `GITLAB_TOKEN=` | the project's Settings, Access tokens; role Reporter, scope `api` |
| GitHub | `GITHUB_TOKEN=` | Settings, Developer settings, fine-grained token for the one repository, Issues: read and write |

### The section for `INFRASTRUCTURE.md`

`issue-tracking.ts` writes this, with your repository and server filled in, and
the recipe for your server below it. Every recipe keeps the token out of the
command line and out of the chat: it is read into a variable and passed to
`curl` through a file descriptor.

```markdown
## Faults and improvements

Findings about PAI go to the issue list of `<owner>/<repo>` on <server>. When
you find a fault in PAI itself (its hooks, launcher, skills, tools or these
instructions), stop what you are doing and tell the user what you found, before
you try to fix anything. Ask whether to write an issue. If the user says yes, or
asks you to note a fault or an idea, write one there. Do not change PAI's code
for it unless the user asks.

- The title is short and specific. The body has five parts: **Machine and
  engine** (host name, `pai version`), **What happened**, **Expected**, **How to
  reproduce**, **Log** (a short excerpt).
- No secrets, keys, tokens or personal data, not even in the log. Remove what
  looks like one and say it was removed.
- Run the recipe in bash, and give the user the link it prints.
```

Then one of these, filled in, below it. The Gitea and GitLab recipes are tested
(Gitea 1.27.3, GitLab 19.4.1, 2026-10-04); the GitHub one is not yet.

**Gitea**

```bash
T=$(sed -n 's/^GITEA_TOKEN=//p' ~/.opencode/.env); U=$(sed -n 's/^GITEA_API_URL=//p' ~/.opencode/.env)
jq -n --arg t "<title>" --arg b "<body>" '{title: $t, body: $b}' |
  curl -sS -K <(printf 'header = "Authorization: token %s"\n' "$T") -H 'Content-Type: application/json' \
    -d @- "$U/api/v1/repos/<owner>/<repo>/issues" | jq -r '.html_url // .'
```

**GitLab** (the project is `<group>%2F<repo>`, with the slash written as `%2F`)

```bash
T=$(sed -n 's/^GITLAB_TOKEN=//p' ~/.opencode/.env); U=$(sed -n 's/^GITLAB_URL=//p' ~/.opencode/.env)
jq -n --arg t "<title>" --arg b "<body>" '{title: $t, description: $b}' |
  curl -sS -K <(printf 'header = "PRIVATE-TOKEN: %s"\n' "$T") -H 'Content-Type: application/json' \
    -d @- "$U/api/v4/projects/<group>%2F<repo>/issues" | jq -r '.web_url // .'
```

**GitHub**

```bash
T=$(sed -n 's/^GITHUB_TOKEN=//p' ~/.opencode/.env)
jq -n --arg t "<title>" --arg b "<body>" '{title: $t, body: $b}' |
  curl -sS -K <(printf 'header = "Authorization: Bearer %s"\n' "$T") -H 'Accept: application/vnd.github+json' \
    -d @- "https://api.github.com/repos/<owner>/<repo>/issues" | jq -r '.html_url // .'
```

If the answer is an error instead of a link, the message says why: usually a
token without the right scope, or a wrong owner or repository name.
