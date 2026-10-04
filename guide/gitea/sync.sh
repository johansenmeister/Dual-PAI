#!/usr/bin/env bash
# sync.sh — this PAI copy kept on your Gitea and synced (guide/gitea.md, Part 2).
#
# Usage, from the PAI folder, after pai-setup.sh:
#   bash guide/gitea/sync.sh ssh://git@<address>:2222/<org>/pai.git
#
# The remotes become as in PAI's own setup: origin is your Gitea (pai-pull and
# pai-push sync with it), upstream is where PAI was cloned from (updates). It
# pushes main, adds one line to your shell profile that gives you pai-pull,
# pai-push and pai-start, and checks that a pull works. Running it again changes
# nothing that is already in place. Ask the user before running it: their
# identity, lab and memory go to that repository.
set -euo pipefail

URL=${1:-}
case $URL in ssh://* | git@*:*) ;; -h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; *) echo "Usage: bash guide/gitea/sync.sh ssh://git@<address>:2222/<org>/pai.git" >&2; exit 1 ;; esac

say() { printf '==> %s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
die() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

REPO=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "switch to the main branch first (git switch main)"

say "The remotes"
origin=$(git remote get-url origin 2>/dev/null || true)
if [ "$origin" = "$URL" ]; then
  ok "origin is already $URL"
else
  if [ -n "$origin" ]; then
    git remote get-url upstream >/dev/null 2>&1 && die "both origin ($origin) and upstream exist. Sort them out by hand: origin should be $URL."
    git remote rename origin upstream
    ok "upstream: $origin (PAI's updates)"
  fi
  git remote add origin "$URL"
  ok "origin: $URL (your Gitea)"
fi

say "Pushing main"
GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o StrictHostKeyChecking=accept-new" git push -q -u origin main ||
  die "the push failed. Is this machine's key on your Gitea account (pai-setup.sh adds it)?"
ok "main is on Gitea, and tracks origin/main"

say "pai-pull, pai-push and pai-start"
# The same profile the installer put the pai command in: $SHELL, else the
# account's login shell; sh and dash get ~/.profile, fish its own syntax.
{ read -r rc; read -r shell; } < <(bun "$REPO/PAI-Install/cli/shell-setup.ts" --profile) ||
  die "could not tell which shell profile to use (bun PAI-Install/cli/shell-setup.ts --profile)"
if grep -qF "$REPO/scripts" "$rc" 2>/dev/null; then
  ok "already in $rc"
else
  mkdir -p "$(dirname "$rc")"
  if [ "$shell" = fish ]; then
    printf '\n# PAI sync: pai-pull, pai-push, pai-start\nalias pai-pull \x27bash "%s/scripts/sync-start.sh"\x27\nalias pai-push \x27bash "%s/scripts/sync-end.sh"\x27\nalias pai-start \x27bash "%s/scripts/sync-start.sh"; and pai\x27\n' \
      "$REPO" "$REPO" "$REPO" >>"$rc"
  else
    printf '\n# PAI sync: pai-pull, pai-push, pai-start\n_PAI_SKRIPT="%s/scripts"; . "$_PAI_SKRIPT/aliases.sh"\n' "$REPO" >>"$rc"
  fi
  ok "added to $rc"
fi
login_shell=$(command -v "$shell" || echo "/bin/$shell")
t=""; command -v timeout >/dev/null && t="timeout 20"
if $t "$login_shell" -lic 'type pai-pull' </dev/null >/dev/null 2>&1; then
  ok "a new $shell login shell has them"
else
  printf '  ! a new %s login shell does not find pai-pull; the lines are in %s\n' "$login_shell" "$rc"
fi

say "A pull from Gitea"
bash "$REPO/scripts/sync-start.sh" >/dev/null && ok "pai-pull works"

cat <<EOF

From now on: pai-pull before a session, pai-push after it. PAI's updates:
  git pull --no-rebase --no-edit upstream main && pai-push
EOF
