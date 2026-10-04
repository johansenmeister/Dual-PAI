# UpgradeStack Workflow

Oppgrader en Portainer-stack trygt: backup-gate → breaking-change-sjekk → API-oppdatering
→ redeploy → verifisering.

**Regel:** ALDRI on-disk `docker compose up -d`. Alltid Portainer API/UI. Se `KnownPitfalls.md` #1.

## Steps

1. **Identifiser stack + nåværende versjon:**
```bash
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py list
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py file <id>
ssh docker 'docker ps --format "{{.Names}}\t{{.Image}}"' | grep <tjeneste>
```

2. **Backup-gate:** Verifiser fersk PBS-backup av Docker-VM-en (VMID og node i `PAI/USER/INFRASTRUCTURE.md`).
```bash
set -a; source ~/.opencode/.env; set +a
curl -sk -H "Authorization: PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}" \
  "${PROXMOX_API_URL}/nodes/<node>/tasks?limit=50" | python3 -c "
import sys,json
for r in json.load(sys.stdin)['data']:
    if r.get('type')=='vzdump': print(r.get('starttime'), r.get('status'))
"
```
Jobben som dekker VM-en, står i `PAI/USER/INFRASTRUCTURE.md`. Bekreft siste kjøring OK.

3. **Release-noter — sjekk breaking changes.** Generelle klasser å se etter:
   - Reverse proxy / trusted proxy / X-Forwarded-endringer (se `KnownPitfalls.md` #4).
   - Endrede/nye/fjernede env-variabler.
   - Sekvensiell oppgradering (hopp aldri over major-versjon).
   - **Tjeneste-spesifikke krav** (f.eks. nye påkrevde env-vars) står i tjenestens
     runbook under `runbooks/arkiv/homelab/tjenester/`.

4. **Verifiser full stack-compose** (flere services kan restartes):
```bash
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py file <id>
```
Sjekk `depends_on` og alle services — ikke bare én.

5. **Verifiser/korriger nødvendige env-vars** FØR bump. Hvilke variabler og verdier
   som kreves er **tjeneste-spesifikt** — se tjenestens runbook. Generelt:
```bash
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py show <id>
# ved behov (KEY=VALUE fra tjenestens runbook):
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py \
  setenv <id> KEY=VALUE
```

6. **Bump image-tag(er) + redeploy:**
```bash
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py \
  bump <id> "<gammel-tag>" "<ny-tag>" --pull
```
Ved flere forekomster (server + worker) bytter `replace` alle samtidig.

7. **Vent + verifiser (PUT er asynkron):**
```bash
sleep 20
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py health --filter <tjeneste>
```
Forventet: nye image-tags, `healthy`/`Up`.
**OBS:** PUT 200 = deploy *startet*, ikke fullført (se `KnownPitfalls.md` #5). Store images
(~2 GB) kan bruke 1-2 min på pull før recreate. Ikke stol på fast `sleep` — poll
`docker ps` til både image-tag **og** `CreatedAt` er endret.

8. **Funksjonell verifisering:**
   - Tjenestens helse-endepunkt (`curl -I` / `/status.php` / `/health/live/`).
   - Reverse-proxyet URL (via NPM) → riktig HTTP-status (302/200, ikke endless-loading).
   - Der det er trygt: be bruker bekrefte faktisk innlogging/funksjon.

9. **Oppdater runbook** med ny versjon — nå-tilstand, ingen endringslogg (git er loggen).

## Pass-signal

- Ny versjon bekreftet via `docker inspect` (ikke bare Portainer-UI).
- Alle containere i stacken `healthy`.
- Tjenesten svarer korrekt gjennom reverse proxy.
- Runbook oppdatert.
