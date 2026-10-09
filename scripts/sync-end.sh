#!/usr/bin/env bash
# Øktslutt: commit alt og push til Gitea, så neste maskin er ajour.
# Valgfri melding: `pai-push "egen melding"` — ellers hostname + tid.
set -euo pipefail

# Repoet er katalogen over denne fila, uansett hva klonen heter på maskinen
# (`pai-opencode` på én maskin, `pai` på en annen). `PAI_REPO` overstyrer.
REPO="${PAI_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO"

# K16: `git add -A` tar med alt som ikke er ignorert, så én manglende linje i
# .gitignore sender en nøkkel til Gitea. Vakten ser på det som skal pushes:
# indeksen mot der vi forlot upstream, altså både det stagede og commits som
# ikke er pushet. Bare nye linjer teller, så et nøkkeleksempel som alt ligger
# i repoet, gir ikke en alarm i hver økt.
NOKKELBLOKK='-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----'
SKANNER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/Tools/SecretScan.ts"

pushbase() {
  local upstream
  if upstream=$(git rev-parse -q --verify '@{upstream}' 2>/dev/null) &&
    git merge-base HEAD "$upstream" 2>/dev/null; then
    return
  fi
  git rev-parse -q --verify HEAD 2>/dev/null ||
    git hash-object -t tree /dev/null # tomt tre: første commit
}

# Det som skal pushes, som `-U0`-diff med `b/`-prefiks uansett brukerens config.
nye_linjer() {
  git -c core.quotePath=false -c diff.noprefix=false -c diff.mnemonicPrefix=false diff --cached -U0 --no-color --no-ext-diff \
    --diff-filter=ACMR --dst-prefix=b/ "$1"
}

# Én linje per funn på stdout: `<sti>\t<grunn>`.
hemmeligheter() {
  local base sti navn
  base=$(pushbase)
  git diff --cached --name-only -z --diff-filter=ACMR "$base" |
    while IFS= read -r -d '' sti; do
      navn="${sti##*/}"
      case "$navn" in
      *.env.example | *.example.env | *.env.sample | *.sample.env) ;;
      *.pem) printf '%s\tkey file (*.pem)\n' "$sti" ;;
      *.env | *.env.*) printf '%s\tenvironment file (.env)\n' "$sti" ;;
      id_*.*) ;; # id_*.pub og andre med endelse: ikke en SSH-privatnøkkel
      id_*) printf '%s\tSSH key (id_*)\n' "$sti" ;;
      esac
    done
  # Nye linjer med en PEM- eller OpenSSH-blokk, uansett filnavn. `+++` er
  # filnavnet bare i hodet, før første `@@`; senere er det en innholdslinje.
  nye_linjer "$base" |
    awk -v blokk="$NOKKELBLOKK" '
      /^diff --git / { hode = 1; next }
      hode && /^\+\+\+ / { fil = substr($0, 7); next }
      /^@@/ { hode = 0; next }
      !hode && /^\+/ && $0 ~ blokk && !(fil in sett) {
        sett[fil] = 1; printf "%s\tprivate key in the content\n", fil
      }'
  # #370: tokens i nye linjer (`https://bruker:token@vert`, kjente verdier fra
  # .env, leverandørformer). Mønstrene er de samme som maskerer verktøyutdata
  # for modellen (`pai-core/lib/secrets.ts`), så de to driver ikke fra hverandre.
  # Skanneren hentes ved siden av skriptet, ikke fra repoet som synkes.
  # Mangler bun, eller feiler skanneren, sier den fra og pusher, som speilet:
  # filnavnene og nøkkelblokkene over er sjekket uansett.
  local tokens typer
  if ! command -v bun >/dev/null; then
    echo "⚠ Did not check the content for tokens: bun is not on PATH." >&2
  elif ! tokens=$(nye_linjer "$base" | bun "$SKANNER"); then
    echo "⚠ The token check failed, so the content was not checked for tokens. Run: git diff --cached -U0 | bun Tools/SecretScan.ts" >&2
  elif [ -n "$tokens" ]; then
    while IFS=$'\t' read -r sti typer; do
      printf '%s\ttoken in the content (%s)\n' "$sti" "$typer"
    done <<<"$tokens"
  fi
}

# K47: skills endres i produksjonsøkter, der ingen kjører testene. Et gammelt
# Claude-speil gjør `main` rød og gir de andre maskinene den gamle kroppen.
# Generatoren er deterministisk og idempotent, så den kjøres her (~0,3 s når
# speilet er ferskt). Feiler den, pushes resten likevel: synken er viktigere.
speil() {
  [ -f Tools/BuildClaudePlugin.ts ] || return 0
  if ! command -v bun >/dev/null; then
    echo "⚠ Did not check the Claude mirror: bun is not on PATH." >&2
    return 0
  fi
  # #402: the generator only links what git tracks, and `git add -A` comes
  # after this. A skill created in this session would be committed without its
  # links. Intent-to-add makes it tracked without staging content, and skips
  # what .gitignore excludes, as `git add -A` would.
  [ -d .opencode/skills ] && git add -N -- .opencode/skills 2>/dev/null
  bun Tools/BuildClaudePlugin.ts --sjekk >/dev/null 2>&1 && return 0
  if bun Tools/BuildClaudePlugin.ts >/dev/null 2>&1; then
    echo "↻ The Claude mirror was stale and has been regenerated."
  else
    echo "⚠ The Claude mirror is stale, and regenerating it failed. Run: bun Tools/BuildClaudePlugin.ts" >&2
  fi
}
speil

if [ -n "$(git status --porcelain)" ]; then
  git add -A
fi

funn=$(hemmeligheter)
if [ -n "$funn" ]; then
  # Git legger en tab etter en `+++`-sti med mellomrom; tab er IFS-blanktegn,
  # så `read` slår den sammen med skilletegnet.
  while IFS=$'\t' read -r sti grunn; do
    # Ut av indeksen igjen, så en manuell `git commit` ikke tar den med.
    git --literal-pathspecs reset -q -- "$sti" 2>/dev/null || true
    case "$grunn" in
    *"in the content"*) raad="Remove the value from the file." ;;
    *) raad="Add it to .gitignore, or remove it." ;;
    esac
    echo "✗ Not committing $sti: $grunn. $raad" >&2
  done <<<"$funn"
  echo "✗ Nothing was committed or pushed." >&2
  exit 1
fi

if git diff --cached --quiet; then
  echo "✓ Nothing to commit, the working tree is clean."
else
  msg="${1:-sync: $(hostname) $(date '+%Y-%m-%d %H:%M')}"
  git commit -q -m "$msg"
  echo "✓ Committed: $msg"
fi

# Push hvis vi ligger foran remote (også hvis en tidligere push feilet).
echo "→ Pushing to Gitea..."
git push
echo "✓ $(git log --oneline -1)"
