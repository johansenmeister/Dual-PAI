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
- **`CheckStackForUpdate` er et skrivekall.** Skillen kan ikke tvinge en sjekk; brukeren
  trykker på knappen i UI-et.
- **`deployed_hash` ≠ `latest_hash`** betyr at git har en nyere commit enn den som er
  deployet. Det er ikke det samme som et nytt image.
- **En versjonstagg kan ha en annen digest enn `latest`.** Finn taggen etter digest
  før et image pinnes, ellers blir det en ny container med andre bits.
- **Endrede nettverkslabels** får Compose 5.x til å gjenskape nettverket, og alle
  containerne på det.

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
