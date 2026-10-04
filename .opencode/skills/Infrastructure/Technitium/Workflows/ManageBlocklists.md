# ManageBlocklists Workflow

Legg til / fjern / importer blokkerte og tillatte domener, og oppdater blocklister.

**Script:** `Scripts/technitiumApi.ts` — ALL datainnhenting går via dette.

> ⚠️ **Write-operasjoner endrer DNS-tilstand.** Bekreft med brukeren før du legger til/fjerner
> blokkeringer på hans vegne. `blocking-disable` slår av ALL blokkering i N minutter — krev
> eksplisitt samtykke.

## Kommandoer

| Handling | Kommando |
|----------|----------|
| Blokker domene | `bun $S blocked-add <domene>` |
| Fjern blokkering | `bun $S blocked-delete <domene>` |
| Tøm hele Blocked-sonen | `bun $S blocked-flush` ⚠️ destruktiv |
| Importer liste (fil eller kommaseparert) | `bun $S blocked-import <fil\|a.com,b.com>` |
| Tillat domene (omgå blokkliste) | `bun $S allowed-add <domene>` |
| Fjern tillatelse | `bun $S allowed-delete <domene>` |
| Tøm hele Allowed-sonen | `bun $S allowed-flush` ⚠️ |
| Tving blocklist-oppdatering nå | `bun $S blocklist-update` |
| Slå av blokkering i N min | `bun $S blocking-disable <minutter>` ⚠️ |

`S=~/.config/opencode/skills/Infrastructure/Technitium/Scripts/technitiumApi.ts`

## Typisk flyt: tillat et domene som er blokkert

1. **Bekreft at det faktisk er blokkert:**
```bash
bun $S --compact resolve <domene> A          # forventet: NxDomain
bun $S --compact export-blocked | grep -i "<domene>"
```
2. **Spør brukeren** (dette endrer sikkerhetsposisjonen).
3. **Tillat:**
```bash
bun $S allowed-add <domene>
```
4. **Verifiser:**
```bash
bun $S --compact resolve <domene> A          # forventet: NoError + Answer
```
Hvis fortsatt NxDomain: `bun $S allowed-add <foreldredomene>` (Allowed matcher hierarkisk)
eller `bun $S cache-flush <domene>`.

## Typisk flyt: blokker et domene

```bash
bun $S blocked-add <domene>
bun $S --compact resolve <domene> A          # forventet: NxDomain
```

## Import fra fil

```bash
# Én domene per linje, og/eller kommaseparert. Kommentarer (#) ignoreres.
bun $S blocked-import /path/to/blocklist.txt
```

## Etter endringer

- Verifiser alltid med `resolve` (positiv/negativ test).
- Ved import: `bun $S export-blocked | wc -l` for å bekrefte antall.
- Ikke kjør `blocked-flush` / `allowed-flush` for å «rydde» — det fjerner hele sonen. Spør først.
