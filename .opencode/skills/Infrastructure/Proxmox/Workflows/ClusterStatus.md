# ClusterStatus Workflow

Heltssjekk av Proxmox cluster: quorum, node-helse, ressurser med advarsler.

Load context: `SkillSearch('proxmox api')`

## Steps

1. **Authenticate:** Les `PROXMOX_API_URL`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET` fra `~/.opencode/.env`. Bygg auth-header.

2. **Cluster status:**
```bash
curl -sk -H "$AUTH" "$BASE/cluster/status"
```
Sjekk: `quorate=1`, alle noder `online=1`.

3. **Node status:**
```bash
curl -sk -H "$AUTH" "$BASE/nodes"
```
Hent per-node: oppetid, CPU-bruk (i forhold til maxcpu), RAM-bruk (mem/maxmem).

4. **Ressursoversikt:**
```bash
curl -sk -H "$AUTH" "$BASE/cluster/resources" | python3 -c "
import sys, json
data = json.load(sys.stdin)['data']
vms = [r for r in data if r['type'] == 'qemu']
lxcs = [r for r in data if r['type'] == 'lxc']
print(f'QEMU: {len(vms)} ({sum(1 for v in vms if v[\"status\"]==\"running\")} running, {sum(1 for v in vms if v[\"status\"]==\"stopped\")} stopped)')
print(f'LXC:  {len(lxcs)} ({sum(1 for l in lxcs if l[\"status\"]==\"running\")} running, {sum(1 for l in lxcs if l[\"status\"]==\"stopped\")} stopped)')
"
```
Se `proxmox-cluster-komplett.md` for full oversikt.

5. **Rapportér strukturert:**
   - **Cluster:** quorum OK/IKKE OK, antall noder, eventuelle offline
   - **Noder:** tabell med node, CPU%, RAM (brukt/total), oppetid
   - **VM-er:** antall kjørende/stoppede per type
   - **Advarsler:** node CPU > 80%, node RAM > 90%, VM stopped (hvis uventet)
   - **Siste tasks:** Vis siste 3 failed tasks hvis noen

6. **Ved avvik:** Marker tydelig hva som er galt og foreslå sjekk. Spør før eventuelle korrigerende tiltak.
