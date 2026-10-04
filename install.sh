#!/usr/bin/env bash
# install.sh — the first step of setting up PAI on a new machine.
#
# It does the parts that have one right answer, so no AI model has to get them
# right: the operating system, git, Bun, the two pinned engine packages, this
# machine's settings, and a free model to start with. Then it opens OpenCode with
# PAI loaded and SETUP.md as the first message. From there the agent walks you
# through the rest: your assistant's name and personality, the engine and
# models you want, your lab, and the integrations.
#
# Usage, before you have cloned anything (it installs git and clones PAI):
#   curl -fsSL https://raw.githubusercontent.com/johansenmeister/dual-pai/main/install.sh | bash
#   bash install.sh [--repo <git url>] [--dir ~/repos/pai]
# Usage, from the folder you cloned:
#   ./install.sh               install, then start the setup conversation
#   ./install.sh --no-start    install only (start later with: pai --prompt "...")
#   ./install.sh --force       take over ~/.opencode even if it points elsewhere
#
# In a clone of a PAI that is already set up (a second machine), it makes only
# this machine's files and leaves the tracked ones alone.
#
# Linux and WSL2 are supported. macOS is tested on Intel (macOS 15), not yet on
# Apple Silicon.
set -euo pipefail

# The script's own path; empty when piped from curl (inside a function, bash
# would say "main").
SRC=${BASH_SOURCE[0]:-}

# Everything is in main, called on the last line: piped from curl, bash then has
# the whole script before it runs any of it.
main() {

# Where PAI is cloned from when this script runs on its own. --repo clones
# from somewhere else: a fork, or your own Gitea.
PAI_REPO_URL="https://github.com/johansenmeister/dual-pai.git"

START=1 FORCE=0 CLONE_URL=$PAI_REPO_URL CLONE_DIR="$HOME/repos/pai"
PASS=() # the options the clone's own install.sh gets
while [ $# -gt 0 ]; do
  case $1 in
    --no-start) START=0; PASS+=("$1") ;;
    --force) FORCE=1; PASS+=("$1") ;;
    --repo) [ $# -ge 2 ] || { echo "--repo needs a git url" >&2; exit 1; }; CLONE_URL=$2; shift ;;
    --dir) [ $# -ge 2 ] || { echo "--dir needs a folder" >&2; exit 1; }; CLONE_DIR=$2; shift ;;
    -h | --help)
      if [ -f "$SRC" ]; then sed -n '2,22p' "$SRC" | sed 's/^# \{0,1\}//'; fi
      exit 0 ;;
    *) echo "Unknown option: $1 (see ./install.sh --help)" >&2; exit 1 ;;
  esac
  shift
done

# Run from a clone, the repo is the script's folder. Piped from curl, or run as a
# lone file, there is no repo yet: then git is installed first, and PAI is cloned.
HERE=""
[ -f "$SRC" ] && HERE=$(cd "$(dirname "$SRC")" && pwd)
if [ -n "$HERE" ] && [ -f "$HERE/SETUP.md" ] && [ -f "$HERE/.opencode/package.json" ]; then
  REPO=$HERE
else
  REPO=""
fi

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[0;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die() { printf '\033[0;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ─── 1. Where are we? ──────────────────────────────────────────────────────
say "Checking the system"
[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not as root. It asks for sudo when it needs it."
case $(uname -s) in
  Linux)
    if grep -qi microsoft /proc/version 2>/dev/null; then
      OS="WSL2"
      case ${REPO:-$CLONE_DIR} in /mnt/*) die "The repo is on the Windows drive (${REPO:-$CLONE_DIR}). Clone it inside WSL instead, e.g. under ~/repos: it is much faster, and file permissions work." ;; esac
    else
      OS="Linux"
    fi ;;
  Darwin) OS="macOS"
    [ "$(uname -m)" = x86_64 ] || warn "macOS is tested on Intel Macs only, not on $(uname -m). Steps that fail here are worth an issue." ;;
  *) die "Unsupported system: $(uname -s). PAI runs on Linux, WSL2 and macOS." ;;
esac
if [ -n "$REPO" ]; then ok "$OS, $(uname -m), repo in $REPO"; else ok "$OS, $(uname -m), not cloned yet"; fi

# ─── 2. git, curl, unzip, jq ───────────────────────────────────────────────
# Each tool must run, not only exist: on macOS without the Command Line Tools,
# /usr/bin/git is a stub that exits 1 (measured on Sequoia 15.8).
# jq reads the JSON answers from APIs in many skills and recipes; macOS 15 has it
# in /usr/bin (measured: jq-1.7.1-apple).
# On Linux, the first package manager found installs what is missing; the package
# names are the same in all of them. Debian, Ubuntu and WSL have apt-get; Fedora,
# RHEL, Rocky and Alma dnf (yum before RHEL 8); openSUSE zypper; Arch pacman.
PKG=""
if [ "$OS" != macOS ]; then
  for p in apt-get dnf yum zypper pacman; do command -v "$p" >/dev/null && { PKG=$p; break; }; done
fi
APT_UPDATED=0
pkg_install() {
  case $PKG in
    apt-get)
      [ $APT_UPDATED -eq 1 ] || { sudo apt-get update -qq && APT_UPDATED=1; } || return 1
      sudo apt-get install -y -qq "$@" ;;
    dnf | yum) sudo "$PKG" install -y -q "$@" ;;
    zypper) sudo zypper --non-interactive --quiet install "$@" ;;
    pacman) sudo pacman -S --needed --noconfirm "$@" ;;
    *) return 1 ;;
  esac </dev/null >/dev/null
}

missing=()
for c in git curl unzip jq; do "$c" --version >/dev/null 2>&1 || "$c" -v >/dev/null 2>&1 || missing+=("$c"); done
if [ ${#missing[@]} -gt 0 ]; then
  if [ "$OS" = macOS ]; then
    if [ "${missing[*]}" = jq ]; then die "jq is missing (macOS before 15 does not have it). Install it with: brew install jq, then run ./install.sh again."; fi
    die "${missing[*]} does not run yet. Install Apple's Command Line Tools with: xcode-select --install (a window opens on the Mac's screen), then run ./install.sh again."
  elif [ -n "$PKG" ]; then
    say "Installing ${missing[*]} with $PKG (needs sudo)"
    pkg_install "${missing[@]}" ca-certificates || die "$PKG could not install ${missing[*]}. Install them yourself, then run ./install.sh again."
  else
    die "Please install ${missing[*]} with your package manager, then run ./install.sh again."
  fi
fi
ok "git, curl, unzip and jq are there"

# tmux keeps a PAI session alive when you disconnect, so you can come back to it,
# also from another computer (scripts/pai-client.sh). Not required to run PAI.
if ! tmux -V >/dev/null 2>&1; then
  if [ -n "$PKG" ]; then
    say "Installing tmux with $PKG (needs sudo)"
    pkg_install tmux || warn "tmux did not install. You need it only to reach PAI from another computer."
  else
    warn "tmux is not installed. You need it only to reach PAI from another computer (macOS: brew install tmux)."
  fi
fi
if tmux -V >/dev/null 2>&1; then
  if [ ! -e "$HOME/.tmux.conf" ] && [ ! -e "${XDG_CONFIG_HOME:-$HOME/.config}/tmux/tmux.conf" ]; then
    cat >"$HOME/.tmux.conf" <<'EOF'
# Written by PAI's install.sh because you had no tmux config. Change it freely.
set -g mouse on            # scroll with the wheel; hold Shift to select text the usual way
set -g history-limit 50000 # lines you can scroll back
EOF
  fi
  ok "$(tmux -V)"
fi

# ─── 3. The repo ───────────────────────────────────────────────────────────
# Not run from a clone: clone PAI now that git is here, and go on with the
# clone's own install.sh, so the steps below are the ones that came with it.
if [ -z "$REPO" ]; then
  if [ -f "$CLONE_DIR/SETUP.md" ] && [ -f "$CLONE_DIR/install.sh" ]; then
    ok "PAI is already cloned in $CLONE_DIR"
  else
    [ -n "$CLONE_URL" ] || die "Where should PAI be cloned from? Run again with: --repo <git url>"
    if [ -e "$CLONE_DIR" ] && [ -n "$(ls -A "$CLONE_DIR" 2>/dev/null)" ]; then
      die "$CLONE_DIR exists and is not empty. Choose another folder with: --dir <folder>"
    fi
    say "Cloning PAI into $CLONE_DIR"
    mkdir -p "$(dirname "$CLONE_DIR")"
    git clone --quiet "$CLONE_URL" "$CLONE_DIR" || die "git could not clone $CLONE_URL"
    ok "cloned from $CLONE_URL"
  fi
  # Piped from curl, this script's stdin is the pipe; the questions need the
  # terminal. By its real name: tmux refuses stdin from /dev/tty ("can't use
  # /dev/tty", measured in a Debian container), and ps gives pts/0 or ttys001.
  # Read and write: the tmux client draws the screen through stdin.
  term=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ' || true)
  case $term in '' | '?' | '??') term=/dev/tty ;; /*) ;; *) term=/dev/$term ;; esac
  if [ -r "$term" ] && { : <>"$term"; } 2>/dev/null; then
    exec bash "$CLONE_DIR/install.sh" ${PASS[@]+"${PASS[@]}"} <>"$term"
  fi
  exec bash "$CLONE_DIR/install.sh" ${PASS[@]+"${PASS[@]}"}
fi

# ─── 4. Bun ────────────────────────────────────────────────────────────────
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
if ! command -v bun >/dev/null; then
  say "Installing Bun (the JavaScript runtime PAI runs on)"
  curl -fsSL https://bun.sh/install | bash >/dev/null
  command -v bun >/dev/null || die "Bun did not install. See https://bun.sh/docs/installation"
fi
ok "Bun $(bun --version)"

# ─── 5. One PAI per user account ───────────────────────────────────────────
# ~/.opencode and ~/.config/opencode are per-user links into the repo, and the
# setup rewrites the `pai` command in your shell profile.
if [ -e "$HOME/.opencode" ] || [ -L "$HOME/.opencode" ]; then
  current=$(realpath "$HOME/.opencode" 2>/dev/null || true)
  if [ "$current" != "$REPO/.opencode" ] && [ $FORCE -eq 0 ]; then
    die "~/.opencode already exists and points to ${current:-something else}. One PAI per user account: run with --force to replace it (a real folder is backed up first)."
  fi
fi
FIRST=1
[ -f "$REPO/.opencode/settings.json" ] && FIRST=0
# A clone of a PAI that is already set up (your second machine, synced through
# your own git server): the identity is yours, not the template. Then only the
# files that belong to this machine are made, and the tracked ones (opencode.json,
# the models, your identity) are left alone, so the next push spreads nothing.
SECOND=0
if [ $FIRST -eq 1 ] && [ -f "$REPO/.opencode/PAI/USER/DAIDENTITY.md" ] &&
  ! cmp -s "$REPO/.opencode/PAI/USER/DAIDENTITY.md" "$REPO/.opencode/PAI/DAIDENTITY.template.md"; then
  SECOND=1
fi

# OpenCode's global config folder points into the repo. This comes before the
# engine runs for the first time: it creates the folder, empty, if it is missing.
if [ -d "$HOME/.config/opencode" ] && [ ! -L "$HOME/.config/opencode" ]; then
  rmdir "$HOME/.config/opencode" 2>/dev/null || true
fi
if [ ! -e "$HOME/.config/opencode" ]; then
  mkdir -p "$HOME/.config"
  ln -s "$REPO/config/opencode" "$HOME/.config/opencode"
elif [ "$(realpath "$HOME/.config/opencode")" != "$REPO/config/opencode" ]; then
  warn "~/.config/opencode is not PAI's and not empty. Leaving it alone: move it aside and run install.sh again to link it to $REPO/config/opencode."
fi

# ─── 6. Dependencies and the pinned engines ────────────────────────────────
say "Installing dependencies (the engine download is about 800 MB, give it a few minutes)"
# Bun prints a line when it finds .env in the folder (on a re-run); it reads no key from it here.
quiet_install() { (cd "$1" && bun install --silent 2>&1) | { grep -v '"\.env"$' || true; }; }
quiet_install "$REPO"
quiet_install "$REPO/.opencode"
BIN="$REPO/.opencode/node_modules/@opencode/cli/bin/opencode.exe"
is_elf() { [ "$(head -c 4 "$BIN" 2>/dev/null | od -An -c | tr -d ' ')" = '177ELF' ]; }
if ! is_elf; then
  # The package's postinstall fetches the real binary; without it the file is a stub.
  (cd "$REPO/.opencode" && bun pm trust @opencode/cli >/dev/null 2>&1 || true; rm -rf node_modules/@opencode/cli && bun install --silent)
  is_elf || [ "$OS" = macOS ] || die "The OpenCode binary did not install ($BIN), even with the package's postinstall trusted. Check the network and free disk space (about 800 MB), and run install.sh again."
fi
ok "OpenCode $("$BIN" --version 2>/dev/null | head -1 | sed 's/^opencode //') (pinned in .opencode/package.json)"

# ─── 7. This machine's files ───────────────────────────────────────────────
# settings.json and .env are per machine and not in git; ~/.opencode is a link
# into the repo, and the pai command goes in the shell profile.
link_opencode() {
  if [ -L "$HOME/.opencode" ] || [ -e "$HOME/.opencode" ]; then
    if [ "$(realpath "$HOME/.opencode" 2>/dev/null)" != "$REPO/.opencode" ]; then
      if [ -L "$HOME/.opencode" ]; then rm "$HOME/.opencode"; else mv "$HOME/.opencode" "$HOME/.opencode.backup-$(date +%s)"; fi
    fi
  fi
  [ -e "$HOME/.opencode" ] || ln -s "$REPO/.opencode" "$HOME/.opencode"
}
if [ $SECOND -eq 1 ]; then
  say "Setting up this machine for the PAI in this repo (it is already set up; tracked files are left alone)"
  bun "$REPO/PAI-Install/cli/identity.ts" --from-repo >/dev/null ||
    die "Could not read your names from .opencode/PAI/USER/DAIDENTITY.md. Run: bun PAI-Install/cli/identity.ts --from-repo"
  link_opencode
  bun "$REPO/PAI-Install/cli/shell-setup.ts" >/dev/null || die "Could not write the pai command to your shell profile."
  ok "settings.json with your names, and the ~/.opencode link"
elif [ $FIRST -eq 1 ]; then
  say "Setting up PAI on this machine"
  # Neutral names for now: the setup conversation asks for yours and writes them.
  bun "$REPO/PAI-Install/cli/identity.ts" --first-run >/dev/null ||
    die "Could not write .opencode/settings.json. Run: bun PAI-Install/cli/identity.ts --first-run"
  link_opencode
  if [ ! -e "$REPO/.opencode/.env" ]; then
    (umask 077 && printf '%s\n' \
      "# Your keys for PAI's tools. Never commit this file." \
      "# The groups and keys are in .env.example; 'pai keys' shows which are set." \
      "# Logins to model providers are not here: use /connect in PAI." >"$REPO/.opencode/.env")
  fi
  bun "$REPO/PAI-Install/cli/shell-setup.ts" >/dev/null || die "Could not write the pai command to your shell profile."
  ok "settings.json, .env and the ~/.opencode link"
else
  ok "PAI is already installed here (.opencode/settings.json exists); keeping your settings"
fi
if [ $FIRST -eq 1 ]; then
  # The pai function goes to the login shell's profile. Check that a new login
  # shell actually has it, the same shell shell-setup.ts chose.
  login_shell=${SHELL:-$(bun -e 'console.log(require("node:os").userInfo().shell ?? "")' 2>/dev/null)}
  login_shell=${login_shell:-/bin/sh}
  # An interactive shell takes the terminal: under timeout, which runs it in its own
  # process group, it is stopped by SIGTTOU and never returns (measured over ssh).
  # setsid runs it without a terminal; timeout only goes with it (macOS has neither).
  t=""; command -v timeout >/dev/null && command -v setsid >/dev/null && t="timeout -k 5 20 setsid -w"
  if $t "$login_shell" -lic 'type pai' </dev/null >/dev/null 2>&1; then
    ok "the pai command (in $(basename "$login_shell")'s profile)"
  else
    profile=$(grep -l '# PAI shell setup' "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile" \
      "$HOME/.config/fish/config.fish" 2>/dev/null | head -1 || true)
    warn "A new $login_shell login shell does not find the pai command (it was put in ${profile:-no file})."
    warn "Copy the '# PAI shell setup' block to the file your shell reads, or start PAI with: bun $REPO/.opencode/PAI/Tools/pai.ts"
  fi
fi

# ─── 8. A free model to start with ─────────────────────────────────────────
if [ $FIRST -eq 1 ] && [ $SECOND -eq 0 ]; then
  say "Choosing a free model for the setup conversation"
  set +e; MODEL=$(bun "$REPO/PAI-Install/cli/zen-start.ts"); code=$?; set -e
  if [ $code -eq 2 ]; then
    warn "Neither of the free models that keep no data answered right now."
    warn "Other free models may use what you type to improve the model: https://opencode.ai/docs/zen/#privacy"
    read -r -p "  Use one of them for the setup conversation anyway? [y/N] " answer </dev/tty || answer=n
    [ "$answer" = y ] || [ "$answer" = Y ] || die "Stopped. Run ./install.sh again later, or connect a provider of your own (see SETUP.md)."
    MODEL=$(bun "$REPO/PAI-Install/cli/zen-start.ts" --allow-other) || die "No free model answered. Check the network and run ./install.sh again."
  elif [ $code -ne 0 ]; then
    die "Could not reach OpenCode Zen. Check the network and run ./install.sh again."
  fi
  ok "$MODEL (free, through OpenCode Zen; you choose your own models later)"
fi

# ─── 9. Hand over to the agent ─────────────────────────────────────────────
if [ $SECOND -eq 1 ]; then
  cat <<EOF

PAI is set up on this machine, with the identity, models and settings from the
repo. Two things are not in git and belong to each machine: your keys (copy
.opencode/.env from your other machine) and the logins to model providers
(/connect in PAI). guide/api-keys.md has both.

In a new terminal, PAI starts with: pai
EOF
  exit 0
fi
PROMPT="Read $REPO/SETUP.md and guide me through it from the start, one step at a time."
cat <<EOF

PAI is installed. The rest is a conversation: OpenCode opens and sends this
message for you:

  $PROMPT

You can stop at any time with Ctrl+C and pick up later by starting PAI again
and sending the same message. In a new terminal, PAI starts with: pai
EOF
if [ $START -eq 1 ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    # Over SSH, a dropped connection would end the conversation. Inside tmux it
    # keeps running, and `tmux attach -t pai` (or `ssh pai`) takes you back to it.
    if [ -n "${SSH_CONNECTION:-}" ] && [ -z "${TMUX:-}" ] && tmux -V >/dev/null 2>&1; then
      echo
      echo "You are connected over SSH. Inside tmux, the conversation survives a dropped"
      echo "connection: log in again and run 'tmux attach -t pai' to get back to it."
      read -r -p "Start it inside tmux? [Y/n] " answer </dev/tty || answer=n
      if [ "$answer" != n ] && [ "$answer" != N ]; then
        q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
        # Full path to bun: a tmux server that already runs keeps its own PATH.
        # When the conversation ends, a login shell stays in the window, with pai.
        # -u: the locale over SSH can be C (Debian containers), and tmux then
        # draws every non-ASCII character as '_'.
        exec tmux -u new-session -A -s pai \
          "$(q "$(command -v bun)") $(q "$REPO/.opencode/PAI/Tools/pai.ts") --prompt $(q "$PROMPT"); exec \"\${SHELL:-/bin/bash}\" -l"
      fi
    fi
    read -r -p "Press Enter to start OpenCode … " _ </dev/tty
    exec bun "$REPO/.opencode/PAI/Tools/pai.ts" --prompt "$PROMPT"
  else
    warn "No terminal here, so OpenCode is not started. Run: pai --prompt \"$PROMPT\""
  fi
fi
}

main "$@"
