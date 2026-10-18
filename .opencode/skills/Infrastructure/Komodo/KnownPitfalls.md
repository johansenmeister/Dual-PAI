# Komodo — kjente fallgruver

## Hemmeligheter

- **«Compose Config» i deploy-loggen er hemmelig.** Steget skriver ut den oppløste
  composen, med verdiene fra env-filene. `komodo.ts` holder det tilbake. Be aldri om å
  få det vist, og les det ikke i UI-et for brukeren.
- **`GetStack`, `GetUpdate` og `Inspect` gir også hemmeligheter** (compose-filene,
  `environment`, TOML-en, `docker inspect`). Derfor går all lesing gjennom `komodo.ts`.
- **Hemmeligheter står aldri i TOML-en til en resource sync**, og aldri i
  stackens Environment-felt. De ligger i en env-fil på verten, oppgitt som tilleggsfil.
- **Database-dumper er hemmelige.** De inneholder alt.

## Env-filene

- **Rekkefølgen:** Komodo kjører `--env-file <tilleggsfiler> --env-file .komodo.env`, så
  Environment-feltet vinner over tilleggsfilene.
- **`.komodo.env` blir liggende** i `run_directory` når Environment-feltet tømmes, og
  sendes fortsatt med. Den gamle verdien vinner da. Fila må slettes på verten.
- **Tilleggsfiler må ha `track: false`.** Ellers leser Komodo fila og viser den i UI-et.

## Oppdateringer

- **Oppdateringsindikatoren er tom etter en restart av Core**, til neste poll. Et tomt
  `update_available` rett etter en restart betyr ikke at alt er oppdatert.
- **`update_available` er alltid false for et image pinnet til digest.** Er tjenesten satt
  til `registry.example.com/app@sha256:…`, holder `update_available` i `komodo.ts stacks`
  og `stack <navn>` seg false helt til digesten endrer seg, selv om utgiveren har sluppet
  nyere versjoner i mellomtiden. «Ingen oppdatering» betyr da bare at digesten er uendret,
  ikke at stacken er på siste versjon — det må sjekkes mot registeret eller utgivelsene. Si
  det til brukeren.
- **`CheckStackForUpdate` er et skrivekall.** Skillen kan ikke tvinge en sjekk; brukeren
  trykker på knappen i UI-et.
- **`deployed_hash` ≠ `latest_hash`** betyr at git har en nyere commit enn den som er
  deployet. Det er ikke det samme som et nytt image.
- **En versjonstagg kan ha en annen digest enn `latest`.** Finn taggen etter digest
  før et image pinnes, ellers blir det en ny container med andre bits.
- **Endrede nettverkslabels** får Compose 5.x til å gjenskape nettverket, og alle
  containerne på det.

## Tilstand

- **En delvis stoppet stack heter «unhealthy», og `restart: always` overlever et stopp.**
  Stoppes bare noen containere i en stack (f.eks. app-containerne) mens andre (database,
  cache) har `restart: always`, viser `komodo.ts stacks`/`stack <navn>` stacken som
  unhealthy, med en status som `exited(n), running(m)` — og containerne med
  `restart: always` starter igjen ved neste reboot av verten, selv om de ble stoppet
  manuelt. Skal en stack ligge stille over tid: stopp hele stacken i Komodo, eller sett
  restart-policyen til `no`/`unless-stopped` i compose, og si det til brukeren i stedet
  for å tolke «unhealthy» som at stacken kjører.

## Deploy-loggen

- **«Compose Up» viser den nøyaktige compose-kommandoen Komodo kjørte.** Steget i
  `komodo.ts update <id>` sin logg har et `command`-felt med kommandoen slik Komodo kjørte
  den (for stacker med files_on_host): `-f`-filene, prosjektnavnet og flaggene. Den kan
  brukes til å forstå eller gjenta en deploy med de samme flaggene. Skillen bare leser
  den — en manuell deploy er brukerens handling, ikke skillens.

## Synken

- **`delete=false` og `managed=false`** er vanlig: synken sletter ikke ressurser som
  forsvinner fra TOML-en, og UI-endringer skrives ikke tilbake til git. En «Delete» i
  diffen skjer derfor ikke før det er slått på.
- **Core styrer ikke seg selv.** Core-stacken står med vilje utenfor synken (ofte med
  `komodo.skip` på containerne). Foreslå ikke å ta den inn.

## Tilgang

- **En API-nøkkel har ikke eget scope.** Den arver alt brukeren kan. Nøkkelen PAI bruker,
  skal høre til en service user som bare kan lese.
- **`km` leser ikke `.env` i PAI-treet.** Uten miljøet feiler den med «Must provide both
  cli_key and cli_secret». `komodo.ts` laster miljøet selv.
