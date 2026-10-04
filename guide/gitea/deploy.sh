#!/usr/bin/env bash
# deploy.sh — Gitea on a Docker host, over SSH (guide/gitea.md, Part 1).
#
# Usage, from the PAI folder:
#   bash guide/gitea/deploy.sh <user>@<host> [--address <address>]
#
# The host is the VM from vm.sh, or a Docker host you already have. The
# address is what browsers and PAI use to reach Gitea; it defaults to <host>.
# Exit status 2 means this machine cannot log in there with a key yet: the
# message says how to set that up. It copies guide/gitea/compose.yml to
# ~/gitea on the host, starts it, and waits until Gitea answers.
set -euo pipefail

TARGET="" ADDR=""
while [ $# -gt 0 ]; do
  case $1 in
    --address) ADDR=$2; shift 2 ;;
    -h | --help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
    *) TARGET=$1; shift ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
die() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

case $TARGET in *@*) ;; *) die "give the host as <user>@<host> (see --help)" ;; esac
[ -n "$ADDR" ] || ADDR=${TARGET#*@}
HERE=$(cd "$(dirname "$0")" && pwd)
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$TARGET")

say "Logging in to $TARGET"
if ! "${SSH[@]}" true 2>/dev/null; then
  key=$(ls ~/.ssh/id_ed25519.pub ~/.ssh/id_ecdsa.pub ~/.ssh/id_rsa.pub 2>/dev/null | head -1 || true)
  if [ -n "$key" ]; then have="It has a key: $key."; else have='It has no SSH key yet. Make one: ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""'; fi
  cat >&2 <<EOF
  ✗ This machine cannot log in to $TARGET with a key yet.
    $have
    Copy the key to the host, in a terminal on this machine (the one PAI runs on);
    you type the password for $TARGET there once:
      ssh-copy-id $TARGET
    Then run this again.
EOF
  exit 2
fi
ok "logged in with a key"

say "Checking Docker on $TARGET"
if ! "${SSH[@]}" 'docker info >/dev/null 2>&1'; then
  if "${SSH[@]}" 'command -v docker >/dev/null'; then
    die "Docker is installed, but ${TARGET%@*} may not use it. On the host: sudo usermod -aG docker ${TARGET%@*}, log out and in, and run this again."
  elif "${SSH[@]}" 'command -v apt-get >/dev/null && sudo -n true 2>/dev/null'; then
    say "Installing Docker (Debian's or Ubuntu's own packages)"
    "${SSH[@]}" "sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose >/dev/null && sudo usermod -aG docker ${TARGET%@*}" ||
      die "installing Docker failed"
  else
    die "Docker is not installed on $TARGET, and this script cannot install it there (no apt, or sudo asks for a password). Install Docker and its compose plugin, then run this again."
  fi
fi
"${SSH[@]}" 'docker compose version >/dev/null 2>&1' || die "Docker's compose plugin is missing on $TARGET (Debian: apt install docker-compose)"
ok "$("${SSH[@]}" 'docker --version')"

# A second run on the same host reuses ~/gitea; a stranger on the ports stops it.
if ! "${SSH[@]}" 'test -f ~/gitea/docker-compose.yml'; then
  busy=$("${SSH[@]}" "ss -Hltn 2>/dev/null | awk '{print \$4}' | grep -E ':(3000|2222)\$' | tr '\n' ' ' || true")
  [ -z "$busy" ] || die "port 3000 or 2222 is in use on $TARGET ($busy). Gitea needs both: stop what uses them, or use another host."
fi

say "Starting Gitea"
"${SSH[@]}" 'mkdir -p ~/gitea'
scp -q -o BatchMode=yes "$HERE/compose.yml" "$TARGET:gitea/docker-compose.yml"
"${SSH[@]}" "cd ~/gitea && echo GIT_HOST=$ADDR > .env && docker compose up -d --quiet-pull 2>&1 | tail -1"
for _ in $(seq 1 60); do
  v=$(curl -fsS "http://$ADDR:3000/api/v1/version" 2>/dev/null | jq -r .version 2>/dev/null || true)
  [ -n "$v" ] && break
  sleep 3
done
[ -n "${v:-}" ] || die "Gitea does not answer on http://$ADDR:3000 (on the host: cd ~/gitea && docker compose logs)"
ok "Gitea $v on http://$ADDR:3000"

cat <<EOF

Next, the account. In your own terminal, so the password is shown only to you:
  ssh $TARGET docker exec -u git gitea gitea admin user create --admin --username <you> --email <your email> --random-password
EOF
