#!/usr/bin/env bash

# diskvarsel.sh — varsler hvis rot-partisjonen er over angitt grense
#
# Bruk:   ./scripts/diskvarsel.sh [terskel]
# Eks:    ./scripts/diskvarsel.sh 80   (standard: 80 %)

set -euo pipefail

readonly THRESHOLD="${1:-80}"
readonly MOUNTPOINT="/"
readonly HOSTNAME="$(hostname)"

# --- Sjekk at df finnes -------------------------------------------------------
if ! command -v df &>/dev/null; then
    echo "❌ diskvarsel: 'df' er ikke tilgjengelig. Avbryter."
    exit 2
fi

# --- Hent rot-partisjonens bruksprosent ---------------------------------------
DF_OUTPUT="$(df -P "${MOUNTPOINT}" 2>/dev/null)" || {
    echo "❌ diskvarsel: klarte ikke å lese diskbruk for '${MOUNTPOINT}'."
    exit 2
}

# df -P gir: Filesystem 1024-blocks Used Available Capacity Mounted on
# Fjerde felt (Capacity) er prosentandelen uten %-tegn.
USAGE_PCT="$(tail -1 <<<"${DF_OUTPUT}" | tr -s ' ' | cut -d' ' -f5 | tr -d '%')"
PARTITION="$(tail -1 <<<"${DF_OUTPUT}" | tr -s ' ' | cut -d' ' -f1)"

[[ "${USAGE_PCT}" =~ ^[0-9]+$ ]] || {
    echo "❌ diskvarsel: uventet format fra 'df'. Fikk: '${USAGE_PCT}'"
    exit 2
}

readonly USAGE_PCT
readonly PARTITION

# --- Varsle dersom bruken er over terskel -------------------------------------
if (( USAGE_PCT > THRESHOLD )); then
    echo "⚠️  DISKVARSEL [${HOSTNAME}]: ${PARTITION} (${MOUNTPOINT}) er ${USAGE_PCT} % full!"
    echo "   Terskel: ${THRESHOLD} % — frigjør plass umiddelbart."
    echo ""
    echo "   Tips:"
    echo "     du -sh /* | sort -hr | head -10   # finn store mapper"
    echo "     journalctl --disk-usage             # sjekk loggstørrelse"
    echo "     docker system prune -a              # fjern ubrukte Docker-data"
    exit 1
fi

exit 0
