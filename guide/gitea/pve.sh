# pve.sh — Proxmox API helpers for guide/gitea.md. Load with:
#   . guide/gitea/pve.sh
#
#   pve <METHOD> <path> [curl arguments …]   one API call, JSON on stdout
#   pve_wait <UPID>                          waits for a task, prints its exit status ("OK")
#   pve_check <node> <pool> <disk storage> <import storage> <bridge>
#                                            the token has what Part 1 needs, or what is missing
#
# The token comes from ~/.opencode/.env and goes to curl through a file
# descriptor: never on the command line, never on the screen.
# PROXMOX_API_URL may be written with or without /api2/json.
# PVE_ENV overrides the file (for tests).

pve() {
  local env=${PVE_ENV:-$HOME/.opencode/.env} method=$1 path=$2 url
  shift 2
  url=$(sed -n 's/^PROXMOX_API_URL=//p' "$env")
  url=${url%/}
  url=${url%/api2/json}
  curl -sk -X "$method" -K <(printf 'header = "Authorization: PVEAPIToken=%s=%s"\n' \
    "$(sed -n 's/^PROXMOX_TOKEN_ID=//p' "$env")" "$(sed -n 's/^PROXMOX_TOKEN_SECRET=//p' "$env")") \
    "$url/api2/json/$path" "$@"
}

pve_wait() {
  local node upid status
  upid=$1
  node=$(printf '%s' "$upid" | cut -d: -f2)
  upid=$(jq -rn --arg u "$upid" '$u|@uri')
  while :; do
    status=$(pve GET "nodes/$node/tasks/$upid/status" | jq -r '.data.status + " " + (.data.exitstatus // "")')
    case $status in stopped*) echo "${status#stopped }"; return ;; esac
    sleep 3
  done
}

# pve_check <node> <pool> <disk storage> <import storage> <bridge>
# Checks that the token can do every step of guide/gitea.md, Part 1. One line
# per item, ✓ or ✗ with what is missing; exit status 1 if anything is.
pve_check() {
  local node=$1 pool=$2 disk=$3 import=$4 bridge=$5 bad=0 path want have miss storages
  if ! pve GET version | jq -e .data.version >/dev/null 2>&1; then
    echo "✗ the API does not answer with this token: check PROXMOX_API_URL, PROXMOX_TOKEN_ID and PROXMOX_TOKEN_SECRET"
    return 1
  fi
  while IFS='|' read -r path want; do
    have=$(pve GET "access/permissions?path=$(jq -rn --arg p "$path" '$p|@uri')" | jq -r --arg p "$path" '.data[$p] // {} | keys | join(" ")')
    miss=""
    for p in $want; do case " $have " in *" $p "*) ;; *) miss="$miss $p" ;; esac; done
    if [ -n "$miss" ]; then echo "✗ $path is missing:$miss"; bad=1; else echo "✓ $path"; fi
  done <<LIST
/pool/$pool|VM.Allocate VM.PowerMgmt VM.Config.CDROM VM.Config.CPU VM.Config.Cloudinit VM.Config.Disk VM.Config.HWType VM.Config.Memory VM.Config.Network VM.Config.Options Datastore.AllocateSpace
/storage/$disk|Datastore.AllocateSpace
/storage/$import|Datastore.AllocateTemplate
/sdn/zones/localnetwork/$bridge|SDN.Use
/nodes/$node|Sys.AccessNetwork
LIST
  storages=$(pve GET "nodes/$node/storage")
  if jq -e --arg s "$import" '.data[] | select(.storage == $s) | .content | split(",") | index("import")' <<<"$storages" >/dev/null; then
    echo "✓ $import can hold the cloud image (content: import)"
  else
    echo "✗ $import cannot hold the cloud image: add Import to its Content (Datacenter, Storage)"; bad=1
  fi
  if jq -e --arg s "$disk" '.data[] | select(.storage == $s) | .content | split(",") | index("images")' <<<"$storages" >/dev/null; then
    echo "✓ $disk can hold VM disks"
  else
    echo "✗ $disk cannot hold VM disks (content: images), or the token cannot see it"; bad=1
  fi
  return $bad
}
