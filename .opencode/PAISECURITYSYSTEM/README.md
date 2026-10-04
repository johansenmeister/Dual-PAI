# PAI Security System

A foundational security framework for Personal AI Infrastructure.

---

## Hvor vakten bor

Denne katalogen er dokumentasjonen. Vakten selv er
`pai-core/handlers/security-validator.ts`, og mønstrene står i
`pai-core/adapters/types.ts`. Den kjører før hvert verktøykall i begge motorene
(OpenCode v2 og Claude Code); se `PLUGINS.md`.

Oppstrøms-PAI hadde et to-lags design med `USER/PAISECURITYSYSTEM/patterns.yaml`
over `patterns.example.yaml`. **Det er ikke implementert her:** vakten leser
ingen YAML, og `patterns.example.yaml` står som mal.

---

## Status: Foundation Release

This security system provides essential protection against catastrophic operations while maintaining development velocity. It represents a **starting point**, not a final destination.

**What it does today:**
- Blocks irreversible filesystem and repository operations
- Prompts for confirmation on dangerous but legitimate commands
- Logs all security events for audit trails
- Protects sensitive paths (credentials, keys, configs)

**What it doesn't do (yet):**
- Behavioral anomaly detection
- Session-based threat modeling
- Adaptive pattern learning
- Cross-session attack correlation
- Network egress monitoring

---

## Architecture

```
PAISECURITYSYSTEM/           # System defaults (this directory)
├── README.md                # This file
├── ARCHITECTURE.md          # Security layer design
├── PLUGINS.md               # Vakten: hooks, sjekker, revisjon
├── PROMPTINJECTION.md       # Prompt injection defense
├── COMMANDINJECTION.md      # Command injection defense
└── patterns.example.yaml    # Mal fra oppstrøms (leses ikke)
```

---

## Quick Start

1. Vakten virker uten oppsett
2. Nye mønstre legges i `pai-core/adapters/types.ts`, med en test i
   `tests/security-validator.test.ts`
3. Avgjørelsene logges til `MEMORY/STATE/security-audit.jsonl`

---

## Future Development

This system will evolve. Expect updates in:
- Pattern coverage (more dangerous command detection)
- Path protection (smarter glob matching)
- Logging (richer event context)
- Integration (MCP server validation, API call monitoring)

Contributions and feedback welcome.

---

## Documentation

| Document | Purpose |
|----------|---------|
| `ARCHITECTURE.md` | Security layers, trust hierarchy, philosophy |
| `PLUGINS.md` | SecurityValidator implementation details |
| `PROMPTINJECTION.md` | Defense against prompt injection attacks |
| `COMMANDINJECTION.md` | Defense against command injection |
| `patterns.example.yaml` | Mal fra oppstrøms, leses ikke |

---

## Credits

- **IndieDevDan** — Contributed to the security architecture design philosophy
