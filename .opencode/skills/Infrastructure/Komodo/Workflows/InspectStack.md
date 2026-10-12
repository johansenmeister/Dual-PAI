# InspectStack

Én stack i detalj: tjenestene, containerne og de siste deployene.

1. Stacken, med tjenester og containere:

   ```bash
   bun ~/.opencode/skills/Infrastructure/Komodo/Scripts/komodo.ts stack <navn>
   ```

2. Historikken for den, nyeste først:

   ```bash
   bun ~/.opencode/skills/Infrastructure/Komodo/Scripts/komodo.ts updates --stack <navn>
   ```

3. For en update som feilet (`success: false`), eller den siste deployen:

   ```bash
   bun ~/.opencode/skills/Infrastructure/Komodo/Scripts/komodo.ts update <id>
   ```

   Vis steget som feilet, med `stderr`. «Compose Config» er holdt tilbake av verktøyet;
   be ikke om å få det.

4. Rapporter: tilstand per container, image per tjeneste, siste deploy (når, hvem, om den
   gikk), og årsaken hvis noe feilet.
