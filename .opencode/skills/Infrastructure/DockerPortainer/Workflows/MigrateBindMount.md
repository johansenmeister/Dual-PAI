# MigrateBindMount Workflow

Flytt bind-mount-data fra et on-disk-sted (ofte root-disken) inn i et Docker-volum, fjern
bind-mount-linjene, og verifiser — generelt for enhver Portainer-stack. Se
`KnownPitfalls.md` #2 og #3.

**Forutsetning:** Du har allerede avdekket at bind-mounten peker på en on-disk-sti og at
volumets tilsvarende mappe er tom (se `InspectStack` + steg 1 under).

> **Tjeneste-spesifikke detaljer** (riktig eier, hvilke mapper, verifiseringssteg) hører i
> tjenestens runbook under `runbooks/arkiv/homelab/tjenester/`. Denne workflowen er den
> generiske metoden; runbooken er den konkrete oppskriften.

## Steps

1. **Forstå overlay-fella:** List volumets SANNE innhold direkte på host (via container ser
   du bare bind-mounten):
```bash
sudo ls -la /var/lib/docker/volumes/<volum>/_data/<mappe>/
```
Forventet: tom eller uten konflikt. Hvis ikke tom → STOPP, planlegg flette-strategi.

2. **Verifiser at ingen andre containere bruker kilden:**
```bash
ssh docker 'docker ps --format "{{.Names}}" | while read c; do
  m=$(docker inspect "$c" --format "{{range .Mounts}}{{.Source}} {{end}}");
  echo "$m" | grep -q "<kilde-sti>" && echo "BRUKER: $c";
done'
```

3. **Backup-gate:** bekreft fersk PBS-backup av Docker-VM-en (se `UpgradeStack.md` steg 2).

4. **Stopp tjenesten** (unngå skriv under kopiering):
```bash
ssh docker 'docker stop <container>'
```

5. **Kopier data inn i volumet og rett eierskap:**
```bash
ssh docker '
  VOL=/var/lib/docker/volumes/<volum>/_data
  sudo cp -a <kilde>/. "$VOL/<mappe>/"
  sudo chown -R <eier>:<gruppe> "$VOL/<mappe>"   # riktig eier — sjekk tjenestens runbook
'
```
⚠️ `chown` er ikke valgfritt — feil eierskap krasjer tjenesten. Riktig eier finnes i
tjenestens runbook (ofte den brukeren prosessen i containeren kjører som).

6. **Verifiser kopien** (størrelse + nøkkelfiler):
```bash
sudo du -sh "$VOL/<mappe>"
sudo ls -la "$VOL/<mappe>/" | head
```

7. **Fjern bind-mount-linjene fra Portainer-composen:**
```bash
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py file <id> > /tmp/compose.yml
# rediger: fjern linjene med kilde-stien
# PUT tilbake via et lite script som leser Env fra GET (se Tools/PortainerApi.py som mal)
```
Alternativt: gjør det i Portainer UI → Edit stack → fjern linjene → Deploy.

8. **Redeploy**:
```bash
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py deploy <id>
# eller PUT med StackFileContent direkte
```

9. **Verifiser at mount-ene er borte og tjenesten leser fra volumet:**
```bash
ssh docker 'docker inspect <container> \
  --format "{{range .Mounts}}{{.Source}} => {{.Destination}}{{println}}{{end}}"'
# kilde-stien skal IKKE vises lenger
```

10. **Funksjonell verifisering** (helse-endepunkt, offentlig URL, aktiv klienttrafikk).

11. **Fjern de gamle on-disk-mappene** — KUN etter vellykket verifisering, og etter at
    bruker har godkjent (permanent sletting):
```bash
ssh docker 'cd <foreldre-dir> && sudo rm -r <mappe1> <mappe2>'
```

12. **Oppdater runbook** (tjenestens README/runbook + docker/README.md) til nå-tilstand —
    ingen endringslogg (git er loggen).

## Pass-signal

- Mount-liste viser kun volumet (+ eventuelle legitime ekstra-mounts).
- Tjenestens nøkkelfiler (config/apper) leses fra volumet.
- Helse + funksjonell test OK.
- Frigjort plass på den gamle disken bekreftet (`df -h`).
