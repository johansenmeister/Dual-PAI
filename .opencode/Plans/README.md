# Plans

Øyeblikksbilder av planer fra plan-modus, fanget av
`pai-core/handlers/plan-capture.ts`.

Begge motorene skriver planen som en fil med sitt vanlige skriveverktøy, og
PAI kopierer den hit etter hver skriving eller redigering:

| Motor | Planfila | Her |
|---|---|---|
| Claude Code | `~/.claude/plans/<slug>.md` | `claude-<slug>.md` |
| OpenCode v2 | `$HOME/.opencode/plan/<navn>.md` | `opencode-<navn>-<sesjon>.md` |

Samme plan gir samme filnavn, så en redigert plan erstatter øyeblikksbildet.
Frontmatteren sier hvor planen kom fra, hvilken økt og når den ble fanget.

`.opencode/plan/` (v2s arbeidsfil) er gitignorert. Det er denne katalogen som
synkes.
