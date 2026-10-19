---
name: FirewallStatus
description: OPNsense brannmur-overvåking og diagnostikk (inkl. Suricata IDS og CrowdSec). USE WHEN brannmur status, firewall status, sjekk brannmur, OPNsense, pakkeinspeksjon, crowdsec alerts, suricata, ids, suricata status, firewall logger, brannmur helse, "hva er status på firewall".
---

## Customization

**Before executing, check for user customizations at:**
`~/.opencode/PAI/USER/SKILLCUSTOMIZATIONS/FirewallStatus/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

# FirewallStatus

Sjekker OPNsense brannmur-status: systemhelse, filterlogger, pakkeinspeksjon, CrowdSec varsler, og ytelse.

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **CheckStatus** | "sjekk brannmur", "firewall status", "hva er status på firewall", "OPNsense status" | `Workflows/CheckStatus.md` |

## Quick Reference

- **API base:** Leses fra `~/.opencode/.env` (`OPNSENSE_API_URL`, `OPNSENSE_API_KEY`, `OPNSENSE_API_SECRET`)
- **Autentisering:** HTTP Basic Auth (API_KEY:API_SECRET)
- **Sertifikat:** Valideres alltid — IKKE bruk `-k` flagg
- **KUN GET, ett unntak:** `POST /api/ids/service/queryAlerts` er et søk (pagineringen
  står i body); GET mot den gir bare `[]`. Scriptets `api_post` nekter alle andre stier.
  Ingen PUT/DELETE, ingen andre POST.
- **Script:** `Scripts/check-firewall.sh` — ALL datainnhenting går via dette, også
  Suricata. Modellen gjør aldri egne API-kall mot OPNsense, og aldri SSH.
  `--pretty` for pen JSON, `--detail` for detaljert ban-liste, `--history` for historikk
  (fila er `FIREWALL_HISTORY_CSV` i `.env`, standard `~/.opencode/MEMORY/STATE/firewall-history.csv`;
  `--csv FIL` for en annen fil).
- **Versjonsvakt:** `system.verified` sier om brannmuren kjører en serie og utgave
  endepunktene er verifisert på (lista `VERIFIED` i scriptet, #414). Står den ikke der,
  er `overall` ADVARSEL, og rapporten sier det.
- **API-dokumentasjon:** `OpnSenseApi.md` (SkillSearch('firewallstatus api'))
- **Arkiv:** mappa historikk-fila ligger i (`history_file` i JSON-en) — spør bruker før skriving

## Suricata IDS-status (via API-et)

Suricata er OPNsense' innebygde IDS (*Services → Intrusion Detection*), og API-et ligger
under `/api/ids/`. `check-firewall.sh` henter `ids/service/status`, `ids/settings/get` og
de siste `IDS_LIMIT` (100) alertene fra `ids/service/queryAlerts`, og gir `suricata.*`:
- `running`, `mode` (IDS eller IPS), `pattern_matcher` (`hs`/`ac`), `interfaces_monitored`
- `alert_count` (i vinduet på `alerts_window`), `last_alert_ts`, `top_signatures`,
  `notable_alerts` (TROJAN/MALWARE/EXPLOIT/C2)
- `assessment` (`AKTIV` / `KJØRER (ingen alerts enda)` / `STOPPET` / `IKKE INSTALLERT`)

PAI bruker ikke SSH til brannmuren, selv om nøkkelen finnes. Det som krever et skall
der (`cscli`, logger med `scp`), gjør brukeren selv.

## Examples

**Example 1: Kjapp status**
```
User: "Hva er status på firewall?"
→ Invokes CheckStatus workflow
→ Henter systemstatus, filterlogger, CrowdSec varsler
→ Returnerer strukturert statusrapport på norsk
```

**Example 2: Sjekk pakkeinspeksjon**
```
User: "Sjekk om pakkeinspeksjon fungerer på OPNsense"
→ Invokes CheckStatus workflow med fokus på filterlogger
→ Analyserer nylige blokkeringer og passeringsmønstre
→ Rapporterer om inspeksjon er aktiv
```

**Example 3: CrowdSec sjekk**
```
User: "Har crowdsec trigget noe?"
→ Invokes CheckStatus workflow med fokus på CrowdSec API
→ Lister nylige alerts og bans
→ Viser total statistikk
```

**Example 4: Arkivering**
```
User: "Sjekk brannmur" / "firewall status"
→ Henter data og presenterer rapport
→ Spør: "Vil du arkivere denne rapporten? (J/N)"
→ Hvis Ja: skriv YYYY-MM-DD-firewall-status.md i mappa til history_file
```

**Example 5: Suricata IDS-status**
```
User: "Sjekk Suricata-status" / "kjører IDS-en frisk?"
→ Kjører Scripts/check-firewall.sh --pretty, leser suricata.*
→ Rapporterer pattern_matcher, alert_count, running + assessment
→ hvis assessment != AKTIV → flagg som ADVARSEL i rapporten
```
