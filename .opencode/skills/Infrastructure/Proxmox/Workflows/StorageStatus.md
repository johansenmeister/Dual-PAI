# StorageStatus Workflow

Sjekk storage pools på Proxmox: type, bruk, ledig plass, advarsler ved høy bruk.

Load context: `SkillSearch('proxmox api')`

## Steps

1. **Authenticate:** Les credentials fra `.env`, bygg auth-header.

2. **Hent storage-oversikt:**
```bash
curl -sk -H "$AUTH" "$BASE/storage"
```
Dette gir storage-definisjoner (type, nodes, content).

3. **Hent storage-status per node:**
```bash
# Per node — gir faktisk diskbruk; nodenavnene fra GET /nodes
curl -sk -H "$AUTH" "$BASE/nodes/<node>/storage"
```

4. **Alternativt — bruk cluster/resources med storage-filter:**
```bash
curl -sk -H "$AUTH" "$BASE/cluster/resources?type=storage" | python3 -c "
import sys, json
data = json.load(sys.stdin)['data']
for s in data:
    total_gb = s.get('maxdisk', 0) / 1073741824
    used_gb = s.get('disk', 0) / 1073741824
    pct = (used_gb / total_gb * 100) if total_gb > 0 else 0
    print(f'{s[\"node\"]:8}/{s[\"storage\"]:<20} {s[\"plugintype\"]:8} {used_gb:7.1f}/{total_gb:7.1f}GB {pct:5.1f}% {\"⚠️\" if pct > 80 else \"✅\"} ')
"
```

5. **Rapportér:**
   - **Tabell:** storage-navn, type (zfspool/nfs/lvmthin/dir/pbs), node, brukt/total GB, prosent
   - **Advarsler:** pools > 80% full — marker tydelig
   - **Kritiske:** pools > 90% full — varsle alvorlig
   - **Delte vs lokale:** marker `shared=1` — disse vises på flere noder men er samme fysiske storage

6. **Kontekst:** Vis hvilke content-typer hver pool støtter (images, rootdir, backup, iso, vztmpl) — nyttig når noen spør "hvor kan jeg laste opp ISO?"

7. **Formatter:** Tabell med fornuftige kolonnebredder, GB med 1 desimal, prosent med 1 desimal, marker advarsler med ⚠️.
