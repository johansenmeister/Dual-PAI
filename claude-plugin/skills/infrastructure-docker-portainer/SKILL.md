---
# GENERERT av Tools/BuildClaudePlugin.ts — ikke rediger.
# Kilde: .opencode/skills/Infrastructure/DockerPortainer/SKILL.md
# Endringer hører hjemme i kilden; kjør deretter generatoren på nytt.
name: infrastructure-docker-portainer
description: Docker-vert og Portainer-stack administrasjon — inspect, oppgrader, migrer bind-mounts, roter secrets. USE WHEN portainer, docker stack, oppgrader stack, bump image, hvilken versjon kjører docker, stack status, migrer bind-mount, flytt bind-mount til volum, rydd root-disk, roter secret, bytt jwt_secret, secrets i compose, docker node.
---

## Customization

**Before executing, check for user customizations at:**
`~/.opencode/PAI/USER/SKILLCUSTOMIZATIONS/DockerPortainer/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If not, proceed with skill defaults.

# DockerPortainer

Administrer **Docker-verten** (SSH-aliaset `docker`; VM-en og adressen står i `PAI/USER/INFRASTRUCTURE.md`) og tjenestene som kjører som **Portainer-stacks**.

**Tilgang:** `ssh docker` (aliaset i `~/.ssh/config`, eller `DOCKER_SSH_HOST` i `~/.opencode/.env`), `sudo` tilgjengelig. Portainer API via `PORTAINER_API_URL` + `PORTAINER_API_KEY` i `~/.opencode/.env` (admin).

## 🚨 Den viktigste regelen

**Portainer er source of truth — IKKE on-disk compose.**

On-disk filer under `/opt/stacks/` kan være **stale** og ha gamle image-tags. Å kjøre
`docker compose up -d` der kan **nedgradere** en produksjonstjenest. Oppdateringer skjer
via **Portainer UI eller API** (`PUT /api/stacks/{id}`).

**Unntak:** LibreChat (`/opt/LibreChat/`) kjører **direkte fra disk**, ikke Portainer.

Se `KnownPitfalls.md` for detaljer.

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **InspectStack** | "stack status", "hvilken versjon kjører", "docker status", "portainer stacks", "sjekk stack" | `Workflows/InspectStack.md` |
| **UpgradeStack** | "oppgrader stack", "bump image", "oppgrader tjeneste", "portainer oppgrader" | `Workflows/UpgradeStack.md` |
| **MigrateBindMount** | "migrer bind-mount", "flytt bind-mount til volum", "rydd root-disk", "consolidate volume" | `Workflows/MigrateBindMount.md` |
| **RotateSecret** | "roter secret", "bytt jwt_secret", "secrets i compose", "hardkodet passord" | `Workflows/RotateSecret.md` |

## Quick Reference

- **Docker-vert:** `ssh docker` — VM, node og IP i `PAI/USER/INFRASTRUCTURE.md`
- **Portainer API:** `PORTAINER_API_URL` — auth via `X-API-Key`-header
- **API-verktøy:** `Tools/PortainerApi.py` — les/oppdater/redeploy stacks (ALDRI secrets i argv)
- **Reverse proxy:** NPM (`npm-app`) kjører **på docker-noden selv**, ikke på
  en egen `deb-npm`-vert lenger (migrert — se `KnownPitfalls.md` #4). Proxyer via delt
  Docker-nettverk `npm_proxy`, ikke via host-port.
- **Backup:** PBS-jobben som dekker VM-en, står i `PAI/USER/INFRASTRUCTURE.md`
- **Stack-IDs:** se `PortainerApi.md`
- **Runbooks:** `~/repos/pai-opencode/runbooks/arkiv/homelab/proxmox/cluster-vm-og-lxc-info/docker/README.md` · `~/repos/pai-opencode/runbooks/arkiv/homelab/tjenester/authentik.md`
- **Kjente feller:** `SkillSearch('dockerportainer pitfalls')` → `KnownPitfalls.md`
- **API-detaljer:** `SkillSearch('dockerportainer api')` → `PortainerApi.md`

## Examples

**Example 1: Sjekk hva som kjører**
```
User: "hvilken versjon av authentik kjører vi?"
→ Invoke InspectStack
→ Henter stack + kjørende image via Portainer API + docker inspect
→ Rapporterer faktisk versjon vs on-disk (avdekker stale)
```

**Example 2: Oppgrader en stack**
```
User: "oppgrader authentik til siste versjon"
→ Invoke UpgradeStack
→ Backup-gate → verifiser breaking changes i release-noter
→ Oppdater tag + env via Portainer API → redeploy → verifiser helse
```

**Example 3: Flytt data fra root-disk**
```
User: "nextcloud-data på root-disken må flyttes til datavolumet"
→ Invoke MigrateBindMount
→ Stopp tjeneste → kopier inn i volum → fjern bind-mount-linjer → redeploy → verifiser
```

**Example 4: Fjern hardkodet hemmelighet**
```
User: "JWT_SECRET ligger i klartekst i compose"
→ Invoke RotateSecret
→ Generer ny → sett i BEGGE ender samtidig → verifiser → dokumenter
```
