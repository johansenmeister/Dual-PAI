# Status

Oversikt over stackene: hva kjører, hva har oppdateringer, og hva står ikke som det skal.

1. Hent stackene og serverne:

   ```bash
   bun ~/.opencode/skills/Infrastructure/Komodo/Scripts/komodo.ts stacks
   bun ~/.opencode/skills/Infrastructure/Komodo/Scripts/komodo.ts servers
   ```

2. Rapporter, kort:
   - Servere som ikke er `Ok`.
   - Stacker som ikke er `running`, med status.
   - Tjenester med `update_available: true`: image nå og `latest_image`.
   - Stacker der `deployed_hash` ≠ `latest_hash` (git er foran det som er deployet).
   - `missing_files` som ikke er tomme.

3. Er `update_available` tom overalt rett etter en restart av Core, si det: indikatoren
   fylles først ved neste poll (`KnownPitfalls.md`).

Ingen endringer. Vil brukeren oppdatere, gå til `ReviewChange.md`.
