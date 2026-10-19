# OPNsense API Referanse

Dokumentasjon av verifiserte OPNsense REST API endpoints for brannmur-overvåking.

**OPNsense versjon:** endepunktene verifisert på 26.1.10 (2026-07-08); IDS-endepunktene
og `firmware/status` på 26.7.5 (2026-10-10), alle på 26.7.6_3 (2026-10-11)
**Versjonsvakten (#414, #466):** scriptet sammenligner brannmurens serie og utgave med
lista `VERIFIED="26.7/CE"` (serie/utgave, mellomrom mellom parene). Står kombinasjonen ikke
der, blir `overall` ADVARSEL med `system.verified.note`. Når endepunktene er verifisert på
en ny serie eller utgave: legg den til i scriptet og denne linja i samme commit (testen ved
siden av scriptet holder dem like).
Utgaven leses fra `product_id` (`opnsense` = CE; `opnsense-business` = BE, UTLEDET).
**Base URL:** Fra `~/.opencode/.env` (`OPNSENSE_API_URL`)
**Autentisering:** HTTP Basic Auth — `OPNSENSE_API_KEY` som brukernavn, `OPNSENSE_API_SECRET` som passord
**Lesing:** alle kall i denne skillen er GET, unntatt søket `ids/service/queryAlerts` (POST)

---

## Autentiseringseksempel

```bash
source ~/.opencode/.env
curl -s \
  -u "${OPNSENSE_API_KEY}:${OPNSENSE_API_SECRET}" \
  "${OPNSENSE_API_URL}/api/core/system/status"
```

**Merk:** IKKE bruk `-k` flagget — sertifikatvalidering skal være på (Let's Encrypt).

---

## Verifiserte Endpoints (✅ = testet og fungerende)

### Core — System

| Endpoint | Status | Beskrivelse | Returnerer |
|----------|--------|-------------|------------|
| `/api/core/system/status` | ✅ | Systemstatus | `{"metadata":{"system":{"status":N,"message":"..."}}}` |
| `/api/core/firmware/status` | ✅ | Firmware-status | `{"product":{"product_id":"opnsense","product_series":"26.7","product_version":"26.7.6_3","product_latest":"26.7.6",...}, "status":"none"}` |
| `/api/core/firmware/info` | ✅ | Firmware detaljer | Fullstendig produktinformasjon |
| `/api/core/system/time` | ❌ 404 | Systemtid | Ikke tilgjengelig i denne versjonen |

### Diagnostics — Logger

| Endpoint | Status | Beskrivelse | Returnerer |
|----------|--------|-------------|------------|
| `/api/diagnostics/firewall/log/?limit=N` | ✅ | Siste N filterlogglinjer (JSON) | Array av logg-objekter med `action`, `interface`, `src`, `dst`, `label` mm. |
| `/api/diagnostics/firewall/log_facilities/` | ❌ 404 | Loggfasiliteter | Ikke tilgjengelig |
| `/api/diagnostics/system/systemhealth/` | ❌ 404 | Systemhelse | Ikke tilgjengelig via API i denne versjonen |

**Viktig om filterlogg:** `/api/diagnostics/firewall/log/` returnerer JSON (ikke rå tekst). Hver oppføring har felt: `action` (block/pass), `interface` (igc1=WAN), `src`, `dst`, `label`, `protoname`, `timestamp`, etc.

### Firewall — Filterregler

| Endpoint | Status | Beskrivelse | Returnerer |
|----------|--------|-------------|------------|
| `/api/firewall/filter/searchRule` | ✅ | Søk/list alle filterregler | `{"rows":[{...regeldefinisjoner...}], "total":N, "rowCount":N}` |
| `/api/firewall/filter/getRuleStats` | ❌ 404 | Regelstatistikk | Ikke tilgjengelig |
| `/api/firewall/filter/toggleRule/enabled` | ❌ 403 | Regel-toggle | Forbudt (POST) — ikke brukt |

### CrowdSec Plugin

**Oppdatert 2026-07-08:** Alle `/api/crowdsec/*/search`-endepunkter fungerer med KUN GET — POST er ikke nødvendig. Dette ble verifisert ved direkte testing.

| Endpoint | Metode | Status | Beskrivelse | Returnerer |
|----------|--------|--------|-------------|------------|
| `/api/crowdsec/service/status` | GET | ✅ | Tjenestestatus | `{"status":"running","widget":{...}}` |
| `/api/crowdsec/general/get` | GET | ✅ | Konfigurasjon | `{"general":{"agent_enabled":"1","lapi_enabled":"1","firewall_bouncer_enabled":"1",...}}` |
| `/api/crowdsec/alerts/search` | **GET** | ✅ | Søk alerts | `{"rows":[{"id":N,"value":"Ip:...","reason":"...","country":"..","decisions":"ban:N",...}]}` |
| `/api/crowdsec/decisions/search` | **GET** | ✅ | Søk aktive bans | `{"rows":[{"value":"...","type":"...","duration":"...",...}]}` |
| `/api/crowdsec/machines/search` | **GET** | ✅ | Maskiner | `{"rows":[{"name":"localhost","version":"v1.7.8_1",...}]}` |
| `/api/crowdsec/bouncers/search` | **GET** | ✅ | Bouncers | `{"rows":[{"name":"cs-firewall-bouncer-...","type":"crowdsec-firewall-bouncer",...}]}`

**Alerts vs Decisions:** Alerts er detekterte trusler som kan føre til ban. Decisions er aktive utestengelser (IP-adresser med `ban:1`). En IP kan ha alert uten aktiv decision hvis bannen har utløpt.

**CrowdSec vurdering:** Tjenesten kjører, firewall-bouncer er aktiv, og CrowdSec-regler finnes i filterreglene (`crowdsec_blocklists` aliases). Alerts viser hvilke IP-er som er flagget og for hvilke scenarier.

### IDS (Suricata)

Suricata er OPNsense' innebygde IDS (*Services → Intrusion Detection*). Stien er
`/api/ids/`, ikke `/api/suricata/` (den gir 404). Verifisert 2026-10-10 på 26.7.5 med
nøkkelen skillen bruker; ingen endring i rettighetene trengtes.

| Endpoint | Metode | Status | Beskrivelse | Returnerer |
|----------|--------|--------|-------------|------------|
| `/api/ids/service/status` | GET | ✅ | Kjøretilstand | `{"status":"running",...}` |
| `/api/ids/settings/get` | GET | ✅ | Konfig | `{"ids":{"general":{"enabled":"1","mode":{"pcap":{"selected":1},...},"interfaces":{"lan":{"value":"LAN","selected":1},...},"MPMAlgo":{"hs":{"selected":1},...}}}}` |
| `/api/ids/service/queryAlerts` | **POST** | ✅ | Alerts fra `eve.json` | `{"total":N,"rowCount":N,"current":1,"rows":[{"timestamp","alert","alert_sid","alert_action","src_ip","dest_ip","in_iface",...}]}` — body `{"current":1,"rowCount":100}` |

**`queryAlerts` krever POST:** GET mot den gir `200` og `[]`, også når det finnes alerts
(målt: GET `[]`, POST 101 alerts i samme minutt). Det er et søk med pagineringen i body, og
det eneste POST-kallet skillen gjør. `api_post` i scriptet nekter alle andre stier.

---

## Tolkning av filterlogger

Filterlogger (fra `/api/diagnostics/firewall/log/`) viser pakker som matches mot regler i JSON-format:

**Nøkkelfelt:**
- `action`: `block` | `pass` | `reject`
- `interface`: `igc1` = WAN, `igc0` = LAN, etc.
- `src` / `dst`: Kilde- og mål-IP
- `srcport` / `dstport`: Porter
- `protoname`: `tcp` | `udp` | `icmp`
- `label`: Regelbeskrivelse (f.eks. "Default deny / state violation rule")
- `__timestamp__`: Tidspunkt (ISO 8601)
- `dir`: `in` | `out` — trafikkretning

**Tolkning:**
- `action: block` + `dir: in` + `interface: igc1` → Pakkeinspeksjon på WAN fungerer ✅
- `action: pass` + `dir: out` → Utgående trafikk tillatt (normalt)
- Mange `block` på WAN er NORMALT — det er brannmurens jobb
- NULL blocks over tid på WAN → ADVARSEL: inspeksjon kan være nede ⚠️

---

## CrowdSec i filterreglene

I `/api/firewall/filter/searchRule` ser du CrowdSec-regler som bruker aliases:
- `crowdsec_blocklists` — IPv4 blokkeringsliste
- `crowdsec6_blocklists` — IPv6 blokkeringsliste

Disse er satt opp med `quick: true` og `action: block` i begge retninger (in/out). CrowdSec sin firewall-bouncer oppdaterer disse listene automatisk.

---

## Feilhåndtering

| Statuskode | Tolkning |
|------------|----------|
| `200` | OK — data returnert |
| `401` | Autentiseringsfeil — sjekk API_KEY/API_SECRET i `.env` |
| `403` | Ingen tilgang — API-nøkkelen mangler rettigheter |
| `404` | Endpoint ikke funnet — ikke tilgjengelig i denne OPNsense-versjonen |
| `500` | Serverfeil — OPNsense kan være nede eller restartende |
| `timeout` | Tilkoblingsfeil — sjekk nettverk/URL |

---

## Sikkerhetsnotat

API-nøkkelen tilhører den begrensede `Claude`-brukeren. OPNsense gir rettigheter per
side, ikke lese/skrive: på en side brukeren har, kan nøkkelen også skrive (UTLEDET fra
OPNsense' modell for rettigheter, ikke målt med en skriving). Grensen mot skriving er
derfor scriptet. Denne skillen:
- Bruker KUN GET, unntatt søket `ids/service/queryAlerts` — skriver aldri til brannmuren
- Logger aldri credentials i output
- Bruker `source` for å laste `.env` variabler, ikke hardkoder nøkler
- Validerer ALLTID TLS-sertifikat (Let's Encrypt)
