# Technitium DNS API Reference

**Protokoll:** HTTP REST (GET/POST), JSON-svar
**Endepunkt:** `https://<vert>:53443/api`
**Versjon:** Technitium DNS Server 15.6.2
**Rolle:** `pai-api` (DNS Administrator — utvid til read-only senere om ønskelig)
**Auth:** `Authorization: Bearer <token>` på alle kall (påkrevd fra v15.0)

Konfigurasjon leses fra `~/.opencode/.env`:

```bash
TECHNITIUM_API_URL=https://<vert>:53443
TECHNITIUM_API_TOKEN=<non-expiring token>
TECHNITIUM_TLS_VERIFY=false        # selvsignert sertifikat
```

Sertifikatet er selvsignert. Bun: `fetch(url, { tls: { rejectUnauthorized: false } })`.

## Autentisering

```bash
# Login (kortlivd session-token)
curl -ksS -G "https://<vert>:53443/api/user/login" \
  --data-urlencode "user=pai-api" \
  --data-urlencode "pass=<password>"        # --data-urlencode håndterer & og andre tegn

# Opprett ikke-utløpende API-token
curl -ksS -G "https://<vert>:53443/api/user/createToken" \
  --data-urlencode "user=pai-api" \
  --data-urlencode "pass=<password>" \
  --data-urlencode "tokenName=pai-api"
```

Svarformat: `{"status":"ok"|"error"|"invalid-token"|"2fa-required", ...}`. Alt nyttig ligger under `response`.

## Endepunkter

### Bruker / sesjon

| Endepunkt | Beskrivelse | Viktige parametere |
|-----------|-------------|--------------------|
| `GET /api/user/login` | Logg inn, få session-token | `user`, `pass`, `totp?`, `includeInfo?` |
| `GET /api/user/createToken` | Lag ikke-utløpende token | `user`, `pass`, `tokenName` |
| `GET /api/user/session/get` | Sesjonsinfo: bruker, versjon, rettigheter | — |
| `GET /api/user/profile/get` | Profil + aktive sesjoner | — |
| `GET /api/user/logout` | Avslutt sesjon | — |

### Dashboard / statistikk

| Endepunkt | Beskrivelse | Viktige parametere |
|-----------|-------------|--------------------|
| `GET /api/dashboard/stats/get` | Query-stats for periode | `type` = LastHour\|LastDay\|LastWeek\|LastMonth\|LastYear\|Custom, `start?`, `end?` |
| `GET /api/dashboard/stats/getTop` | Topplister | `statsType` = TopClients\|TopDomains\|TopBlockedDomains, `type`, `limit` |
| `GET /api/dashboard/metrics/json` | Livstidsmetrikk | — |
| `GET /api/dashboard/metrics/text` | Prometheus-format | — |

`stats/get` gir bl.a. `totalQueries`, `totalBlocked`, `totalCached`, `totalClients`,
`zones`, `cachedEntries`, `blockListZones`, og topplister (`topClients`, `topDomains`, `topBlockedDomains`).

### Soner (authoritative)

| Endepunkt | Beskrivelse | Viktige parametere |
|-----------|-------------|--------------------|
| `GET /api/zones/list` | List alle soner | `pageNumber?`, `zonesPerPage?`, `filterName?`, `filterType?` |
| `GET /api/zones/records/get` | Hent records | `zone`, `domain`, `listZone` (true = hele sonen) |
| `GET /api/zones/records/add` | Legg til record | `zone`, `domain`, `type`, `ttl`, `value`/`records` |
| `GET /api/zones/records/update` | Oppdater record | `zone`, `domain`, `type`, `value`, `newValue` |
| `GET /api/zones/records/delete` | Slett record | `zone`, `domain`, `type`, `value` |
| `GET /api/zones/create` | Opprett sone | `zone`, `type` = Primary\|Secondary\|Forwarder… |
| `GET /api/zones/delete` | Slett sone | `zone` |
| `GET /api/zones/enable` / `disable` | Slå sone av/på | `zone` |
| `GET /api/zones/options/get` | Sone-innstillinger | `zone` |

### Blokkerte soner (Blocked)

Blokkeringer lagres **hierarkisk som subsoner**. `list` uten `domain` viser barn av roten.

| Endepunkt | Beskrivelse | Viktige parametere |
|-----------|-------------|--------------------|
| `GET /api/blocked/list` | List barn av et domene | `domain?`, `direction?` = up\|down |
| `GET /api/blocked/add` | Blokker domene | `domain` |
| `GET /api/blocked/delete` | Fjern blokkering | `domain` |
| `GET /api/blocked/flush` | Tøm hele Blocked-sonen | — |
| `POST /api/blocked/import` | Importer domener | form: `blockedZones=a.com,b.com` |
| `GET /api/blocked/export` | Eksporter ALLE (tekst) | — |

### Tillatte soner (Allowed)

Samme struktur som Blocked.

| Endepunkt | Beskrivelse |
|-----------|-------------|
| `GET /api/allowed/list?domain=` | List barn av et domene |
| `GET /api/allowed/add?domain=` | Tillat domene |
| `GET /api/allowed/delete?domain=` | Fjern tillatelse |
| `GET /api/allowed/flush` | Tøm hele Allowed-sonen |
| `POST /api/allowed/import` | Importer (form: `allowedZones=...`) |
| `GET /api/allowed/export` | Eksporter alle (tekst) |

### DNS-cache

| Endepunkt | Beskrivelse | Viktige parametere |
|-----------|-------------|--------------------|
| `GET /api/cache/list` | List cachede soner/records | `domain?`, `direction?` |
| `GET /api/cache/delete` | Slett cachet domene | `domain` |
| `GET /api/cache/flush` | Tøm hele cachen | — |

### DNS-klient (oppslag)

| Endepunkt | Beskrivelse | Viktige parametere |
|-----------|-------------|--------------------|
| `GET /api/dnsClient/resolve` | Utfør DNS-oppslag | `server` (this-server/recursive-resolver/system-dns/NS), `domain`, `type`, `protocol?` = Udp\|Tcp\|Tls\|Https\|Quic |
| `GET /api/dnsClient/healthCheck` | Helse (⚠️ 404 på 15.2) | — |

`resolve`-svaret har `response.result.RCODE` (`NoError`/`NxDomain`/…), `Answer[]`, `Authority[]`.

### Query-logger (Query Logs Sqlite-app)

Krever appen `Query Logs (Sqlite)`. `/api/logs/query` **må** ha `name` og `classPath`.

| Endepunkt | Beskrivelse | Viktige parametere |
|-----------|-------------|--------------------|
| `GET /api/logs/query` | Søk i query-logger | `name=Query Logs (Sqlite)`, `classPath=QueryLogsSqlite.App`, `pageNumber`, `entriesPerPage`, `descendingOrder`, `qname?`, `clientIpAddress?`, `rcode?`, `qtype?`, `start?`, `end?` |
| `GET /api/logs/list` | List loggfiler på disk | — |

Loggoppføring inneholder `qname`, `qtype`, `responseType` (Recursive/Cached/Blocked/Authoritative),
`clientIpAddress`, `rcode`, `protocol`, `responseTimeMs` m.m.

### Innstillinger

| Endepunkt | Beskrivelse | Viktige parametere |
|-----------|-------------|--------------------|
| `GET /api/settings/get` | Alle DNS-innstillinger | — |
| `GET /api/settings/forceUpdateBlockLists` | Tving blocklist-oppdatering nå | — |
| `GET /api/settings/temporaryDisableBlocking` | Slå av blokkering midlertidig | `minutes` |

Nyttige nøkler fra `settings/get`: `version`, `dnsServerDomain`, `enableBlocking`,
`blockingType` (`NxDomain`), `blockListUrls[]`, `blockListUpdateIntervalHours`,
`blockListNextUpdatedOn`, `cacheMaximumEntries`, `forwarders`, `dnssecValidation`.

### Apper / DHCP

| Endepunkt | Beskrivelse |
|-----------|-------------|
| `GET /api/apps/list` | Installerte DNS-apper |
| `GET /api/dhcp/leases/list` | DHCP-leases |
| `GET /api/dhcp/scopes/list` | DHCP-scopes |

### Klynge (`/api/admin/cluster/*`)

Når klyngen er initialisert, tar nesten alle kall `node=<domene>` og går da til den noden; uten parameteren gjelder kallet noden som svarer. `node=cluster` gir tall for hele klyngen i `dashboard/stats/get` og `stats/getTop`.

| Endepunkt | Beskrivelse | Viktige parametere | Tilgang |
|-----------|-------------|--------------------|---------|
| `GET /api/admin/cluster/state` | Noder, type, tilstand, versjon (`cluster`) | `node?`, `includeServerIpAddresses?` | les (`Administration: View`) |
| `/api/admin/cluster/init` | Lag klyngen, med denne som primær | `clusterDomain`, `primaryNodeIpAddresses` | **write** |
| `/api/admin/cluster/primary/join` | Ta inn en sekundær (kalles av den som blir med) | — | **write** |
| `/api/admin/cluster/primary/removeSecondary`, `deleteSecondary`, `updateSecondary` | Fjern, slett eller endre en sekundær | `secondaryNodeId` | **write** |
| `/api/admin/cluster/primary/transferConfig`, `setOptions`, `delete` | Konfigurasjon til sekundærene, intervallene, slett klyngen | — | **write** |
| `/api/admin/cluster/initJoin` | Bli med i en klynge som sekundær | primærens URL og innlogging | **write** |
| `/api/admin/cluster/secondary/leave`, `resync`, `notify`, `updatePrimary`, `promote` | Forlat, synk på nytt, bytt eller bli primær | — | **write** |
| `/api/admin/cluster/updateIpAddress` | Endre nodens IP-adresser | — | **write** |

Skriptet har bare `cluster` (les). Write-endepunktene krever `Administration: Modify`; spør brukeren, og gjør dem i Web-UI-et.

## Scriptets kommandoer

Se `SKILL.md` for full liste. Kjernekommandoer:

```bash
S=~/.config/opencode/skills/Infrastructure/Technitium/Scripts/technitiumApi.ts
bun $S --compact status
bun $S --compact stats LastDay
bun $S --compact top blocked LastDay 20
bun $S --compact resolve example.com A
bun $S --compact blocked com
bun $S --compact export-blocked
bun $S --compact logs 50 --qname example.com
bun $S --compact settings enableBlocking blockListUrls blockListNextUpdatedOn
bun $S --compact cluster
bun $S --compact stats LastDay --node cluster
```

## Viktige merknader

- **Alle kall går via scriptet.** Modellen skal ikke gjøre rå HTTP-kall mot Technitium.
- **Self-signed TLS:** `TECHNITIUM_TLS_VERIFY=false` (scriptet bruker `tls.rejectUnauthorized`).
- **Token i klartekst:** `.env` har mode `600` og er gitignorert. Logg aldri token-verdien.
- **Write-operasjoner:** `blocked-*`, `allowed-*`, `cache-flush`, `blocklist-update`, `blocking-disable`
  endrer tilstand — spør brukeren før kjøring.
- **Obsolete stier:** docsen lister gamle aliaser (`/api/listBlockedZones` osv.). Bruk de kanoniske stiene over.
