# Felles for sync-start.sh og sync-end.sh, hentes med `.` (#496).
# Synken skal aldri jobbe videre på et repo der en rebase, merge eller
# cherry-pick står halvferdig, der HEAD ikke er på en gren, eller der filer har
# uløste konflikter. Da gjorde `git add -A` i sync-end.sh konfliktene til
# «løst», og konfliktmarkørene ble committet og pushet til main.

# Filene med uløste konflikter, én per linje.
uloste() {
  git -c core.quotePath=false diff --name-only --diff-filter=U
}

# Taus og 0 når repoet er i orden; ellers grunnen på stderr og 1.
repo_i_orden() {
  local hva="" filer sti
  if [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; then
    hva="A rebase is not finished"
  elif git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    hva="A merge is not finished"
  elif git rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null; then
    hva="A cherry-pick is not finished"
  elif ! git symbolic-ref -q HEAD >/dev/null; then
    hva="HEAD is not on a branch"
  fi
  filer=$(uloste)
  [ -z "$hva" ] && [ -z "$filer" ] && return 0
  [ -n "$hva" ] && echo "✗ $hva in $(pwd)." >&2
  if [ -n "$filer" ]; then
    echo "✗ Unresolved conflicts in:" >&2
    while IFS= read -r sti; do echo "    $sti" >&2; done <<<"$filer"
  fi
  echo "  Fix it by hand (git status says how). The sync does not touch the repo until that is done." >&2
  return 1
}
