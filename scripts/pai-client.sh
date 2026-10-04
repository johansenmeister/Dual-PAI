#!/usr/bin/env bash
# pai-client.sh — reach PAI on another machine with one command: ssh pai
#
# Run this on the computer you sit at (Linux, macOS or WSL), not on the machine
# PAI runs on. It asks for the PAI machine's address and your user name there,
# makes an SSH key if you have none, copies it over (you type your password
# once), and adds two entries to ~/.ssh/config:
#
#   ssh pai          opens PAI's terminal session (tmux) on that machine. If
#                    the session is already running, you come back to it,
#                    right where you left it. Detach with Ctrl+b, then d.
#   ssh pai-shell    a plain shell, for commands, rsync and git over SSH.
#
# Usage:
#   bash pai-client.sh                         asks for what it needs
#   bash pai-client.sh --host 192.168.1.20 --user anna [--port 22] [--alias pai]
#
# Running it again replaces its own entries and leaves the rest of the file alone.
set -euo pipefail

HOST="" RUSER="" PORT=22 ALIAS=pai
while [ $# -gt 0 ]; do
  case $1 in
    --host) HOST=${2:?--host needs a value}; shift 2 ;;
    --user) RUSER=${2:?--user needs a value}; shift 2 ;;
    --port) PORT=${2:?--port needs a value}; shift 2 ;;
    --alias) ALIAS=${2:?--alias needs a value}; shift 2 ;;
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see bash pai-client.sh --help)" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[0;32m  ✓\033[0m %s\n' "$*"; }
die() { printf '\033[0;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ask() { # ask <prompt> <default>: the answer, or the default on Enter
  local a
  read -r -p "  $1${2:+ [$2]}: " a </dev/tty || a=""
  printf '%s' "${a:-$2}"
}

for c in ssh ssh-keygen; do command -v "$c" >/dev/null || die "$c is not installed. Install the OpenSSH client first."; done
[ -n "$HOST" ] || HOST=$(ask "Address of the PAI machine (IP or host name)" "")
[ -n "$HOST" ] || die "No address given."
[ -n "$RUSER" ] || RUSER=$(ask "Your user name on $HOST" "${USER:-}")
case $ALIAS in *[!A-Za-z0-9_.-]* | "") die "The alias may only have letters, digits, '.', '_' and '-': $ALIAS" ;; esac
case $PORT in *[!0-9]* | "") die "The port must be a number: $PORT" ;; esac

SSH_DIR="$HOME/.ssh" CONFIG="$HOME/.ssh/config"
BEGIN="# >>> PAI client: $ALIAS >>>" END="# <<< PAI client: $ALIAS <<<"
mkdir -p "$SSH_DIR" && chmod 700 "$SSH_DIR"
touch "$CONFIG" && chmod 600 "$CONFIG"

# The rest of the file, without our own entries from an earlier run.
without_ours() { awk -v b="$BEGIN" -v e="$END" '$0 == b { skip = 1; next } $0 == e { skip = 0; next } !skip' "$CONFIG"; }

# An entry with the same name that we did not write would win or clash: stop.
alias_re=${ALIAS//./\\.}
if without_ours | grep -qiE "^[[:space:]]*Host([[:space:]]+[^[:space:]]+)*[[:space:]]+($alias_re|$alias_re-shell)([[:space:]]|\$)"; then
  die "$CONFIG already has a 'Host $ALIAS' (or $ALIAS-shell) entry of your own. Run again with --alias <another name>."
fi

# ─── The key ───────────────────────────────────────────────────────────────
KEY=""
for k in id_ed25519 id_ecdsa id_rsa; do [ -f "$SSH_DIR/$k" ] && { KEY="$SSH_DIR/$k"; break; }; done
if [ -z "$KEY" ]; then
  say "Making an SSH key (a passphrase is optional; with one, you type it when you connect)"
  KEY="$SSH_DIR/id_ed25519"
  ssh-keygen -t ed25519 -f "$KEY" </dev/tty
fi
ok "key: $KEY"

remote() { ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$PORT" -i "$KEY" -o IdentitiesOnly=yes "$RUSER@$HOST" "$@"; }

if ! remote true 2>/dev/null; then
  say "Copying the key to $RUSER@$HOST (type your password there once)"
  command -v ssh-copy-id >/dev/null || die "ssh-copy-id is missing. Add the contents of $KEY.pub to ~/.ssh/authorized_keys on $HOST by hand, then run this again."
  ssh-copy-id -i "$KEY.pub" -p "$PORT" "$RUSER@$HOST" </dev/tty
  remote true || die "Logging in with the key still fails. Check the address, the user name and that SSH runs on $HOST (port $PORT)."
fi
ok "logs in with the key, no password"

# ─── tmux on the PAI machine ───────────────────────────────────────────────
# The command runs in a non-interactive shell, whose PATH can miss Homebrew's
# folders on macOS (measured: /usr/bin:/bin:/usr/sbin:/sbin), so the full path goes in the entry.
TMUX_BIN=$(remote 'command -v tmux || for d in /opt/homebrew/bin /usr/local/bin; do [ -x "$d/tmux" ] && { echo "$d/tmux"; break; }; done' 2>/dev/null || true)
[ -n "$TMUX_BIN" ] || die "tmux is not installed on $HOST. Run install.sh there again (it installs tmux), or install it with the package manager, then run this again."
ok "tmux on $HOST: $TMUX_BIN"

# ─── The entries ───────────────────────────────────────────────────────────
# At the top, since ssh uses the first value it finds for each option: a
# 'Host *' entry above ours could otherwise set another user. The block ends
# with 'Host *', so lines that follow it still apply to every host, as before.
# tmux -u: the server's locale can be C (measured on a Debian 13 container), and
# tmux then shows every non-ASCII character, the TUI's frames too, as '_'.
key_path=${KEY/#$HOME/\~}
block="$BEGIN
# Written by pai-client.sh. Running it again replaces this block.
Host $ALIAS
  HostName $HOST
  User $RUSER
  Port $PORT
  IdentityFile $key_path
  RequestTTY yes
  RemoteCommand $TMUX_BIN -u new-session -A -s pai
Host $ALIAS-shell
  HostName $HOST
  User $RUSER
  Port $PORT
  IdentityFile $key_path
Host *
$END"
rest=$(without_ours)
# Written in place, not moved: the file can be a link into a dotfiles repo.
printf '%s\n%s\n' "$block" "$rest" >"$CONFIG.pai-new" && cat "$CONFIG.pai-new" >"$CONFIG" && rm "$CONFIG.pai-new"
ok "added '$ALIAS' and '$ALIAS-shell' to $CONFIG"

ssh -F "$CONFIG" -o BatchMode=yes "$ALIAS-shell" true || die "The new entry does not log in. Look at the block at the top of $CONFIG."

printf '\nDone. From now on:\n\n'
printf '  %-18s %s\n' "ssh $ALIAS" "PAI's session on $HOST. The first time, you get a" \
  "" "shell there: type pai to start PAI. Next time you come back to it." \
  "Ctrl+b, then d" "leave the session running and disconnect" \
  "ssh $ALIAS-shell" "a plain shell on $HOST (commands, rsync, git)"
cat <<EOF

Outside your home network, use a VPN (WireGuard or Tailscale) rather than
opening SSH to the internet: see guide/remote-access.md in the PAI repository.
EOF
