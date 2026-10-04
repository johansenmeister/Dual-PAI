#!/usr/bin/env bash
# Øktstart: hent siste endringer fra Gitea før du jobber.
# Bruker --rebase --autostash så MEMORY-filer skrevet under forrige økt
# ikke gir merge-konflikt.
set -euo pipefail

# Repoet er katalogen over denne fila, uansett hva klonen heter på maskinen
# (`pai-opencode` på én maskin, `pai` på en annen). `PAI_REPO` overstyrer.
REPO="${PAI_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO"

echo "→ Pulling from Gitea ($(git rev-parse --abbrev-ref HEAD))..."
git pull --rebase --autostash
echo "✓ Updated to $(git log --oneline -1)"
