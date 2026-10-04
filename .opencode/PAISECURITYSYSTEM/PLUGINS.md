# Sikkerhetsvakten

**Hvordan `security-validator` virker, i OpenCode v2 og Claude Code**

---

## Oversikt

Vakten er `pai-core/handlers/security-validator.ts`. Den kjører på kjernens
`tool.before`, altså før hvert verktøykall i begge motorene, og er det første
som kjører. Den stopper katastrofale kommandoer og skriving til
legitimasjonsfiler, spør ved risikable kommandoer, og slipper resten gjennom.

---

## Hvor den kobles inn

| Motor | Hook | Blokkering | Spørsmål (`confirm`) |
|---|---|---|---|
| OpenCode v2 | `tool.hook("execute.before")` | `throw`; begrunnelsen når modellen ordrett | `permission.hook("evaluate")` med `effect: "ask"`, gir TUI-dialogen |
| Claude Code | `PreToolUse` | `permissionDecision: "deny"` + `permissionDecisionReason` | `permissionDecision: "ask"` |

Adapteren flytter motorens felter inn i kjernens form før vakten ser dem:
skallet heter `shell` med `input.command` under v2 og `Bash` under Claude,
og filstien heter `path` (v2) eller `file_path` (Claude). `lib/tool-names.ts`
(`isShellTool`, `kanoniskeArgs`) gjør at vakten bare kjenner ett navn per felt.

**v2 validerer ikke hooknavn.** At vakten faktisk fyrer, er bevist ende til
ende i `bun Tools/V2Smoke.ts`, med et farlig skallmønster og en `write` til
`.ssh/`.

---

## Hva den sjekker

1. **Skallkommandoer** mot `DANGEROUS_PATTERNS` (blokk) og `WARNING_PATTERNS`
   (spør), begge i `pai-core/adapters/types.ts`. `export`/`set`-prefiks
   fjernes først, så mønsteret treffer verdien og ikke nøkkelordet.
2. **Prompt-injeksjon** i tekstfeltene (`lib/injection-patterns.ts`, sju
   kategorier), både på originalen og på en sanert versjon
   (`lib/sanitizer.ts`: base64, Unicode, mellomrom).
3. **Sensitive stier** for `write`/`edit`, i to nivåer:
   - presise legitimasjonsstier (for eksempel `~/.ssh/authorized_keys`): blokk.
     Meldingen sier at endringen skal gjøres for hånd og ikke prøves på nytt.
   - brede heuristikker (løse delstrenger): spør, blokkerer aldri.

---

## Revisjon

Hver avgjørelse skrives til `MEMORY/STATE/security-audit.jsonl`:

```json
{
  "timestamp": "2026-09-26T12:00:00.000Z",
  "tool": "shell",
  "action": "blocked",
  "reason": "…",
  "pattern": "…",
  "commandPreview": "de første 100 tegnene, med hemmeligheter maskert",
  "harness": "opencode2"
}
```

`action` er `blocked`, `confirmed` eller `allowed`.

---

## Feilhåndtering

Vakten er **fail-open**: kaster den selv, slipper kallet gjennom med
«Security check error - fail-open» i loggen. Det er et bevisst valg: en vakt
som henger eller stopper alt ved en egen feil, gjør motoren ubrukelig. En
tiltenkt blokkering går gjennom returverdien, ikke gjennom et unntak, så
adapteren kan fange alt uten å svelge den (K-07).

---

## Egne mønstre

Mønstrene er kode, ikke konfigurasjon: legg dem til i `DANGEROUS_PATTERNS` eller
`WARNING_PATTERNS` i `pai-core/adapters/types.ts`, og legg til en test i
`tests/security-validator.test.ts`. `patterns.example.yaml` i denne katalogen
leses ikke av vakten.
