---
# GENERERT av Tools/BuildClaudePlugin.ts — ikke rediger.
# Kilde: .opencode/skills/Infrastructure/TrueNAS/SKILL.md
# Endringer hører hjemme i kilden; kjør deretter generatoren på nytt.
name: infrastructure-true-nas
description: TrueNAS Scale administrasjon og overvåking via WebSocket API. USE WHEN truenas, NAS status, sjekk NAS, NAS lagring, NAS disker, TrueNAS pools, TrueNAS datasets, SMB shares, NFS shares, SMART status NAS, TrueNAS alerts, TrueNAS konfigurasjon, NAS analyse.
---

## Customization

**Before executing, check for user customizations at:**
`~/.opencode/PAI/USER/SKILLCUSTOMIZATIONS/TrueNAS/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

# TrueNAS

Overvåk og analyser TrueNAS Scale: systeminfo, pools, disker, datasets, shares, SMART-status, og varsler.

**Tilgang:** Readonly Admin (API-nøkkel for `pai-api`) — kun leseoperasjoner.
**Protokoll:** JSON-RPC 2.0 over WebSocket (REST er deprecated i Fangtooth 25.04+).

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **CheckStatus** | "sjekk NAS", "NAS status", "TrueNAS status", "hvordan går det med NAS-en", "trueNAS helse" | `Workflows/CheckStatus.md` |
| **StorageAnalysis** | "NAS lagring", "TrueNAS pools", "sjekk diskbruk NAS", "hvor mye plass er det på NAS", "NAS disker", "SMART status", "dataset oversikt" | `Workflows/StorageAnalysis.md` |

## Quick Reference

- **Protokoll:** JSON-RPC 2.0 over WebSocket — `wss://<vert>/api/current`, utledet fra `TRUENAS_API_URL`
- **Autentisering:** `auth.login_ex` med `mechanism: "API_KEY_PLAIN"`, `username: "pai-api"`
- **Credentials:** Leses fra `~/.opencode/.env` (`TRUENAS_API_URL`, `TRUENAS_API_KEY`)
- **Script:** `Scripts/trueNasApi.ts` — ALL datainnhenting går via dette. Modellen gjør aldri egne WebSocket-kall mot TrueNAS.
- **Klient:** Bun native WebSocket — ingen eksterne avhengigheter
- **Tilgang:** Readonly Admin — kun `CALL` metoder, ingen `UPDATE`/`CREATE`/`DELETE`
- **Versjon:** TrueNAS 25.04.2 Fangtooth (Community Edition)
- **Host:** fra `TRUENAS_API_URL` i `~/.opencode/.env`; hva NAS-en heter, står i `PAI/USER/INFRASTRUCTURE.md`
- **API-referanse:** `SkillSearch('truenas api')`
- **API-dokumentasjon:** TrueNAS web UI → API Docs eller `https://<vert>/api/docs/`

## Authenticated Call Pattern

Alle API-kall følger dette mønsteret (Bun WebSocket):

```typescript
const ws = new WebSocket('wss://<vert>/api/current');
// Send auth.login_ex først, vent på SUCCESS, send deretter operasjonen
```

Dokumentert i `TrueNasApi.md`.

## Examples

**Example 1: Kjapp status**
```
User: "Hvordan går det med NAS-en?"
→ Invokes CheckStatus workflow
→ Henter systeminfo, pools, oppetid, varsler
→ Returnerer strukturert statusrapport
```

**Example 2: Storage-sjekk**
```
User: "Hvor mye plass er det igjen på NAS-en?"
→ Invokes StorageAnalysis workflow
→ Viser alle pools med bruk/ledig/total
→ Inkluderer disk-helse fra SMART
```

**Example 3: Disk-sjekk**
```
User: "Sjekk SMART-status på NAS-diskene"
→ Invokes StorageAnalysis workflow med disk-fokus
→ Henter disk temperaturer og SMART-data
→ Marker disker med advarsler
```

## Troubleshooting — kjente problemer

### CatalogSyncFailed (CRITICAL): "Failed to clone 'https://github.com/truenas/apps'"

**Symptom:** `alert.list` viser `CatalogSyncFailed` (CRITICAL). `catalog.trains` returnerer `[]` (tom). `midclt call catalog.sync` feiler på `percent: 5` med `Failed to clone ... Cloning into '...'`.

**Rotårsak (verifisert 2026-09-03):** git 2.39.5 på TrueNAS har en **HTTP/2-bug mot GitHub**. `GET /info/refs` (advertisement) returnerer 200, men `POST /git-upload-pack` (selve data-nedlastingen) feiler — git feiltolker det som 401 og spør om `Username for 'https://github.com'`. Med `GIT_TERMINAL_PROMPT=0` dør det med `fatal: expected flush after ref listing`.

**Feilsøkings-ledetråder:**
- `curl -sI https://github.com/truenas/apps` = 200 (nettverk OK) — IKKE et nettverk/DNS-problem
- `git ls-remote` funker, `git clone` feiler (advertisement vs fetch)
- Selv `octocat/Hello-World` feiler → miljøbasert, IKKE repo-størrelse

**Fiks (MÅ være `--system`, IKKE bare `--global`):**
```bash
git config --system http.version HTTP/1.1
midclt call catalog.sync
```

**Hvorfor `--system`:** `midclt call catalog.sync` kjører via `middlewared` (Python), som **ikke leser root's `~/.gitconfig`**. Kun `/etc/gitconfig` (`--system`) arves av alle git-invokeringer.

**⚠️ Vedvarelse:** `/etc/gitconfig` kan ligge på read-only squashfs og nullstilles ved reboot. Om varselet returnerer etter reboot, sett env på systemd-nivå i stedet:
```bash
mkdir -p /etc/systemd/system/middlewared.service.d
printf '[Service]\nEnvironment=GIT_HTTP_VERSION=HTTP/1.1\n' \
  > /etc/systemd/system/middlewared.service.d/override.conf
systemctl daemon-reload && systemctl restart middlewared
```

**Feil metodenavn å unngå:** `app.catalog_sync_all` og `app.catalog_sync` finnes IKKE (gir `Method does not exist`, -32601). Korrekt metode er **`catalog.sync`** med **0 argumenter**.

**Ikke prøv `rm -rf /mnt/.ix-apps/truenas_catalog`:** det er et eget ZFS-datasett (`Apps/ix-apps/truenas_catalog`), ikke en mappe — gir `Device or resource busy`. Datasettet var aldri problemet.
