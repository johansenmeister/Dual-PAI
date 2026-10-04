# CheckStatus Workflow

Helhetsstatus for Technitium DNS: versjon, query-volum, blokkering, topp klienter/domener, blocklist-ferskhet og cache.

**Script:** `Scripts/technitiumApi.ts` — ALL datainnhenting går via dette. Modellen gjør aldri egne HTTP-kall mot Technitium.

## Steps

1. **Credentials:** Verifiser at `TECHNITIUM_API_TOKEN` er satt i `~/.opencode/.env`.

2. **Kjør innhenting:**
```bash
S=~/.config/opencode/skills/Infrastructure/Technitium/Scripts/technitiumApi.ts
bun $S --compact status
bun $S --compact stats LastHour
bun $S --compact top clients LastHour 5
bun $S --compact top blocked LastHour 5
bun $S --compact settings version enableBlocking blockingType blockListUrls blockListNextUpdatedOn
bun $S --compact apps
```

3. **Presenter strukturert rapport:**

```
📊 TECHNITIUM DNS — <vert>:53443
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🖥️  SERVER
  Versjon:       15.2
  Bruker:        pai-api
  Blokkering:    PÅ (type: NxDomain)
  Blocklister:   2 lister
  Neste oppdat.: 2026-09-12 22:05

📈 SISTE TIME
  Queries:       3 500
  Blokkert:      472 (13.5%)
  Klienter:      7

🏆 TOPP KLIENTER
  1. <klient-IP>    N hits

🚫 TOPP BLOKKERTE DOMENER
  1. stats.grafana.org   14 425
  2. ads.mozilla.org         27

🧩 APPER
  Query Logs (Sqlite) 9.1

💾 CACHE
  Soner: 41 | Oppføringer: N
```

4. **Ved avvik — tydelige flagg:**
   - `enableBlocking = false` → blokkering er AV (sjekk om `blocking-disable` står på)
   - `blockListNextUpdatedOn` i fortiden → blocklister er ikke oppdatert; vurder `blocklist-update`
   - Blokkert-andel > 30% → uvanlig høyt, sjekk `ThreatScan`
   - Tom `blockListUrls` → ingen lister konfigurert

5. **Etter rapport:** tilby `ThreatScan` for dypere analyse av blokkerte domener.
