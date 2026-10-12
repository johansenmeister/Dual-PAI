# ReviewChange

Brukeren gjør endringen i Komodo-UI-et. Skillen leser før og etter, så begge vet hva
som skal skje og hva som skjedde.

## Før

- **En resource sync:** hent diffen og vis den som en liste.

  ```bash
  bun ~/.opencode/skills/Infrastructure/Komodo/Scripts/komodo.ts sync <navn>
  ```

  Si hva som opprettes, endres og slettes, hvilke deployer som venter, og om det er en
  `pending_error`. Er diffen ikke den brukeren ventet, si det før synken kjøres.
- **En oppgradering** (ny image-tagg i composen i git): sjekk at stacken er frisk og
  hvilken versjon som kjører nå (`bun ~/.opencode/skills/Infrastructure/Komodo/Scripts/komodo.ts stack <navn>`). Minn om at taggen bør
  finnes etter digest (`KnownPitfalls.md`).
- **En hemmelighet som skal byttes:** verdien ligger i env-fila på verten. Den skrives
  aldri gjennom chat; brukeren bytter den og deployer i UI-et.

Så sier du fra at endringen gjøres i UI-et (Run Sync, Deploy), og venter.

## Etter

1. Den nyeste updaten for stacken eller synken:

   ```bash
   bun ~/.opencode/skills/Infrastructure/Komodo/Scripts/komodo.ts updates --stack <navn>
   bun ~/.opencode/skills/Infrastructure/Komodo/Scripts/komodo.ts update <id>
   ```

2. Rapporter om den gikk, og hvilket steg som feilet hvis ikke.
3. `bun ~/.opencode/skills/Infrastructure/Komodo/Scripts/komodo.ts stack <navn>`: containerne kjører, og `deployed_hash` er den nye.
