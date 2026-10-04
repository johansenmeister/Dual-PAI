# ManageCache Workflow

Inspiser og tøm DNS-cachen.

**Script:** `Scripts/technitiumApi.ts` — ALL datainnhenting går via dette.

> `cache-flush` uten domene tømmer HELE cachen. Uten domene er det en global operasjon —
> bekreft med brukeren først. `cache-flush <domene>` sletter kun det ene domenet.

## Kommandoer

```bash
S=~/.config/opencode/skills/Infrastructure/Technitium/Scripts/technitiumApi.ts

# Inspiser
bun $S --compact cache                     # cachede soner + records på rot
bun $S --compact cache <domene>            # cache-oppføring for ett domene

# Tøm
bun $S cache-flush <domene>                # slett ett domene fra cachen
bun $S cache-flush                         # ⚠️ tøm hele cachen
```

## Nyttig

- Cache-størrelse og grenser fra innstillinger:
```bash
bun $S --compact settings cacheMaximumEntries cacheMaximumRecordTtl cacheNegativeRecordTtl
```
- Etter `cache-flush <domene>`: bekreft med `bun $S cache <domene>` (skal være tom) og
  `bun $S resolve <domene>` (skal gjøre frisk rekursiv spørring).

## Typisk bruk

- «Hvorfor får jeg gammelt svar?» → `cache <domene>`, deretter `cache-flush <domene>`.
- «Tøm DNS-cachen» → bekreft omfang (alt vs. ett domene), så `cache-flush`.
