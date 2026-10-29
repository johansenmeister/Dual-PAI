#!/usr/bin/env bash
# Øktstart: hent siste endringer fra Gitea før du jobber.
# Bruker --rebase --autostash så MEMORY-filer skrevet under forrige økt
# ikke gir merge-konflikt.
set -euo pipefail

# Repoet er katalogen over denne fila, uansett hva klonen heter på maskinen
# (`pai-opencode` på én maskin, `pai` på en annen). `PAI_REPO` overstyrer.
REPO="${PAI_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
. "$(dirname "${BASH_SOURCE[0]}")/sync-vakt.sh"
cd "$REPO"

repo_i_orden || exit 1

echo "→ Pulling from Gitea ($(git rev-parse --abbrev-ref HEAD))..."
if ! git pull --rebase --autostash; then
  # En konflikt i rebasen lar den stå halvferdig: si hvilke filer det gjelder.
  repo_i_orden || true
  exit 1
fi
# #496: går ikke autostashen inn igjen, avslutter `git pull` likevel med 0, og
# filene står igjen med konfliktmarkører.
if ! repo_i_orden; then
  echo "  The local changes are also in the stash (git stash list)." >&2
  exit 1
fi
echo "✓ Updated to $(git log --oneline -1)"
