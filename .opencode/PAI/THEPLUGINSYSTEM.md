# Hook-systemet

**Hendelsesdrevet automatisering for PAI, i OpenCode v2 og Claude Code**

**Kjernen:** `~/.opencode/pai-core/`
**Adaptere:** `~/.opencode/pai-adapters/opencode-v2/` og `claude-plugin/` i repoet
**Detaljer og defektregister:** `runbooks/hooksystemet.md` i repoet

---

## Oversikt

All PAI-logikk ligger i `pai-core/`, som ikke importerer noen motor. Hver motor
har en tynn adapter som oversetter motorens hooks til en `PaiEvent`, kaller
`dispatch(event)`, og oversetter `PaiResult` tilbake. `dispatch` kaster aldri:
en feil blir en note og en logglinje, og en blokkering går gjennom
returverdien.

To motorer, samme MEMORY-tre:

| Motor | Start | Adapter | `harness`-verdi |
|---|---|---|---|
| OpenCode v2 (`@opencode/cli`, pinnet) | `pai` | `pai-adapters/opencode-v2/`, registrert av launcheren via `OPENCODE_CONFIG_CONTENT` | `opencode2` |
| Claude Code | `pai --claude` | `claude-plugin/` (hooks, agenter, skills, MCP-server) | `claude` |

OpenCode v1 (`opencode-ai`, `plugins/pai-unified.ts`) ble slettet 2026-09-26.
Eldre MEMORY-filer har fortsatt `harness: opencode`.

**Grunnregel:** aldri `console.log` i hook-kode. Det ødelegger TUI-en i
OpenCode og protokollen i Claude Code (stdout ER svaret). Bruk
`fileLog`/`fileLogError` fra `pai-core/lib/file-logger.ts`.

---

## Hendelsesflaten

| PAI-hendelse | OpenCode v2 | Claude Code |
|---|---|---|
| `context.build` | `session.hook("context")` → `system.push`, per tur | `SessionStart` → `additionalContext` |
| `session.start` | første `session.prompt` per økt | `SessionStart` |
| `session.end` | pluginens cleanup (serveren stenger) + reaperen | `SessionEnd` + reaperen |
| `user.message` | `session.hook("prompt")` | `UserPromptSubmit` |
| `assistant.message` | bussen: `session.text.ended` / `session.step.ended` | `Stop` → `last_assistant_message` |
| `tool.before` | `tool.hook("execute.before")`, throw blokkerer | `PreToolUse` → `permissionDecision` |
| `permission.ask` | `permission.hook("evaluate")`, `effect: "ask"` | `PreToolUse` → `permissionDecision: "ask"` |
| `tool.after` | `tool.hook("execute.after")`, `status: "completed"` | `PostToolUse` |
| `tool.failed` | `execute.after` med `status: "error"` | `PostToolUseFailure` |
| `agent.start` / `.stop` | bussen: barneøktens `session.created` / `execute.after` på `subagent` | `SubagentStart` / `SubagentStop` |
| `session.compacting` | `session.hook("compaction")` | — (`PreCompact` kan ikke injisere) |
| `session.compacted` | bussen: `session.compaction.ended` | `PostCompact` |
| `shell.env` | `shell.hook("create.before")` | — (statiske nøkler i `settings.json`) |

**v2 validerer ikke hooknavn.** Et feilstavet navn registreres stille og fyrer
aldri. Hver hook adapteren registrerer, er derfor bevist å fyre i
`bun Tools/V2Smoke.ts`, som kjøres ved hver versjonsbump.

---

## Handlerne

Alle i `pai-core/handlers/`. «Hendelse» er kjernens, ikke motorens.

| Handler | Hendelse | Hva den gjør |
|---|---|---|
| `security-validator.ts` | `tool.before` | Mønstervakt for skall og sensitive stier: blokker, spør eller slipp gjennom. Revisjon i `STATE/security-audit.jsonl` |
| `agent-execution-guard.ts` | `tool.before` | Advarer når subagenter spawnes uten riktig valg (blokkerer ikke) |
| `skill-guard.ts` | `tool.before` | Sjekker at skill-kall matcher `USE WHEN` (blokkerer ikke) |
| `work-tracker.ts` | `user.message`, `session.end` | Arbeidsøkter i `MEMORY/WORK/`, `THREAD.md`, `META.yaml` |
| `rating-capture.ts` | `user.message` | Eksplisitte vurderinger (1–10) til `LEARNING/SIGNALS/ratings.jsonl` |
| `implicit-sentiment.ts` | `user.message` | Modellvurdert stemning når ingen eksplisitt vurdering er gitt |
| `format-reminder.ts` | `user.message` | Effortnivå fra meldingen |
| `isc-validator.ts` | `assistant.message` | Algoritmeformat og ISC-kriterier |
| `response-capture.ts` | `assistant.message` | Svar til arbeidsøkten, ISC til `ISC.json` |
| `last-response-cache.ts` | `assistant.message` | Siste svar, kontekst for stemningsanalysen |
| `tab-state.ts` | `assistant.message` | Tittel på terminalfanen (Kitty) |
| `algorithm-tracker.ts` | `tool.after` | Algoritmefase, ISC, subagent-spawns; fasesporing på `PRD.md` |
| `prd-sync.ts` | `tool.after` | PRD-frontmatter til registeret |
| `plan-capture.ts` | `tool.after` | Øyeblikksbilde av planfila fra plan-modus |
| `question-tracking.ts` | `tool.after` | `AskUserQuestion`-svar (Claude) |
| `agent-capture.ts` | `agent.stop` | Subagentens svar til `MEMORY/RESEARCH/` |
| `session-registry.ts` | `agent.start` / `.stop`, verktøy | Subagent-registeret (`running` → `completed`) |
| `compaction-intelligence.ts` | `session.compacting` | PRD, ISC og registeret inn i kompakteringssammendraget |
| `learning-capture.ts` | `session.end`, `session.compacted` | Læring fra arbeidsøkten til `MEMORY/LEARNING/` |
| `relationship-memory.ts` | `session.end` | Relasjonsnotater til `MEMORY/RELATIONSHIP/` |
| `integrity-check.ts` | `session.end` | Helsesjekk: filer, konfig, MEMORY-kataloger, adapteren |
| `update-counts.ts` | `session.end` | Tellinger i `settings.json` for banner/statuslinje |
| `session-cleanup.ts` | `session.end` | Markerer økten `COMPLETED` og rydder tilstand |
| `observability-emitter.ts` | alle | Hendelser til observability-serveren (kun OpenCode) |
| `roborev-trigger.ts` | verktøy | `code_review` — krever `roborev`, som ikke er installert |

**PAIs egne verktøy:** `session_registry`, `session_results`, `code_review`.
Under v2 via `tool.transform`; under Claude via MCP-serveren, som
`mcp__plugin_pai_pai__session_registry` og `…__session_results`.

---

## Kjernens katalog

```text
pai-core/
├── index.ts          # dispatch(event) → PaiResult, lat import per handler
├── types.ts          # PaiEvent, PaiResult, Harness, PaiCapabilities
├── runtime.ts        # sessionKeyFor, currentHarness, capabilitiesFor
├── dispatch/         # context, message, tool, session, agent, shell-env, state
├── handlers/         # tabellen over
└── lib/              # file-logger, paths, tool-names, payload, sanitizer, injection-patterns, …
```

**Kapabiliteter, ikke motornavn.** Kjernen spør `capabilitiesFor(harness)` om
`observability` og `agentAliases`. En `harness ===`-sjekk hører bare hjemme i
`runtime.ts` og adapterne.

**Sesjonsnøkkelen** (`o2_<id>`, `cc_<id>`) brukes i alle filnavn under
`MEMORY/STATE/`, så to motorer med samme rå ID aldri deler tilstand.

---

## Logging

| Motor | Fil |
|---|---|
| OpenCode v2 | `/tmp/pai-opencode2-debug.log` |
| Claude Code | `/tmp/pai-claude-debug.log` |
| uten `PAI_HARNESS` (testene) | `/tmp/pai-opencode-debug.log` |

`PAI_LOG_PATH` overstyrer.

---

## Feilsøking

- **Lastet adapteren?** v2: `grep "v2-adapter lastet" /tmp/pai-opencode2-debug.log`.
  Claude: `pai claude doctor`.
- **Fyrer hookene?** `bun Tools/V2Smoke.ts` i repoet (modellkall, én nøkkel).
- **Kom konteksten inn?** `grep "Context injected" /tmp/pai-*-debug.log`.
- **Blokkerer vakten for mye?** Se `STATE/security-audit.jsonl` for mønsteret
  som traff.
- **Mer:** `runbooks/hooksystemet.md` og `runbooks/daglig.md` i repoet.

---

## Relatert

- `MEMORYSYSTEM.md` — MEMORY-treet handlerne skriver i
- `PAIAGENTSYSTEM.md` — agentene
- `claude-plugin/README.md` — Claude-siden
- `docs/opencode-v2/plan.md` — v2-adapteren, med målingene
