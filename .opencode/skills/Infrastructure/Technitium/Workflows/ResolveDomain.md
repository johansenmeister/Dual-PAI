# ResolveDomain Workflow

Feilsøk et domenenavn: er det blokkert, cachet, eller løses det normalt? Bruk når brukeren spør «hvorfor resolver X slik» eller «er X blokkert».

**Script:** `Scripts/technitiumApi.ts` — ALL datainnhenting går via dette.

## Steps

1. **DNS-oppslag via serveren selv:**
```bash
S=~/.config/opencode/skills/Infrastructure/Technitium/Scripts/technitiumApi.ts
bun $S --compact resolve <domene> A
bun $S --compact resolve <domene> AAAA
```
Se på `response.result.RCODE`:
- `NoError` + `Answer[]` → løses normalt (vis IP(er) og TTL)
- `NxDomain` + tom `Answer` → **blokkert** (blokkeringstype er NxDomain) eller domenet finnes ikke
- `ServerFailure`/`Refused` → oppstrøms problem

2. **Er domenet eksplisitt blokkert eller tillatt?** (hierarkisk oppslag)
```bash
bun $S --compact blocked <tld>          # f.eks. blocked com
bun $S --compact blocked <domene>       # sjekk sonen
bun $S --compact allowed <tld>
bun $S --compact export-blocked | grep -i "<domene>"
```
> `blocked/list` viser barnenivåer. For et endelig svar på «er dette blokkert», bruk `export-blocked` + `grep`, eller `resolve`.

3. **Ligger svaret i cachen?**
```bash
bun $S --compact cache <domene>
```

4. **Har serveren nylig sett oppslaget?**
```bash
bun $S --compact logs 50 --qname <domene>
```

5. **Test oppstrøms (recursive-resolver) for å skille blokkering fra oppstrømsfeil:**
```bash
bun $S --compact resolve <domene> A recursive-resolver
```

6. **Presenter diagnose:**

```
🔎 DNS-OPPSLAG: <domene>
━━━━━━━━━━━━━━━━━━━━━━━━

  RCODE:        NxDomain
  Svar:         (ingen)
  Blokkert:     Ja — funnet i Blocked-sonen (<tld>)
  Tillatt:      Nei
  Cache:        Ingen oppføring
  Siste logg:   Blokkert, klient <IP>

  → Årsak: domenet er på blocklist. Vil du tillate det? (ManageBlocklists)
```

## Eksempel fra historikken

`testmynids.org` resolver til NxDomain fordi domenet fanges av blocklist — ikke en oppstrømsfeil. Bekreft med `resolve` (NxDomain, ingen svar) kombinert med `export-blocked | grep`.

## Vanlige årsaker

| Symptom | Sannsynlig årsak | Neste steg |
|---------|------------------|------------|
| NxDomain, tom svar | Blocklist | `ManageBlocklists` (allow) |
| NxDomain, ikke i blokkliste | Domenet finnes ikke ekte | `resolve ... recursive-resolver` |
| NoError men «feil» IP | Lokal sone/override eller cache | `records <sone>` / `cache-flush <domene>` |
| ServerFailure | Oppstrøms forwarder nede | `settings forwarders`, sjekk nettverk |
| Gammelt svar | Cache | `ManageCache` |
