# CheckStatus Workflow (v2 — scriptbasert)

Henter og analyserer OPNsense brannmur-status på norsk.

**Designprinsipp:** All datainnhenting, telling og aggregering skjer deterministisk i
`Scripts/check-firewall.sh` (curl + jq). Modellen ser ALDRI rå API-data — kun ferdig
aggregert JSON (~1-2 kB). Modellens jobb er utelukkende å formatere rapporten og
formidle vurderingene.

## 🔴 KRITISK: Aldri POST uten eksplisitt tillatelse

OPNsense gir rettigheter per side, ikke lese/skrive: der API-brukeren har en side, kan
nøkkelen også skrive. **POST på OPNsense-endepunkter kan trigge systemhalts.** Dette har
skjedd før.

- Scriptet bruker KUN GET, unntatt søket `ids/service/queryAlerts` — håndhevet i kode
  (`api_post` nekter alle andre stier), ikke bare i prompt
- Modellen skal ALDRI gjøre egne curl-kall mot OPNsense utenom scriptet, og bruker aldri SSH
- Manuelle bans og andre skriveoperasjoner gjør brukeren selv
- Ved usikkerhet: spør brukeren først

## Notifikasjon

Kjører **CheckStatus** workflow i **FirewallStatus** for å sjekke brannmur-status...

## Steg 1: Kjør scriptet

`--history` er en fast del av kommandoen, ikke valgfritt: uten den glipper serien hver gang
den utelates, og delta i Steg 2/3 forutsetter en sammenhengende historikk (#223).

```bash
~/.opencode/skills/Infrastructure/FirewallStatus/Scripts/check-firewall.sh --pretty --detail --history
```

Historikk-fila er `FIREWALL_HISTORY_CSV` i `.env` (standard
`~/.opencode/MEMORY/STATE/firewall-history.csv`), og JSON-en sier hvor den er (`history_file`).
`WAN_IF` (standard `igc1`) settes i `.env`. Miljøoverstyringer ved behov: `LOG_LIMIT` (50),
`IDS_LIMIT` (100), `CURL_TIMEOUT` (15), `OPNSENSE_ENV_FILE` (~/.opencode/.env).

**Tolk exit-koden:**

| Exit | Betydning | Handling |
|------|-----------|----------|
| 0 | OK | Fortsett til steg 2 |
| 1 | Manglende credentials/miljø | Rapporter: "❌ Mangler credentials i ~/.opencode/.env eller jq er ikke installert" — STOPP |
| 2 | Autentiseringsfeil | Rapporter: "❌ API-nøklene er ugyldige. Generer nye i OPNsense Web UI (System → Access → Users → API Keys)" — STOPP |
| 3 | OPNsense ikke tilgjengelig | Rapporter: "❌ Kan ikke nå OPNsense. Sjekk at brannmuren er online" — STOPP |
| 4 | Uventet API-feil | Rapporter feilmeldingen fra stderr — STOPP |

**Viktig:** Ikke forsøk å "fikse" feil ved å gjøre egne API-kall. Rapporter og stopp.

## Steg 2: Les den aggregerte JSON-en

Scriptet returnerer ferdig aggregerte tall og vurderinger. Feltoversikt:

| Felt | Innhold |
|------|---------|
| `overall` | `OK` / `ADVARSEL` — beregnet av scriptet |
| `system.*` | Versjon, nickname, arkitektur, `update_available`, statusmelding, `series` og `edition` (CE/BE), og `verified` (`list`, `matches`, `note`): om endepunktene er verifisert på denne serien og utgaven |
| `history_file` | Historikk-fila scriptet leste og skrev (`null` uten `--history`/`--csv`) |
| `inspection.*` | blocks/passes/rejects (siste N), `wan_blocks_in`, topplister, siste blokkering, `assessment` |
| `rules.*` | Totalt, CrowdSec-regler, aktive/deaktiverte, topp 5 egendefinerte |
| `crowdsec.*` | `installed`, service, komponentstatus, alerts/bans, `decisions` (IP/årsak/utløpstid), topp scenarier/land, siste 5 alerts, `assessment` |
| `certificate.*` | Sertifikatet på API-adressen, lest over TLS: `subject`, `issuer`, `not_before`/`not_after`, `days_left`, `age_days`, `lifetime_days`, `renew_after_days` (fornyelsesintervallet, bare for kortlivede ≤ 100 dager), `renewal_overdue`, `assessment` (`OK` / `UTLØPER SNART` / `FORNYELSE UTEBLITT` / `UTLØPT` / `UKJENT`) |
| `suricata.*` | `installed`, `running`, `mode`, `pattern_matcher`, `interfaces_monitored`, `alert_count` (av `alerts_window`), `last_alert_ts`, `top_signatures`, `notable_alerts`, `assessment` |
| `delta` | Mot forrige rad i historikk-fila: `previous_checked_utc`, og for `version`, `rules_total`, `cs_active_bans`, `overall` og `cs_alerts_total` hver sin `{previous, current, changed}` (tallfelt har også `diff`). `changed` lister feltene som faktisk endret seg — **`cs_alerts_total` er aldri med i `changed`**, uansett hvor mye den har endret seg (se Steg 3). `null` når det ikke finnes en lesbar forrige rad (første kjøring, eller en avkortet rad). |

**Modellen skal IKKE regne om, telle på nytt eller "korrigere" tallene.** Tallene fra
scriptet er fasit — det gjelder også `delta`: scriptet har allerede avgjort hva som
«changed», modellen skal ikke overprøve det. Modellens bidrag er formatering og
eventuelle kvalitative observasjoner (f.eks. "samme IP går igjen som i forrige sjekk").

## Steg 3: Presenter rapporten

Generer strukturert rapport på NORSK fra JSON-feltene:

```markdown
# 🛡️ Brannmur Status: [overall: OK ⚠️ ADVARSEL]
**OPNsense:** [system.version] [system.edition] ([system.nickname]) | **Sjekket:** [checked_utc]
**Oppdatering:** [Ingen tilgjengelig / v[system.latest] tilgjengelig ⚠️]

---

## 📊 Pakkeinspeksjon — [inspection.assessment]

| Type | Antall (siste [log_limit]) |
|------|----------------------------|
| Blokkert (block) | [inspection.blocks] |
| Tillatt (pass) | [inspection.passes] |
| Avvist (reject) | [inspection.rejects] |

**Topp 3 blokkerte kilder:** [inspection.top_blocked_src som "IP — antall"]
**Topp 3 blokkerte porter:** [inspection.top_blocked_dstport]
**Siste blokkering:** [inspection.last_block: ts — src → dst (label)]

---

## 🛡️ Suricata IDS — [suricata.assessment]

| Metrikk | Verdi |
|---------|-------|
| Kjører | [suricata.running → Ja/Nei] |
| Modus | [suricata.mode] |
| Overvåkede interfaces | [suricata.interfaces_monitored, kommaseparert] |
| Pattern matcher | [suricata.pattern_matcher] |
| Alerts (siste [suricata.alerts_window]) | [suricata.alert_count] |
| Siste alert | [suricata.last_alert_ts] |

**Topp signaturer:** [suricata.top_signatures som "signatur — antall"]
**Verdt å se på:** [suricata.notable_alerts, eller "ingen"]

*(Står `suricata.installed` til false, skriv «Suricata er ikke installert».)*

---

## 🔒 CrowdSec — [crowdsec.assessment]

| Komponent | Status |
|-----------|--------|
| Tjeneste | [crowdsec.service] |
| Agent | [crowdsec.agent_enabled → aktivert/deaktivert] |
| LAPI | [crowdsec.lapi_enabled → aktivert/deaktivert] |
| Firewall Bouncer | [crowdsec.bouncer_enabled → aktivert/deaktivert] |
| Bouncers tilkoblet | [crowdsec.bouncers_connected] |
| CrowdSec-regler i filter | [rules.crowdsec] |

**Alerts:** [crowdsec.alerts_total] | **Aktive bans:** [crowdsec.active_bans]

**Aktive ban-detaljer:**
| IP | Årsak | Utløpstid | Land | Treff |
|----|-------|-----------|------|-------|
[crowdsec.decisions som tabell — ip, reason, expiration, country, events]

[Tabell: crowdsec.top_scenarios]
[Tabell: crowdsec.top_countries]
[Tabell: crowdsec.recent_alerts — dato/IP/scenario/land]

---

## 📋 Filterregler

| Metrikk | Antall |
|---------|--------|
| Totalt regler | [rules.total] |
| CrowdSec-regler | [rules.crowdsec] |
| Egendefinerte regler | [rules.custom] |
| Deaktiverte regler | [rules.disabled] |

**Egendefinerte regler (topp 5):** [rules.custom_top5 som tabell]

---

## 🔐 Sertifikat — [certificate.assessment]

| Metrikk | Verdi |
|---------|-------|
| Utsteder | [certificate.issuer] |
| Gyldig til | [certificate.not_after] ([certificate.days_left] dager igjen) |
| Alder | [certificate.age_days] dager (fornyes etter [certificate.renew_after_days]) |

*(Står `certificate.readable` til false, skriv «Sertifikatet kunne ikke leses».)*

---

## 💻 System

| Metrikk | Verdi |
|---------|-------|
| Versjon | OPNsense [system.version] |
| Arkitektur | [system.arch] |
| Siste versjon | [system.latest] |
| Verifisert mot | [system.verified.list, kommaseparert] → [matches: ✅ / ⚠️ system.verified.note] |
| Statusmelding | [system.status_message] |

---

## 🚨 Varsler
[Utled fra assessments: inspection.assessment == ADVARSEL → "Ingen blokkerte pakker
på WAN — sjekk at inspeksjon kjører". crowdsec.assessment == DELVIS → spesifiser
hvilke komponenter som er deaktivert. suricata.assessment != AKTIV (og ikke IKKE
INSTALLERT) → nevn det; notable_alerts ikke tom → list dem. system.verified.matches ==
false → skriv system.verified.note ordrett,
certificate.assessment FORNYELSE UTEBLITT → «Sertifikatet er [age_days] dager gammelt og skulle
vært fornyet etter [renew_after_days]: sjekk ACME-klienten i Web-UI-et (Services → ACME Client →
Log Files)»; UTLØPER SNART eller UTLØPT → det samme, med dagene igjen. Er intervallet ikke 60
dager, settes `ACME_RENEW_DAYS` i `.env`, og at tallene kan være feil til endepunktene er
verifisert på nytt. update_available == true →
nevn ny versjon.
Ellers: "Ingen problemer funnet ✅"]

---

## 📈 Endring siden forrige kjøring
[Står `delta` til null, skriv «Første kjøring med historikk — ingen forrige rad å
sammenligne med.» og hopp over resten av seksjonen.

Ellers: list feltene i `delta.changed` (tom liste → "Ingen endringer siden
[delta.previous_checked_utc]"), hver som "felt: forrige → nå" (tallfelt kan ta med
diff). Nevn så `delta.cs_alerts_total` (forrige → nå) som ren informasjon, uavhengig av
om den står i `changed` — den er ikke en kumulativ teller (antall rader
`/api/crowdsec/alerts/search` returnerer nå), så et fall er IKKE i seg selv et
problem og skal ikke tolkes som et. Ikke regn selv ut om noe "egentlig" har endret
seg — `delta` er allerede fasiten.]

---
**Tips:** Kjør `sjekk brannmur` når som helst for ny status.
```

## Steg 4: Arkiver rapport

Etter at rapporten er presentert, **spør brukeren**:

```
"Vil du arkivere denne rapporten? (J/N)"
```

Hvis **ja** — skriv `YYYY-MM-DD-firewall-status.md` i mappa `history_file` ligger i
(samme innhold, fjern emoji og tipslinje).

Merk: historikk-fila appendes automatisk av scriptet uavhengig av dette
— arkivspørsmålet gjelder kun den fulle markdown-rapporten.

## n8n-notat

Scriptet er selvstendig og LLM-uavhengig:
- **Execute Command-node:** kjør scriptet med `--history`, parse stdout som JSON
- **IF-node:** `overall != "OK"` eller exit-kode != 0 → varsling (e-post/Telegram/ntfy)
- **Valgfritt LLM-steg:** send JSON-en til en modell kun for å formatere en
  lesbar rapport — tallene er allerede fasit
- Miljøvariabel `OPNSENSE_ENV_FILE` kan peke til en annen .env for n8n-containeren
- `LOG_LIMIT` og `CURL_TIMEOUT` kan også overstyres via miljø
