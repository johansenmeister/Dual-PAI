# RotateSecret Workflow

Roter en hemmelighet som er brukt i en Portainer-stack — generelt og trygt. Se
`KnownPitfalls.md` for fellene.

**Gullregel:** Les aldri hemmeligheten i klartekst for å "verifisere". Verifiser funksjon,
ikke verdi. Å dumpe secrets tvinger frem ny rotasjon.

## Den viktigste innsikten: én hemmelighet, flere steder

En hemmelighet finnes sjelden på ett sted. Typiske mønstre:

- **Compose-environment** i Portainer-stacken (`JWT_SECRET`, `POSTGRES_PASSWORD`, ...)
- **Applikasjonens egen konfig** (database, app-config, `.env` inne i en container)
- **Motparten i en integrasjon** — to tjenester som må dele SAMME verdi for å
  autentisere mot hverandre

Hvis hemmeligheten deles mellom to tjenester, **må begge sider oppdateres**. Endres kun
den ene, bryter integrasjonen.

## Steps

1. **Identifiser ALLE steder hemmeligheten brukes.** Les stack-composen og appens
   konfig. Dokumentér hvert sted før du endrer noe.

2. **Kartlegg uten å lese verdiene:**
```bash
# Env-navn i stacken (maskert)
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py show <id>

# Applikasjonskonfig (mange apper maskerer secrets selv)
ssh docker 'docker exec <container> <app-cli> ...'
```
Aldri `cat`/`grep` en fil med secrets for å verifisere verdien.

3. **Generer ny hemmelighet:**
```bash
openssl rand -hex 32
```

4. **Oppdater compose-siden** via Portainer UI («Edit stack» → environment) eller API.
   Unngå secrets i argv — bruk UI, eller et lokalt script som leser en fil.

5. **Oppdater alle app-/motparts-sider** med den **samme** verdien.

6. **Rekkefølge-advarsel:** Er hemmeligheten delt mellom tjenester, sett begge sider
   **før** du tester. En midlertidig mismatch gir auth-feil.

7. **Redeploy** de berørte stackene:
```bash
python3 ~/.opencode/skills/Infrastructure/DockerPortainer/Tools/PortainerApi.py deploy <id>
```

8. **Verifiser funksjon — ikke verdi:**
   - Containerne er `healthy`.
   - Integrasjonen svarer (funksjonell test).
   - HTTP-helse-endepunkter OK.

9. **Dokumenter** i tjenestens runbook (hvilke steder hemmeligheten finnes, slik at neste
   rotasjon går raskt).

## Konkrete tjeneste-oppskrifter

Se tjenestens runbook under `runbooks/arkiv/homelab/tjenester/` for de eksakte stedene
og kommandoene for hver tjeneste. Eksempler:

- Nextcloud + OnlyOffice (delt JWT-secret) → `tjenester/nextcloud.md`

## Pass-signal

- Hemmeligheten finnes ikke lenger i klartekst noe sted.
- Alle steder (compose + app + motpart) bruker samme nye verdi.
- Funksjonell test gjennomført av bruker.
- Aldri lest/printet selve hemmeligheten i kontekst.
