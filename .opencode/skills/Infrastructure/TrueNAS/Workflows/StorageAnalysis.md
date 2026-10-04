# StorageAnalysis Workflow

Dypanalyse av TrueNAS lagring: pools, disker, datasets, SMART-status, snapshots, replikering.

Load context: `SkillSearch('truenas api')`

**Script:** `Scripts/trueNasApi.ts` — ALL datainnhenting går via dette. Modellen gjør aldri egne WebSocket-kall mot TrueNAS.

## Steps

1. **Credentials:** Verifiser at `TRUENAS_API_KEY` er satt i `~/.opencode/.env`.

2. **Kjør lagringsanalyse via script:**
```bash
bun ~/.config/opencode/skills/Infrastructure/TrueNAS/Scripts/trueNasApi.ts --pretty \
  pool.query disk.query pool.dataset.query disk.temperatures \
  pool.scrub.query pool.snapshottask.query replication.query
```

3. **Presenter strukturert rapport:**

Hent ut nøkkeldata fra JSON-responsen og presenter:

```
💾 TRUE NAS STORAGE ANALYSIS — <vertsnavn>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏊 POOLS
  Fra pool.query: navn, status, healthy, size/allocated/free (konverter bytes til TiB/GiB)
  VDEV-topologi per pool: type (RAIDZ1/mirror/stripe), disker, status
  
  Eksempel:
  pool: bottomvolume (RAIDZ1, 4×disk, ONLINE)
    Total: 7.3 TiB | Brukt: 68% (5.0 TiB) | Ledig: 2.3 TiB
    Siste scrub: 2026-07-27 — FINISHED, 0 errors
  
  pool: Apps (single disk, ONLINE)
    Total: 31.5 GiB | Brukt: 4% (1.4 GiB) | Ledig: 30 GiB
  
  pool: basseng_nede (RAIDZ1, 4×disk, ONLINE)
    Total: 14.6 TiB | Brukt: 35% (5.0 TiB) | Ledig: 9.5 TiB

🖴 DISKER
  Fra disk.query: name, model, serial, size (konverter til TiB/GB)
  Fra disk.temperatures: temp per disk
  
  Tabell:
  ┌──────┬─────────────┬────────┬──────────┬───────┐
  │ Disk │ Modell      │ Strl   │ Temp     │ Pool  │
  ├──────┼─────────────┼────────┼──────────┼───────┤
  │ sdc  │ ...         │ XX TB  │ XX°C     │ bv    │
  └──────┴─────────────┴────────┴──────────┴───────┘
  
  🌡️  Temperaturoversikt: min/max/avg, advarsler for > 45°C

📁 DATASETS (topp 15 etter bruk — sortert descending på used)
  Fra pool.dataset.query: name, type, used, available
  type=FILESYSTEM er datasett du bryr deg om
  type=VOLUME er zvols
  
  ┌──────────────────────┬────────┬──────────┬──────────┐
  │ Dataset              │ Type   │ Brukt    │ Ledig    │
  ├──────────────────────┼────────┼──────────┼──────────┤
  │ bottomvolume/media   │ FS     │ XX TiB   │ XX TiB   │
  └──────────────────────┴────────┴──────────┴──────────┘

📸 SNAPSHOTS
  Fra pool.snapshottask.query: hvilke tasks, intervaller, retention

🔄 REPLIKERING
  Fra replication.query: navn, kilde, destinasjon, state, siste kjøring

🧹 SCRUB
  Fra pool.scrub.query: siste scrub per pool, errors
```

4. **Ved avvik — tydelige advarsler:**
   - Pool DEGRADED/OFFLINE → Vis hvilke disker er nede, foreslå SMART-sjekk
   - Disk > 80% full → ⚠️ Anbefal opprydding eller utvidelse
   - Disk temp > 45°C → 🌡️ Kjøleproblem — sjekk vifter
   - Siste scrub > 14 dager → Anbefal å kjøre scrub manuelt
   - Scrub errors > 0 → ⚠️ Potensiell datakorrupsjon — kjør `zpool status -v`
   - Replikering/sync state != "FINISHED" → Sjekk feilmelding
   - Ingen snapshots → Anbefal å sette opp periodisk snapshot

5. **Spør:** Vil du ha SMART-detaljer for spesifikke disker, eller full dataset-liste?
