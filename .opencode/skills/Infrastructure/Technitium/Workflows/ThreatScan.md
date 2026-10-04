# ThreatScan Workflow

L7/DNS-trusselanalyse: hva blokkeres, hvilke klienter spør, og om noe slipper gjennom.

**Script:** `Scripts/technitiumApi.ts` — ALL datainnhenting går via dette.

## Steps

1. **Topp blokkerte domener:**
```bash
S=~/.config/opencode/skills/Infrastructure/Technitium/Scripts/technitiumApi.ts
bun $S --compact top blocked LastDay 25
bun $S --compact top blocked LastWeek 25
```

2. **Hvilke klienter genererer mest trafikk (og mulig infisert vert):**
```bash
bun $S --compact top clients LastDay 10
```

3. **Blokkeringstype + blocklist-helse:**
```bash
bun $S --compact settings enableBlocking blockingType blockListUrls blockListNextUpdatedOn
```

4. **Se etter mistenkelige mønstre i query-loggene** (blokkerte/feilede oppslag):
```bash
bun $S --compact logs 100 --rcode NxDomain
bun $S --compact logs 100 --client <IP>
```

5. **Verifiser enkeltdomener ved behov:**
```bash
bun $S --compact resolve <mistenkelig-domene> A
bun $S --compact blocked <tld>
```

6. **Presenter funn:**

```
🔍 DNS TRUSSELSCAN — siste døgn
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🚫 TOPP BLOKKERTE (av X unike)
  #   Domene                       Treff
  1   stats.grafana.org            14 425
  2   ads.mozilla.org                  27
  ...

👥 MEST AKTIVE KLIENTER
  1   <klient-IP>    N treff

📋 VURDERING
  - Blocklister oppdatert: ja/nei (neste: <tid>)
  - Blokkering aktiv: ja/nei
  - Observasjoner: <kort analyse>
```

## Tolkning

- **Ekstremt høye treff på ett domene** (som `stats.grafana.org` → 14k) er oftest intern telemetri/analyse, ikke angrep. Nevn dette.
- **Mange ulike blokkerte domener fra én klient** → mulig infisert enhet / aggressiv tracker.
- **NxDomain-trafikk mot tilfeldige domener** (DGA-mønster) → mulig malware.
- **Blokkering AV** → alt slipper gjennom; eskaler.
- **Blocklister gamle** → nyere C2/ads slipper gjennom; foreslå `blocklist-update`.

7. **Handling:** Ved mistanke om infisert klient → anbefal nettverksisolering. Endringer i blokkliste → `ManageBlocklists`.
