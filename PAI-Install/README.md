# PAI-Install

The small tools that set up PAI on a machine. Each does one job with one right
answer, so no AI model has to get it right. Start with `./install.sh`, which
runs the first three; the setup conversation (`SETUP.md`) runs `identity.ts`
again with your names, and `issue-tracking.ts`. You can run any of them again
on its own.

| Tool | What it does |
|------|--------------|
| `cli/identity.ts` | Writes your assistant's name, your name and your time zone to `.opencode/settings.json`, `.opencode/PAI/USER/DAIDENTITY.md` and `opencode.json`. `--first-run` writes only `settings.json`, with neutral names until the setup conversation asks for yours; `--from-repo` reads the names from a PAI that is already set up (your second machine). |
| `cli/shell-setup.ts` | Puts the `pai` command in your login shell's profile. `--profile` only prints which file that is. |
| `cli/zen-start.ts` | Finds a free OpenCode Zen model that answers right now and writes it to `opencode.json` for the setup conversation. |
| `cli/issue-tracking.ts` | Writes where faults and ideas about PAI are noted, a file (`--file`) or the issues on a git server (`--gitea`, `--gitlab`, `--github` with `<owner>/<repo>`), into `.opencode/PAI/USER/INFRASTRUCTURE.md`. The text comes from `guide/issue-tracking.md`; a new run replaces it. |

Run each with `bun PAI-Install/cli/<tool>.ts`; the comment at the top of each
file has the options.

Your keys go in `.opencode/.env` (`.env.example` lists them), and logins to
model providers are made in PAI with `/connect` (OpenCode) or `/login` (Claude
Code). Claude Code and the provider profiles are choices in the setup
conversation, not in these tools.
