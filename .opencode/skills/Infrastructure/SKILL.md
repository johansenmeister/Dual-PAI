---
name: Infrastructure
description: Drift av homelaben. USE WHEN portainer, docker stack, proxmox, pve, VM status, technitium, dns status, truenas, NAS status.
metadata:
  personal: "true"
---

# Infrastructure - drift av homelaben

**Kategori for skillene som drifter maskinene og tjenestene i laben.** Verdiene
(verter, adresser, nøkler) kommer fra miljøet og `~/.opencode/.env`, aldri fra
skill-treet. Hvor dokumentasjonen skrives, står i `PAI/USER/INFRASTRUCTURE.md`.

## Skills in This Category

| Skill | Purpose | Trigger |
|-------|---------|---------|
| **DockerPortainer** | Docker-verten og Portainer-stackene: inspiser, oppgrader, migrer bind-mounts | "portainer", "oppgrader stack", "bump image" |
| **Proxmox** | Proxmox VE-clusteret: VM-er, LXC, lagring, oppgaver | "proxmox status", "hvilke VM-er kjører" |
| **Technitium** | Technitium DNS: status, blokkering, cache | "dns status", "er domenet blokkert" |
| **TrueNAS** | TrueNAS Scale via WebSocket-API: pools, datasets, shares, SMART | "NAS status", "TrueNAS pools" |

## When to Use

- Spørsmål om eller endringer i laben: nettverk, servere, lagring og tjenester
- Drift og vedlikehold: oppdateringer, reboots, rotasjon av hemmeligheter
- Feilsøking og trusselanalyse mot de eksponerte tjenestene

## Category Philosophy

Les før du skriver: sjekk tilstanden før en endring, og foretrekk skillens
read-only-veier. En endring som kan ta ned en tjeneste, bekreftes med brukeren
først.

## Customization

**Before executing, check for user customizations at:**
`~/.opencode/PAI/USER/SKILLCUSTOMIZATIONS/Infrastructure/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there.
