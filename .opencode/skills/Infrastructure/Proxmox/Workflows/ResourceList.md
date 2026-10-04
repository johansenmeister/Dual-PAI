# ResourceList Workflow

List VM-er og LXC-containere med status, ressursbruk og node-plassering.

Load context: `SkillSearch('proxmox api')`

## Steps

1. **Authenticate:** Les credentials fra `.env`, bygg auth-header.

2. **Hent alle ressurser:**
```bash
curl -sk -H "$AUTH" "$BASE/cluster/resources?type=vm" | python3 -c "
import sys, json
data = json.load(sys.stdin)['data']
# Filter and format
for r in sorted(data, key=lambda x: (x['node'], -x.get('vmid', 0))):
    if r['type'] not in ('qemu', 'lxc'):
        continue
    mem_gb = r.get('mem', 0) / 1073741824
    maxmem_gb = r.get('maxmem', 0) / 1073741824
    disk_gb = r.get('disk', 0) / 1073741824
    maxdisk_gb = r.get('maxdisk', 0) / 1073741824
    cpu_pct = r.get('cpu', 0) * 100
    uptime_h = r.get('uptime', 0) / 3600
    print(f'{r[\"type\"].upper():4} {r[\"vmid\"]:>4} {r[\"status\"]:8} {r[\"node\"]:8} {r[\"name\"]:<20} CPU:{cpu_pct:5.1f}% RAM:{mem_gb:.1f}/{maxmem_gb:.1f}GB Uptime:{uptime_h:.0f}h')
"
```

3. **Alternativt — per node (hvis bruker spør om spesifikk node):**
```bash
# QEMU på pve
curl -sk -H "$AUTH" "$BASE/nodes/pve/qemu"

# LXC på pve
curl -sk -H "$AUTH" "$BASE/nodes/pve/lxc"
```

4. **Rapportér:**
   - **Kjørende VM-er (QEMU):** tabell med vmid, navn, node, CPU%, RAM, oppetid
   - **Stoppede VM-er:** egen seksjon — marker om noen burde vært kjørende
   - **Kjørende LXC:** tabell med vmid, navn, node, CPU%, RAM, oppetid
   - **Stoppede LXC:** egen seksjon
   - **Tags:** vis hvis nyttig for kontekst (community-script, backup, etc.)
   - **Filter:** støtt spørsmål som "bare kjørende", "bare på pve", "VM-er med backup-tag"

5. **Output-format:** Tabell på norsk, konverter bytes til GB (1 desimal), oppetid i timer/dager.
