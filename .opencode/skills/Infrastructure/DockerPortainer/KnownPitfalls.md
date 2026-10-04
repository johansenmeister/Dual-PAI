# KnownPitfalls — verifiserte feller på docker-verten

Alle punkter nedenfor er **verifisert i produksjon** (2026-09-03 og tidligere). Ikke anta
noe generelt — sjekk hver sak konkret.

## 1. On-disk compose er ofte stale (nedgraderingsfella)

Portainer lagrer sin egen compose-kopi i `/data/compose/{id}/docker-compose.yml`
(i `portainer_data`-volumet), uavhengig av `/opt/stacks/*`.

- On-disk filer kan ha **gammel image-tag**.
- Å kjøre `docker compose up -d` fra on-disk kan **nedgradere** tjenesten.
- **Verifisert eksempel:** authentik on-disk = `2025.10.3`, Portainer kjørte `2026.5.3`.
- **Regel:** oppdater alltid via Portainer UI/API. Verifiser faktisk kjørende image
  med `docker inspect`, ikke on-disk fil.

## 2. Ikke alle on-disk kataloger er stale

Selv en Portainer-managed stack kan **bind-mounte absolutte on-disk-stier** for data.

- **Verifisert eksempel:** nextcloud (stack 12) mountet `/opt/stacks/nextcloud/{apps,config,themes}`
  inn i containeren. Disse var **aktive** (custom apps, `config.php`), selv om compose
  lå i Portainer.
- **Regel:** før du sletter on-disk kataloger, sjekk **faktiske mount-punkter**:
  ```bash
  docker inspect <container> --format "{{range .Mounts}}{{.Source}} => {{.Destination}}{{println}}{{end}}"
  ```
- Sjekk alle kjørende containere for treff før du rører en katalog.

## 3. Bind-mounts skygger volumets mapper (overlay-fella)

Hvis en bind-mount peker på `/var/www/html/config` og volumet også har en `config`-mappe,
så **skygger bind-mounten** volumets innhold. Å liste gjennom containeren viser
bind-mounten, ikke volumet.

For å se volumets **sanne** innhold må du lese direkte på host:
```bash
sudo ls -la /var/lib/docker/volumes/<volum>/_data/<mappe>/
```
**Verifisert:** `nextcloud_nextcloud_data` sine `config`/`custom_apps`/`themes` var **tomme**,
mens bind-mountene hadde alt innholdet. Ingen kollisjon ved migrering.

## 4. Reverse proxy + TRUSTED_PROXY_CIDRS (major-oppgraderingsfelle)

Tjenester bak NPM er 100% avhengige av at reverse-proxyens IP er i
`AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS` (eller tilsvarende for andre tjenester).

- **Breaking change (authentik 2026.8):** X-Forwarded-* headere stoles kun på fra
  trusted proxy-nettverk. Uten riktig CIDR tolkes HTTPS som HTTP → mixed-content /
  endless-loading / auth-feil for **alle** integrasjoner.
- **NPM kjører nå på samme vert (`docker`, stack `npm` id 35).** Den når authentik
  via vertens IP, `<docker-vert>:9001`, og kilden SNAT-es til authentik-nettets gateway —
  authentik ser `remote=172.21.0.1`, **ikke** verten. Derfor må trusted-proxy være
  `<docker-vert>/32,172.21.0.1/32,172.27.0.1/32`. (Før migreringen så authentik den gamle NPM-verten.)
- **Symptom ved feil:** authentik-loggen viser `scheme=http` for `domain_url=auth.<domene>`
  → mixed-content i SPA-en.
- **Regel:** les release-notene for breaking changes om reverse proxy FØR du bumper.

## 10. NPM: conf regenereres ikke ved restart — skiller UI/API fra direkte DB-endring

- NPM genererer `proxy_host/*.conf` fra `database.sqlite` **når endringen gjøres via UI/API**.
- **Direkte DB-endring regenererer IKKE conf:** `docker restart npm-app` skriver ikke conf på
  nytt — loggen viser bare «Enabling IPV6 in hosts» + «Starting nginx» på eksisterende filer.
- **Verifisert 2026-09-19 (npm_proxy-migreringen):** etter
  `update proxy_host set forward_host='homebox'...` via `better-sqlite3` + `docker restart npm-app`
  sto `proxy_host/20.conf` fortsatt på `<docker-vert>:3100` → `502`. Restart var utilstrekkelig.
- **Verifisert 2026-09-19 (grafana.<domene>):** UI/DB korrekt mens conf var stale → `504`;
  der var conf regenerert av UI-saven, men nginx ikke reloadet — restart løste.
- **Regel:** stemmer ikke oppførselen — **patch conf direkte** (`set $server`/`set $port`) **og**
  hold DB i sync, deretter:
  ```bash
  docker exec npm-app nginx -t && docker exec npm-app nginx -s reload
  docker exec npm-app grep -E 'set \$server|set \$port' /data/nginx/proxy_host/<id>.conf
  ```
  Å endre kun via UI/API er tryggest (regenererer conf), men krever NPM-innlogging.

## 5. Portainer API: PUT lagrer, men deploy kan kollidere

- `PUT /api/stacks/{id}` (med `StackFileContent` + `Env`) lagrer og starter deploy.
- **PUT 200 = deploy startet, IKKE fullført.** Verifisert 2026-09-12 (authentik 2026.8.2,
  ~1.9 GB image): containerne kjørte fortsatt gammel tag ~1 min etter PUT. Poll
  `docker ps` (image-tag + `CreatedAt`) til recreate er observert — ikke anta ferdig.
- Et nytt redeploy-kall rett etterpå gir `409 "deployment already in progress"` —
  **ikke** en feil; vent og sjekk `docker ps`.
- `GET /api/stacks/{id}` returnerer **tom** `StackFileContent` — bruk `/file`.
- `Env` må sendes komplett for ikke å miste variabler.

## 6. Secrets i klartekst i compose

- Nextcloud-stacken hadde `NEXTCLOUD_ADMIN_PASSWORD`, `POSTGRES_PASSWORD` og
  `JWT_SECRET=ChangeThisToASecureRandomString123!` (OnlyOffice sin **default**) i compose.
- **JWT-secret må matche på to steder:** OnlyOffice-containerens `JWT_SECRET` (compose)
  og Nextcloud-appens `jwt_secret` (i Nextcloud, IKKE compose). Endres den ene, må den
  andre endres samtidig, ellers bryter dokumentredigering.
- **Les aldri** secrets via `docker inspect`/API for å verifisere. Verifiser funksjon.

## 7. LibreChat kjører ikke via Portainer

- `com.docker.compose.project.config_files: /opt/LibreChat/docker-compose.yml`
- Deployes **direkte fra disk** (working_dir `/opt/LibreChat`).
- Dens `.env`, `librechat.yaml`, `uploads` m.fl. er aktive mount-punkter — rør ikke.

## 8. Restart-policy og rekkefølge

- `depends_on` betyr at redeploy av én stack-service kan restarte flere
  (nextcloud-stacken: nextcloud + redis + onlyoffice).
- Sjekk hele stacken sin compose før redeploy, ikke bare én service.

## 9. containerd på root-disk (historisk)

- containerd `root` må peke på `/var/lib/docker/containerd` (200G-disken), ikke
  `/var/lib/containerd` (root). Se `docker/README.md`.

## 11. `setenv` virker kun for `${VAR}`-substitusjon, ikke hardkodede verdier

- `Tools/PortainerApi.py setenv` skriver til Portainer sitt `Env`-array (brukt til
  `${VAR}`-substitusjon i compose). Hvis stacken **hardkoder** verdier direkte i
  `environment:`-lista (vanlig mønster her, se pitfall #6), gjør `setenv` **ingenting**
  — `PUT` gir `200`, "Deploy startet", men compose-filens innhold er uendret, så
  `docker compose up` finner ingen diff og recreater ikke containeren.
- **Verifisert 2026-09-28** (tandoor-stacken): `setenv` for `EMAIL_HOST` m.fl. ga
  `PUT status 200`, men `docker inspect` viste uendret `StartedAt` og tomme env-verdier
  inne i containeren etterpå.
- **Regel:** for hardkodede stacker, hent `/file`, rediger selve `environment:`-lista,
  og `PUT` hele den nye `StackFileContent`-en. Bruk `setenv` kun når verdien faktisk
  refereres som `${KEY}` et sted i compose-filen — sjekk med `grep '\${KEY}' <fil>` først.

## 12. JSON i en compose `environment:`-verdi må hel-quotes, ikke bare verdien

- En linje som `- SOCIALACCOUNT_PROVIDERS={"a": "b"}` er en **plain YAML-scalar** som
  starter med `S`, ikke `{` — anførselstegn midt i strengen er bare bokstaver for YAML,
  ikke quoting. `: `-sekvensen inni JSON-en tolkes da som en (feilplassert) block
  mapping-nøkkel → `ParserError: expected <block end>, but found '}'`.
- **Feil fiks:** kun å quote verdien (`- KEY='{"a": "b"}'`) løser IKKE dette — quoting må
  starte helt i begynnelsen av scalaren for å telle.
- **Riktig fiks:** quote **hele** `KEY=verdi`-paret: `- 'SOCIALACCOUNT_PROVIDERS={"a": "b"}'`.
- **Verifiser alltid** en generert compose-fil med `python3 -c "import yaml; yaml.safe_load(open('fil'))"`
  før `PUT` — og for JSON-holdige env-verdier, parse verdien som JSON også, ikke bare YAML.

## 13. Doc-sider for selvhostede apper kan være upålitelige — verifiser i containeren

- `docs.tandoor.dev` ga `503`/`404` og generiske/uklare svar for eksakt OIDC
  callback-sti og `SOCIALACCOUNT_PROVIDERS`-skjema.
- **Ground truth fantes i containeren:** `docker exec <container> find / -path
  "*allauth/socialaccount/providers/<provider>*" -name urls.py` ga eksakt
  URL-mønsteret (og default-prefiks) direkte fra kildekoden — raskere og mer pålitelig
  enn å stole på doc-fetch for en selvhostet app med sparsom/skiftende dokumentasjon.
- **Regel:** når offisiell dokumentasjon for en kjørende container er tvetydig, les
  `urls.py`/`settings.py`/`app_settings.py` direkte i containeren før du gjetter.

## 14. Å legge en bruker til et space/tenant er ikke det samme som eierskap

- Mange DRF-permission-klasser sjekker et eget **owner-felt** på tenant-objektet
  (f.eks. Tandoor sin `cookbook_space.created_by_id`), helt uavhengig av
  medlemskaps-/rolletabeller (`UserSpace`, grupper som guest/user/admin).
- **Verifisert 2026-09-28:** etter å ha flyttet en SSO-koblet bruker inn i et
  eksisterende space og gjort den til admin-gruppe, feilet invite-link-oppretting
  fortsatt med `403` — fordi `CustomIsSpaceOwner` sjekket
  `space.created_by == request.user`, og `created_by` pekte fortsatt på den gamle
  (deaktiverte) kontoen.
- **Regel:** ved kontosammenslåing/SSO-migrering i en app med multi-tenant-modell,
  finn **alle** owner-/created_by-FK-er på tenant-objektet — ikke bare
  medlemskapsraden — før du antar tilgangen er komplett. Søk permission-klassene i
  koden (`grep -rn "created_by ==" `) fremfor å anta rolletabellen er hele historien.
