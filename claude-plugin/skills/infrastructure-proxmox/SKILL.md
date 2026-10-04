---
# GENERERT av Tools/BuildClaudePlugin.ts — ikke rediger.
# Kilde: .opencode/skills/Infrastructure/Proxmox/SKILL.md
# Endringer hører hjemme i kilden; kjør deretter generatoren på nytt.
name: infrastructure-proxmox
description: Proxmox VE cluster administrasjon og overvåking. USE WHEN proxmox, pve, proxmox cluster, sjekk proxmox, proxmox status, hvilke VM-er kjører, VM status, LXC status, proxmox storage, proxmox tasks.
---

## Customization

**Before executing, check for user customizations at:**
`~/.opencode/PAI/USER/SKILLCUSTOMIZATIONS/Proxmox/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

# Proxmox

Overvåk og administrer Proxmox VE cluster: node-helse, VM/LXC-status, storage, og tasks.

**Tilgang:** PVEAuditor (read-only API-token) — kun GET-operasjoner.

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **ClusterStatus** | "sjekk proxmox", "proxmox status", "hvordan går det med proxmox", "cluster status" | `Workflows/ClusterStatus.md` |
| **ResourceList** | "hvilke VM-er kjører", "vis alle containere", "proxmox ressurser", "VM oversikt", "LXC liste" | `Workflows/ResourceList.md` |
| **StorageStatus** | "proxmox storage", "sjekk lagring proxmox", "diskbruck proxmox", "hvor mye plass er det" | `Workflows/StorageStatus.md` |

## Quick Reference

- **API base:** Leses fra `~/.opencode/.env` (`PROXMOX_API_URL`, `PROXMOX_TOKEN_ID`, `PROXMOX_TOKEN_SECRET`)
- **Autentisering:** `Authorization: PVEAPIToken={USER}@{REALM}!{TOKENID}={SECRET}`
- **Base URL:** `PROXMOX_API_URL`, typisk `https://<node>:8006/api2/json`; nodenavnene står i `PAI/USER/INFRASTRUCTURE.md`
- **Roller:** PVEAuditor — `Sys.Audit`, `VM.Audit`, `Datastore.Audit` (read-only)
- **SSL:** Selvsignert — bruk `-k` i curl
- **API-referanse:** `SkillSearch('proxmox api')`
- **Runbook:** `~/repos/pai-opencode/runbooks/arkiv/homelab/proxmox/`
- **Infrastruktur-oversikt:** `~/repos/pai-opencode/runbooks/arkiv/homelab/infrastruktur-oversikt.md`

## Examples

**Example 1: Kjapp status**
```
User: "Sjekk proxmox"
→ Invokes ClusterStatus workflow
→ Henter cluster health, node status, ressursoversikt
→ Returnerer strukturert rapport med advarsler
```

**Example 2: VM-oversikt**
```
User: "Hvilke VM-er kjører på pve?"
→ Invokes ResourceList workflow
→ Lister VMer på pve med CPU, RAM, disk, oppetid
→ Viser stopped VMer separat
```

**Example 3: Storage-sjekk**
```
User: "Hvor mye plass er det igjen på proxmox?"
→ Invokes StorageStatus workflow
→ Viser alle storage pools med bruk/ledig
→ Marker pools med >80% full
```
