# PAI-OpenCode alias — source denne fra skallets profil (~/.bashrc, ~/.zshrc, ~/.profile):
#   _PAI_SKRIPT="$HOME/repos/<klonen>/scripts"; . "$_PAI_SKRIPT/aliases.sh"
#
# Ligger i repoet så aliasene synkes til alle maskiner. Legg kun én
# source-linje i det maskin-lokale rc-fila. Skriptene ligger ved siden av
# denne fila, så klonen kan hete hva som helst (K48). `_PAI_SKRIPT` settes av
# den som henter fila (`guide/gitea/sync.sh` skriver linja slik); ellers
# regnes den ut: bash har `BASH_SOURCE`, og `$0` er zsh sin sti når fila
# sources. dash har ingen av delene, og ingen funksjonsnavn med bindestrek,
# så fila er POSIX og alle tre er alias (#232). fish henter den ikke; der
# skriver sync.sh aliasene selv.
if [ -z "${_PAI_SKRIPT:-}" ]; then
  if [ -n "${BASH_VERSION:-}" ]; then
    eval '_PAI_SKRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"'
  else
    _PAI_SKRIPT="$(cd "$(dirname "$0")" && pwd)"
  fi
fi

# Øktstart: pull (rebase+autostash), så start PAI. Argumentene går til pai.
alias pai-start='bash "$_PAI_SKRIPT/sync-start.sh" && pai'

# Bare synk ned uten å starte PAI.
alias pai-pull='bash "$_PAI_SKRIPT/sync-start.sh"'

# Øktslutt: commit alt + push. Valgfri melding: pai-push "melding".
alias pai-push='bash "$_PAI_SKRIPT/sync-end.sh"'
