#!/usr/bin/env bash
# vm.sh — a Debian 13 VM with Docker on Proxmox, for Gitea (guide/gitea.md, Part 1).
#
# Usage, from the PAI folder:
#   bash guide/gitea/vm.sh --node pve --vmid 600 --name gitea --pool pai-lab \
#     --disk-storage local-lvm --import-storage local --bridge vmbr0
# Optional:
#   --ip 192.168.1.20/24 --gw 192.168.1.1   a fixed address instead of DHCP
#   --memory 2048 --disk 10G --key ~/.ssh/id_ed25519.pub
#
# It checks the token first (pve_check), downloads Debian's cloud image if the
# import storage does not have it (checked against Debian's checksum), creates
# and starts the VM with cloud-init (user "pai", your SSH key), finds its
# address, waits for SSH, and installs Docker. The last line is ADDRESS=<ip>.
# The token is read from ~/.opencode/.env (PVE_ENV overrides) and never shown.
set -euo pipefail

NODE="" VMID="" NAME="" POOL="" DISK_ST="" IMPORT_ST="" BRIDGE="" IP="" GW=""
MEMORY=2048 DISK=10G KEY="$HOME/.ssh/id_ed25519.pub"
while [ $# -gt 0 ]; do
  case $1 in
    --node) NODE=$2; shift 2 ;;
    --vmid) VMID=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    --pool) POOL=$2; shift 2 ;;
    --disk-storage) DISK_ST=$2; shift 2 ;;
    --import-storage) IMPORT_ST=$2; shift 2 ;;
    --bridge) BRIDGE=$2; shift 2 ;;
    --ip) IP=$2; shift 2 ;;
    --gw) GW=$2; shift 2 ;;
    --memory) MEMORY=$2; shift 2 ;;
    --disk) DISK=$2; shift 2 ;;
    --key) KEY=$2; shift 2 ;;
    -h | --help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
die() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

for pair in NODE:node VMID:vmid NAME:name POOL:pool DISK_ST:disk-storage IMPORT_ST:import-storage BRIDGE:bridge; do
  v=${pair%%:*}
  [ -n "${!v}" ] || die "missing --${pair#*:} (see --help)"
done
case $VMID in *[!0-9]* | "") die "--vmid must be a number: $VMID" ;; esac
[ -z "$IP" ] || [ -n "$GW" ] || die "--ip needs --gw"
[ -f "$KEY" ] || die "no SSH key at $KEY. Make one with: ssh-keygen -t ed25519 -f ${KEY%.pub} -N \"\""
for c in curl jq ssh; do command -v "$c" >/dev/null || die "$c is missing"; done

# shellcheck source=pve.sh
. "$(dirname "$0")/pve.sh"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -i "${KEY%.pub}")

say "Checking the Proxmox token"
pve_check "$NODE" "$POOL" "$DISK_ST" "$IMPORT_ST" "$BRIDGE" || die "the token cannot do all of this yet; guide/gitea.md, \"Before you start: the token\", says how"

# A VM with this id and name is one an earlier run made: carry on from there,
# so a run that stopped half-way can simply be run again.
EXISTS=0
if pve GET "nodes/$NODE/qemu/$VMID/status/current" | jq -e .data >/dev/null 2>&1; then
  [ "$(pve GET "nodes/$NODE/qemu/$VMID/config" | jq -r .data.name)" = "$NAME" ] ||
    die "VM $VMID already exists, with another name. Choose another --vmid."
  EXISTS=1
fi

IMG=debian-13-genericcloud-amd64.qcow2
BASE=https://cloud.debian.org/images/cloud/trixie/latest
if [ $EXISTS = 1 ]; then
  ok "VM $VMID ($NAME) exists from an earlier run; going on with it"
elif pve GET "nodes/$NODE/storage/$IMPORT_ST/content?content=import" | jq -e --arg v "$IMPORT_ST:import/$IMG" '.data[] | select(.volid == $v)' >/dev/null; then
  ok "the image is already in $IMPORT_ST"
else
  say "Downloading Debian's cloud image to $IMPORT_ST (about 330 MB)"
  sum=$(curl -fsSL "$BASE/SHA512SUMS" | awk -v f="$IMG" '$2 == f {print $1}')
  [ -n "$sum" ] || die "could not read Debian's checksum list"
  upid=$(pve POST "nodes/$NODE/storage/$IMPORT_ST/download-url" --data-urlencode content=import \
    --data-urlencode "filename=$IMG" --data-urlencode "url=$BASE/$IMG" \
    --data-urlencode checksum-algorithm=sha512 --data-urlencode "checksum=$sum" | jq -r '.data // empty')
  [ -n "$upid" ] || die "Proxmox did not start the download"
  [ "$(pve_wait "$upid")" = OK ] || die "the download failed (see the task log in Proxmox)"
  ok "downloaded and checked"
fi

if [ $EXISTS = 0 ]; then
  say "Creating VM $VMID ($NAME)"
  ipconfig="ip=dhcp"
  [ -z "$IP" ] || ipconfig="ip=$IP,gw=$GW"
  # Proxmox wants sshkeys URL-encoded once more than the form itself.
  keyenc=$(jq -rn --arg k "$(cat "$KEY")" '$k|@uri')
  res=$(pve POST "nodes/$NODE/qemu" --data-urlencode "vmid=$VMID" --data-urlencode "name=$NAME" \
    --data-urlencode "pool=$POOL" --data-urlencode "memory=$MEMORY" --data-urlencode cores=2 \
    --data-urlencode cpu=host --data-urlencode ostype=l26 --data-urlencode scsihw=virtio-scsi-single \
    --data-urlencode "scsi0=$DISK_ST:0,import-from=$IMPORT_ST:import/$IMG,discard=on,iothread=1" \
    --data-urlencode "ide2=$DISK_ST:cloudinit" --data-urlencode boot=order=scsi0 \
    --data-urlencode serial0=socket --data-urlencode vga=serial0 --data-urlencode agent=enabled=1 \
    --data-urlencode "net0=virtio,bridge=$BRIDGE" --data-urlencode ciuser=pai \
    --data-urlencode "sshkeys=$keyenc" --data-urlencode "ipconfig0=$ipconfig")
  upid=$(jq -r '.data // empty' <<<"$res")
  [ -n "$upid" ] || die "Proxmox refused: $(jq -r '.message // .' <<<"$res")"
  [ "$(pve_wait "$upid")" = OK ] || die "creating the VM failed (see the task log in Proxmox)"
  pve_wait "$(pve PUT "nodes/$NODE/qemu/$VMID/resize" --data-urlencode disk=scsi0 --data-urlencode "size=$DISK" | jq -r .data)" >/dev/null
  pve_wait "$(pve POST "nodes/$NODE/qemu/$VMID/status/start" | jq -r .data)" >/dev/null
  ok "created and started"
else
  [ "$(pve GET "nodes/$NODE/qemu/$VMID/status/current" | jq -r .data.status)" = running ] ||
    pve_wait "$(pve POST "nodes/$NODE/qemu/$VMID/status/start" | jq -r .data)" >/dev/null
fi

say "Finding its address"
ADDR=${IP%/*}
if [ -z "$IP" ]; then
  mac=$(pve GET "nodes/$NODE/qemu/$VMID/config" | jq -r '.data.net0' | sed -n 's/.*virtio=\([0-9A-Fa-f:]*\).*/\1/p' | tr 'A-F' 'a-f')
  for _ in $(seq 1 36); do
    sleep 5
    ADDR=$(getent ahostsv4 "$NAME" 2>/dev/null | awk 'NR==1 {print $1}' || true)
    [ -n "$ADDR" ] && ssh "${SSH_OPTS[@]}" "pai@$ADDR" true 2>/dev/null && break
    ADDR=$(ip neigh 2>/dev/null | awk -v m="$mac" 'tolower($5) == m && $1 ~ /^[0-9.]+$/ {print $1; exit}')
    [ -n "$ADDR" ] && break
  done
  if [ -z "$ADDR" ] && command -v ip >/dev/null; then
    # Not in DNS: ping the local network once, so its ARP table learns the MAC.
    net=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | cut -d. -f1-3)
    if [ -n "$net" ]; then
      for i in $(seq 1 254); do ping -c1 -W1 "$net.$i" >/dev/null 2>&1 & done
      wait
      ADDR=$(ip neigh | awk -v m="$mac" 'tolower($5) == m && $1 ~ /^[0-9.]+$/ {print $1; exit}')
    fi
  fi
  [ -n "$ADDR" ] || die "could not find the VM's address (MAC $mac). Look it up in your router, then run guide/gitea/deploy.sh with it."
fi
ok "$ADDR"
# A VM made just now has a new host key. An old key for the same address (an
# earlier VM that got it from DHCP) would stop SSH, so it goes.
[ $EXISTS = 1 ] || ssh-keygen -R "$ADDR" >/dev/null 2>&1 || true

say "Waiting for SSH"
for _ in $(seq 1 30); do ssh "${SSH_OPTS[@]}" "pai@$ADDR" true 2>/dev/null && break; sleep 4; done
ssh "${SSH_OPTS[@]}" "pai@$ADDR" true || die "pai@$ADDR does not answer on SSH"
# The right machine: cloud-init names it after the VM. A stale DNS answer could
# point to another machine that also has user pai and this key.
[ "$(ssh "${SSH_OPTS[@]}" "pai@$ADDR" hostname)" = "$NAME" ] ||
  die "$ADDR answers, but it is not $NAME. Find the VM's address in your router and run guide/gitea/deploy.sh with it."
ok "pai@$ADDR"

say "Installing Docker (Debian's own packages)"
# cloud-init runs apt itself at the first boot, and holds its lock until done.
ssh "${SSH_OPTS[@]}" "pai@$ADDR" 'cloud-init status --wait >/dev/null 2>&1 || true'
ssh "${SSH_OPTS[@]}" "pai@$ADDR" 'sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose qemu-guest-agent >/dev/null && sudo usermod -aG docker pai' ||
  die "installing Docker failed"
ok "$(ssh "${SSH_OPTS[@]}" "pai@$ADDR" 'docker --version')"

echo "ADDRESS=$ADDR"
