# InspectStack Workflow

Inspiser docker-verten og Portainer-stacks: hva kjører, hvilke versjoner, og avdekk
stale on-disk-filer.

Load context: `SkillSearch('dockerportainer api')` og `SkillSearch('dockerportainer pitfalls')`

## Steps

1. **Portainer API tilgjengelig?** Verifiser `.env` har `PORTAINER_API_URL` + `PORTAINER_API_KEY`:
```bash
curl -s -H "X-API-Key: $(grep PORTAINER_API_KEY ~/.opencode/.env | cut -d= -f2)" \
  "$(grep PORTAINER_API_URL ~/.opencode/.env | cut -d= -f2)/api/status"
```

2. **List stacks:**
```bash
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py list
```

3. **Faktisk kjørende containere + versjoner (via ssh, ingen secrets):**
```bash
ssh docker 'docker ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}"'
```

4. **For en spesifikk stack — sammenlign on-disk vs Portainer vs kjørende:**
```bash
# Portainer sin compose (source of truth)
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py file <id>

# Maskert env
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py show <id>

# Mount-punkter (avdekker aktive on-disk-stier)
ssh docker 'docker inspect <container> \
  --format "{{range .Mounts}}{{.Source}} => {{.Destination}}{{println}}{{end}}"'
```

5. **Rapporter** i tabell:

```
📊 DOCKER-VERT (<IP>, VM <vmid>)
Stack           Status   Kjørende image          On-disk tag      Stale?
──────────────────────────────────────────────────────────────────────
authentik       1        server:2026.8.1         2025.10.3        ⚠️ JA
nextcloud       1        nextcloud:33-apache     32-apache        ⚠️ JA
...
```

6. **Flagg:**
   - Stale on-disk-tags (nedgraderingsrisiko) → foreslå `UpgradeStack` eller rydding.
   - Aktive bind-mounts til `/opt/stacks/` → IKKE slett katalogen (se `KnownPitfalls.md` #2).
   - Containere utenfor Portainer (f.eks. LibreChat) → merk som direkte-disk.

## Pass-signal

- Alle stacks listet med kjørende versjon.
- Eventuelle stale on-disk-tags eksplisitt flagget.
- Aktive bind-mounts identifisert før noen rydding foreslås.
