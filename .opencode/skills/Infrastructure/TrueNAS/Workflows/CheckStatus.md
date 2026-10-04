# CheckStatus Workflow

Heltssjekk av TrueNAS: systeminfo, pools, disk-helse, nettverk, varsler, og tjenester.

Load context: `SkillSearch('truenas api')`

**Script:** `Scripts/trueNasApi.ts` — ALL datainnhenting går via dette. Modellen gjør aldri egne WebSocket-kall mot TrueNAS.

## Steps

1. **Credentials:** Verifiser at `TRUENAS_API_KEY` er satt i `~/.opencode/.env`.

2. **Kjør helsesjekk via script:**
```bash
bun ~/.config/opencode/skills/Infrastructure/TrueNAS/Scripts/trueNasApi.ts \
  system.info pool.query alert.list service.query disk.temperature_agg \
  network.general.summary smb.status alert.list_categories
```
Bruk `--pretty` for lesbar output, `--compact` (default) for maskinlesbar JSON.

3. **Presenter strukturert rapport:**

```
📊 TRUE NAS STATUS — <vertsnavn> (<IP>)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🖥️  SYSTEM
  Version:      25.04.2.6 (Fangtooth)
  Hostname:     <vertsnavn>
  Uptime:       X days, HH:MM
  CPU:          [modell], [kjerner] cores
  Load:         [1m] / [5m] / [15m]
  System:       [product] ([manufacturer])

💾 POOLS
┌────────────────┬─────────┬────────┬──────────┐
│ Pool           │ Status  │ Used % │ Free     │
├────────────────┼─────────┼────────┼──────────┤
│ bottomvolume   │ ONLINE  │  68%   │ 2.3 TiB  │
│ Apps           │ ONLINE  │   4%   │ 30 GiB   │
│ basseng_nede   │ ONLINE  │  35%   │ 9.5 TiB  │
└────────────────┴─────────┴────────┴──────────┘

  Siste scrub: [dato] | VDEV-topologi: [mirror/raidz/...]

🌡️  DISK TEMPS
  Min: XX°C | Max: XX°C | Avg: XX°C
  ⚠️  Advarsler for disker > 45°C

🔔 ALERTS
  CRITICAL: N | WARNING: N | INFO: N
  [Liste over kritiske og advarsler — kun udismissed]

🔌 SERVICES
  Kjørende:    [antall] av [total]
  Stopped:     [liste hvis uventet stopped]

🌐 NETWORK
  Default route: [gateway]
  Nameservers:   [liste]

📂 SMB
  Aktive tilkoblinger: [antall]
```

4. **Ved avvik — tydelige advarsler:**
   - Pool != ONLINE → Sjekk diskstatus umiddelbart
   - CRITICAL alerts → Vis detaljer og foreslå aksjon
   - Load > cores → Høy belastning
   - Disker > 45°C → Sjekk kjøling
   - Stopped tjenester som burde kjøre → Start via web UI

5. **Etter rapport:** Spør om brukeren ønsker dypere analyse (StorageAnalysis workflow).
