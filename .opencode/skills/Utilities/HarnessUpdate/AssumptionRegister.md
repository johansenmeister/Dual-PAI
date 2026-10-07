# Antakelsene vi står på

Dette er registeret `ClaudeSmoke`, `V2Smoke` og `HarnessUpdate` skal vokte. Hver
rad er MÅLT; kilden står i `docs/dual-harness/handoff.md` eller
`runbooks/hooksystemet.md`. En ny motorversjon er ikke godkjent før hver rad er
grønn på nytt.

**Claude Code** (sist målt 2.1.283, av `ClaudeSmoke` 2026-10-07, 33 sjekker; «CS» = sjekket der):

| Antakelse | Hvis den brytes | CS |
|---|---|---|
| Hook-kontekst over 10 000 tegn blir en fil og en forhåndsvisning på 2 KB (`jDo=1e4`); 9 000 kommer inn hel. Synlig i transkriptet som `<persisted-output>` i `hook_additional_context` | K-10: konteksten må gå som systemprompt | ja |
| `--append-system-prompt-file` finnes; en fil som mangler gir «Append system prompt file not found» | launcheren og `pai claude doctor` (`tolkFlaggsjekk`) | ja |
| Hooks i exec-form (`args: []`) fyrer; skallform brekker på mellomrom i stien. `CLAUDE_PLUGIN_ROOT` er stien slik den ble gitt, ikke `realpath` | M-42 | ja |
| `hooks.json` godtar `description`; ukjente nøkler gir en advarsel i hver økt | M-42 | ja (`plugin validate`) |
| `permissionDecision` er `allow\|deny\|ask`; begrunnelsen når modellen som `PreToolUse:<verktøy> hook error: <begrunnelse>` | sikkerhetsvakten | ja (`deny`) |
| `Stop` blokkeres med toppnivå `decision: "block"` + `reason`; neste `Stop` har `stop_hook_active: true` | `PAI_ISC_ENFORCE` | ja (probe-plugin) |
| Subagent-verktøyet heter `Agent`, og `updatedInput` leses før agenttypen slås opp; Write/Edit sender `file_path` | M-17, M-44, K-09 | ja |
| De skrivende verktøyene i init-lista er `Write`, `Edit` og `NotebookEdit`, og hvert annet navn står i `IKKE_SKRIVENDE` | sikkerhetsvakten og K57 (M-55) | ja (init) |
| **`Agent` kjører asynkront** («Async agent launched»): svaret står ikke i verktøyresultatet, men kommer med `SubagentStop` | registeret og `session_results` | ja |
| Skill-kall sender `args.skill` = `pai:<flatt-navn>` | M-40 | ja (steg G, K25) |
| `SessionEnd` fyrer også i `-p` | røyktesten | ja |
| Plugin-MCP heter `mcp__plugin_pai_pai__<verktøy>`; `.mcp.json`-kommandoen må matche `^\$\{CLAUDE_PLUGIN_ROOT\}/bin/[^/\\]+$` | batch 9 | ja (init) |
| PostToolUse `hookSpecificOutput.updatedToolOutput` bytter ut outputen modellen ser, for alle verktøy (også Bash, Read, Grep), og `additionalContext` når modellen ved siden av | #367: maskering av hemmeligheter | ja (steg S) |
| `TaskCreate` finnes med `CLAUDE_CODE_ENABLE_TODO_TOOLS=true` | ISC-sporingen | ja (init; at den krever nøkkelen, er ikke sjekket) |
| `DISABLE_AUTOUPDATER=1` i `env` stopper den native oppdatereren, og `claude install <versjon>` virker med den | C1: pinningen | nei (målt i fase 2 med debug-loggen) |

**OpenCode v2** (sist målt 2.0.22, av `V2Smoke` 2026-10-07): dekket av `V2Smoke` (10 hooks, 41 sjekker).
I tillegg, utenfor røyktesten: skallverktøyet heter `shell` med `input.command`;
`session.context` fyrer per tur; adapteren lastes via `OPENCODE_CONFIG_CONTENT` og
`--standalone` (B2, B6); en plugin er en katalog med `package.json`, ikke en fil; `result` slik det står etter
`execute.after` er det modellen får (#367, maskering; dekket av `V2Smoke` steg h); agenter trenger `mode: all`; modellkatalogen ligger i
`opencode.db`, `kv` → `models-dev:catalog`; innloggingen i `credential`-tabellen; de
skrivende verktøyene er `write`, `edit` og `patch`, og en modell med `gpt-` i id-en får
bare `patch` (M-55, UTLEDET av kilden).
