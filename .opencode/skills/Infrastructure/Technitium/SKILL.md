---
name: Technitium
description: Technitium DNS Server overvåking og administrasjon via HTTP API. USE WHEN technitium, technitiumdns, dns status, sjekk dns, dns blokkering, blokkerte domener, blocklist, hvitlist dns, allowlist dns, dns cache, flush dns, resolver domenenavn, er domenet blokkert, dns trusler, dns query logs, dns soner, dns records.
---

## Customization

**Before executing, check for user customizations at:**
`~/.opencode/PAI/USER/SKILLCUSTOMIZATIONS/Technitium/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

# Technitium DNS

Overvåk og administrer Technitium DNS Server: serverstatus, query-stats, blokkerte/allowed domener, DNS-cache, soner, query-logger og blocklister.

**Host:** `TECHNITIUM_API_URL` i `~/.opencode/.env` (typisk `https://<vert>:53443`, selvsignert sertifikat); hvor den kjører, står i `PAI/USER/INFRASTRUCTURE.md`
**Versjon:** Technitium DNS Server 15.2
**Bruker:** `pai-api` (token-basert, ikke-utløpende)
**Auth:** `Authorization: Bearer <token>` (kreves fra v15.0 på alle kall)

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **CheckStatus** | "technitium status", "sjekk dns", "dns status", "hvordan går det med dns", "dns helse" | `Workflows/CheckStatus.md` |
| **ThreatScan** | "dns trusler", "blokkerte domener", "hva blokkeres", "dns blocking", "dns sikkerhet", "blocklist analyse" | `Workflows/ThreatScan.md` |
| **ResolveDomain** | "hvorfor resolver X", "er X blokkert", "sjekk domenet", "dns feilsøk", "resolver domenenavn" | `Workflows/ResolveDomain.md` |
| **ManageBlocklists** | "blokker domene", "fjern blokkering", "hvitlist domene", "allowlist", "oppdater blocklist", "importer blokkliste" | `Workflows/ManageBlocklists.md` |
| **ManageCache** | "flush dns cache", "tøm dns cache", "dns cache", "cache oppføringer" | `Workflows/ManageCache.md` |

## Quick Reference

- **Credentials:** `~/.opencode/.env` → `TECHNITIUM_API_URL`, `TECHNITIUM_API_TOKEN`, `TECHNITIUM_TLS_VERIFY`
- **Script:** `Scripts/technitiumApi.ts` — ALL datainnhenting går via dette. Modellen gjør aldri egne HTTP-kall mot Technitium.
- **Klient:** Bun native `fetch` med `tls: {rejectUnauthorized:false}` (selvsignert cert) — ingen eksterne avhengigheter
- **API-referanse:** `TechnitiumApi.md` (i skill-roten)
- **Offisiell API-doc:** https://github.com/TechnitiumSoftware/DnsServer/blob/master/APIDOCS.md
- **Web-UI (for endringer som ikke støttes via API):** samme adresse som `TECHNITIUM_API_URL`

```bash
S=~/.config/opencode/skills/Infrastructure/Technitium/Scripts/technitiumApi.ts
bun $S --compact stats                    # query-stats siste time
bun $S --compact top blocked LastDay 10   # topp blokkerte domener
bun $S --compact resolve example.com A    # DNS-oppslag via serveren
```

## Read-kommandoer (ufarlige)

`status` · `stats [type]` · `top <clients|domains|blocked> [type] [limit]` · `zones` · `records <zone> [domain] [--all]` · `cache [domain]` · `blocked [domain] [up|down]` · `allowed [domain] [up|down]` · `export-blocked` · `export-allowed` · `resolve <domain> [type] [server]` · `settings [key...]` · `apps` · `metrics [json|text]` · `dhcp-leases` · `dhcp-scopes` · `logs [limit] [--qname X] [--client IP] [--rcode X]` · `logs-files`

## Write-kommandoer (endre tilstand — spør brukeren først)

`cache-flush [domain]` · `blocked-add <domain>` · `blocked-delete <domain>` · `blocked-flush` · `blocked-import <file|domains>` · `allowed-add <domain>` · `allowed-delete <domain>` · `allowed-flush` · `blocklist-update` · `blocking-disable <minutes>`

## Kjente særheter (verifisert 2026-09-12 mot v15.2)

- **Hierarkisk blokkering:** Blokkerte/allowed domener lagres som subsoner under TLD-er. `blocked/list` uten `domain` viser barn av roten (f.eks. `com`, `io`); `blocked/list?domain=com` viser `facebook.com`, `fb.com`. For **hele** listen bruk `export-blocked` / `export-allowed` (ren tekst, én per linje). `blocked/list?domain=facebook.com` returnerer bare NS/SOA for sonen — ikke selve blokk-oppføringen.
- **`/api/status` krever token i v15.2** — offisiell doc antyder «None», men uautentisert kall gir `invalid-token`. Bruk `status`-kommandoen (session/get).
- **`/api/dnsClient/healthCheck` gir 404 på 15.2** — bruk `resolve` for helsesjekk i stedet.
- **`/api/logs/query` krever app-parametere:** `name=Query Logs (Sqlite)` og `classPath=QueryLogsSqlite.App`. Scriptet setter disse automatisk.
- **Blokkeringstype:** `settings blockingType` = `NxDomain`. Det finnes **ingen** `useNxDomainForBlocking`-nøkkel i 15.2 (docsen er utdatert). Blokkerte domener svarer altså NXDOMAIN.
- **Passord med spesialtegn:** ved `createToken`/`login` i URL, bruk `curl -G --data-urlencode "pass=..."` — ellers bryter `&` i passordet query-strengen.
- **`blocklist-update` og `blocking-disable` endrer global tilstand** — ikke kjør uten eksplisitt samtykke. `blocking-disable` slår av all blokkering i N minutter.

## Eksempler

```
User: "Sjekk DNS-en"
→ CheckStatus: status + stats + top klienter/domener + blocklist-ferskhet

User: "Hva blokkeres mest i dag?"
→ ThreatScan: top blocked LastDay + query-logger for blokkerte

User: "Er testmynids.org blokkert?"
→ ResolveDomain: resolve + blocked-oppslag + cache + logger
```
