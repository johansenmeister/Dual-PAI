---
tittel: Claude Code-adapteren
oppdatert: 2026-09-22
tags: [dual-harness, claude-code, adapter, plugin]
---

# Claude Code-adapteren

Denne katalogen er PAIs **adapter** mot Claude Code — ikke logikken. All
PAI-logikk ligger i `.opencode/pai-core/`, som deles med OpenCode-siden og
aldri importerer noe motorspesifikt.

Havner det en `if`-setning om PAI-*atferd* her, hører den hjemme i kjernen.
Det som hører hjemme her er oversettelse: feltnavn, utdataform, og hvem som
eier prosessen.

## Hvordan den lastes

```bash
claude --plugin-dir ~/repos/pai/claude-plugin
```

`--plugin-dir` er et **sesjonsflagg på `claude`**, ikke et flagg på
`claude plugin install` (målt mot 2.1.278). Den **verken kopierer eller
lenker** — `CLAUDE_PLUGIN_ROOT` peker rett på denne katalogen, og en endring
her tar effekt ved neste sesjon uten reinstall. Det er grunnen til at
`pai claude sync` (batch 10) kun trenger å regenerere, ikke installere på nytt.

PAI-konteksten er portet bak `PAI_ENABLED=1`. Uten den får du hookene, men
ingen kontekstinjeksjon — en vanlig Claude Code-sesjon skal ikke dra med seg
hele PAI-treet. Launcheren setter variabelen; inntil batch 10 gjør du det selv.

## Filene

| Fil | Ansvar |
|---|---|
| `.claude-plugin/plugin.json` | Manifestet |
| `hooks/hooks.json` | Én oppføring per hendelse, tretten i alt. **Generert** fra rutetabellen |
| `bin/pai-hook` | Oppstarter som finner `bun` og `exec`-er dispatcheren |
| `bin/pai-hook.ts` | Dispatcheren: stdin → hurtigutgang → dispatch → stdout |
| `src/bootstrap.ts` | Miljø og `console`-shim. **Må importeres først** |
| `src/owner.ts` | Finner motorprosessen i `/proc`-slekten |
| `src/adapter/routes.ts` | Hurtigutgang. Importerer ingenting, med vilje |
| `src/adapter/in.ts` | Rå payload → `PaiEvent` |
| `src/adapter/out.ts` | `PaiResult` → hook-utdata |
| `src/session.ts` | Hvilken økt MCP-serveren kjører i |
| `mcp/pai-mcp.ts` | MCP-server: PAIs egne verktøy |
| `bin/pai-mcp` | Oppstarter for serveren |
| `.mcp.json` | Registreringen motoren leser |
| `skills/` | **Generert** speil av `.opencode/skills/`, flatet til ett nivå |
| `agents/` | **Generert** fra `.opencode/agents/` + `profiles/claude.yaml` |
| `skill-map.json` | **Generert** — flatt skill-navn → kilden |
| `agent-alias.json` | **Generert** — bart agentnavn → `pai:<navn>` |

Alt merket generert kommer fra `Tools/BuildClaudePlugin.ts`. Rediger
kilden, ikke speilet — `bun Tools/BuildClaudePlugin.ts --sjekk` sier fra
hvis de har gått fra hverandre, og `tests/claude-mirror.test.ts` feiler.

## Navnene motoren bruker er ikke navnene kilden bruker

MÅLT 2026-09-22, ende-til-ende. Dette er batch 8s viktigste funn, og det
sto ikke i planen:

| Hva | Kilden sier | Claude Code sier |
|---|---|---|
| Agent | `Engineer` | `pai:Engineer` |
| Skill | `Infrastructure/Proxmox` | `pai:infrastructure-proxmox` |

**Et bart agentnavn resolver ikke.** Motorens egen feilmelding: «Agent type
'ProbeCamelCase' not found. Available agents: …, probe:ProbeCamelCase, …».
Promptmaterialet i dette repoet sier `subagent_type: "Engineer"` 139 steder,
så uten oversettelse ville hver eneste agentspawn feilet.

Veien ut ble målt i samme kjøring: en `PreToolUse`-hook som svarer med
`hookSpecificOutput.updatedInput` blir lest FØR motoren slår opp agenttypen.
A/B-en er entydig — samme prompt feilet uten hooken og lyktes med den.
Kjeden er `agent-alias.json` → `pai-core/lib/agent-alias.ts` →
`dispatch` → `out.ts`, og den er gatet på kapabiliteten `agentAliases`.

Gatingen MÅ være på kapabilitet og aldri på om alias-fila finnes: den
ligger i repoet OpenCode kjører fra, så «finnes fila?» er sant i begge
motorene. Gatet på fil ville OpenCode skrevet om `Engineer` til
`pai:Engineer` og brutt hver subagent-spawn der.

For skills er det KATALOGNAVNET som er adressen, ikke frontmatter-`name` —
binærens egen tekst: «Skill names match the skill's directory name (or
'plugin:skill' for plugin-qualified skills)». Planen antok det motsatte.
Og en skill to nivåer ned lastes ikke i det hele tatt, som er grunnen til
at de femti hierarkiske må flates.

## MCP-serveren, og hvordan den vet hvilken økt den er i

MCP-protokollen bærer ingen sesjons-ID, og Claude Code sender ingen.
OpenCodes `tool()` får en `ToolContext` med `sessionID`; her finnes ikke
motstykket. Verktøyene leser per-økt-tilstand, så uten ID-en er de blinde.

MÅLT 2026-09-22: **serveren er et DIREKTE barn av motorprosessen.**

```
dybde=0 pid=68443 comm=bun     ← MCP-serveren
dybde=1 pid=68419 comm=claude  ← MOTOREN
```

Hookene har `sh` og `bash` imellom og må lete oppover (`src/owner.ts`); her
holder forelderen. Og `SessionStart` kjenner BÅDE sesjons-ID-en og motorens
pid, så den legger igjen en peker i `STATE/sessions/by-ppid/<pid>.json`.
Tre lag, svakest sist:

| Lag | Kilde | Når |
|---|---|---|
| 1 | Forelderens pid → pekerfila | Normaltilfellet. Det eneste eksakte |
| 2 | `session_id`-argument | Når modellen vet bedre |
| 3 | Nyeste peker med samme `cwd` | Siste utvei |

Ingen treff → verktøyet svarer «vet ikke». Å gjette ville gitt et selvsikkert
svar om FEIL økts subagenter.

Pekeren er en FIL og ikke en miljøvariabel: serveren startes av motoren på et
tidspunkt vi ikke styrer, og en variabel satt etterpå ville aldri nådd den.
`engineStart` (felt 22 fra `/proc`) skiller en gjenbrukt pid fra den
opprinnelige.

### Verktøynavnene er motorens, ikke våre

MÅLT: `mcp__plugin_<plugin>_<server>__<verktøy>`, altså
`mcp__plugin_pai_pai__session_registry`. Planen anga `mcp__pai__<verktøy>`;
det finnes ikke. Endres servernavnet i `.mcp.json`, endres hvert navn
brukeren må godkjenne.

`session_results` er skrevet om mot OpenCode-utgaven, og er bedre: der endte
svaret i `Task({session_id, prompt})` for å gjenoppta subagenten, som ikke
finnes i Claude Code. Her returneres subagentens FAKTISKE svar —
`agent-capture` har allerede skrevet det til `MEMORY/RESEARCH/`, og
registeroppføringen bærer stien.

### `.opencode/.env` lastes fortsatt ikke

Planen satte det til batch 9 «der MCP-verktøyene faktisk trenger
`GITEA_TOKEN`». De to verktøyene som finnes — `session_registry` og
`session_results` — leser kun MEMORY-treet og trenger ingen nøkler.
`code_review` er det eneste som ville trengt dem, og `roborev` er ikke
installert på noen maskin i oppsettet. Å injisere produksjonsnøkler i en
langlivet prosess som ikke bruker dem er en sikkerhetsflate, ikke en
tjeneste. Tas når `code_review` faktisk bygges.

## De tre invariantene

**stdout er protokollen.** Nøyaktig ett skrivekall, helt til slutt, med et
ferdig serialisert dokument. Enhver annen byte ødelegger JSON-parsingen på
den andre siden, og Claude Code rapporterer det som en generisk hook-feil
uten å si hvilken byte som var for mye. `bootstrap.ts` shimmer derfor
`console.*` til fileLog, og `tests/claude-adapter.test.ts` håndhever at kun
`bin/pai-hook.ts` rører stdout.

**Avslutningskoden er alltid 0.** En krasjet hook er ikke-blokkerende, så
feilen blir usynlig. Alt som går galt blir en logglinje og et tomt svar.

**Ingenting henger.** Vaktbikkja i `bin/pai-hook.ts` ligger under `timeout` i
`hooks.json`, så PAI selv avgjør hva som skjer når noe tar for lang tid.

## Eierprosessen — batchens farligste detalj

Claude Code kjører **én prosess per hook-event**. Skriver
`setCurrentWorkPath` sin egen `process.pid` i `current-work-<sid>.json`, er
eieren død millisekunder senere, og neste `SessionStart` reaper en økt
brukeren fortsatt sitter i.

`src/owner.ts` går derfor oppover i `/proc` og finner motorprosessen. Slekten
er målt:

```
dybde=1  comm=bash    ← hook-oppstarteren
dybde=2  comm=sh      ← /bin/sh -c "${CLAUDE_PLUGIN_ROOT}/bin/pai-hook"
dybde=3  comm=claude  ← MOTORPROSESSEN
...
dybde=6  comm=claude  ← en HELT ANNEN økt
```

Første treff oppover, ikke siste — dybde 6 er grunnen. Finner vi ingen,
settes `PAI_OWNER_PID=ukjent`, og kjernen skriver da **ingen** pid framfor en
vi vet er død. Verifisert ende-til-ende 2026-09-21: en død eier ble reapet og
fikk `COMPLETED`, en levende eier sto urørt i samme reaper-kjøring.

## Hendelsene, og hva hver av dem gjør

Tretten av Claude Codes 33 hooks er koblet. De øvrige tjue har ingen
PAI-tilstand å røre, og en hendelse adapteren ikke kjenner koster
bun-oppstart alene — rutetabellen konsulteres før kjernen lastes.

| Hook | Kjernehendelse | Hva den utløser |
|---|---|---|
| `SessionStart` | `session.start` + `context.build` | Reaper, rydding, versjonssjekk, ~26 KB kontekst |
| `SessionEnd` | `session.end` (`exit`) | Teardown: læring, integritet, fullføring, relasjonsminne |
| `UserPromptSubmit` | `user.message` | Arbeidssporing, rating, innsatsnivå |
| `PreToolUse` | `tool.before` | Sikkerhetsvakten. Eneste hendelse som kan nekte et kall |
| `PostToolUse` | `tool.after` | Algoritmesporing, PRD-synk, spørsmålssporing |
| `PostToolUseFailure` | `tool.failed` | Registrerer at kallet feilet. Avbrudd telles ikke som feil |
| `Stop` | `assistant.message` | ISC, fanetittel, respons-fangst, THREAD |
| `SubagentStart` | `agent.start` | Registeret får `running` |
| `SubagentStop` | `agent.stop` | Registeret får `completed`, output fanges |
| `PostCompact` | `session.compacted` | Læringsredning etter kompaktering |
| `PreCompact` | — | Kun logglinje. Se under |
| `PermissionRequest` | — | Revisjonslinje |
| `PermissionDenied` | — | Revisjonslinje |

### De tre uten kjernehendelse

`PermissionRequest` og `PermissionDenied` blir revisjonslinjer, ikke
`permission.ask`. Sikkerhetsvakten har allerede sagt sitt om kallet i
`PreToolUse`, med de samme mønstrene og de samme argumentene — en ny runde
ville gitt samme svar til prisen av nok en kjernelasting. Det som IKKE finnes
noe annet sted, er hvilke kall PAI slapp gjennom mens brukeren ble spurt, og
hvilke brukeren sa nei til. Det er de linjene som registreres.

`PreCompact` **kan ikke injisere kontekst.** Den har intet
`hookSpecificOutput`-skjema i binæren (2.1.278), kun fellesformen
`continue`/`decision`/`stopReason`/`systemMessage`/`terminalSequence`.
OpenCodes motstykke `experimental.session.compacting` skyver
kompakteringskontekst inn i sammendraget; her finnes ingen kanal for det.
Det som dekker kompaktering på Claude-siden, er `SessionStart` med
`source: "compact"` — adapteren behandler den som enhver annen start og
reinjiserer hele konteksten.

## Subagenter går ÉN vei, ikke to

Claude Code fyrer **både** `PostToolUse` på subagent-verktøyet **og**
`SubagentStart`/`SubagentStop`. Uten en port ville hver subagent blitt fanget
to ganger, i to hook-prosesser som ikke deler minne og derfor ikke kan dedupe
hverandre.

Porten er kapabiliteten `subagentEvents` i `pai-core/runtime.ts`. Er den på,
hopper Task-grenen i `onToolAfter` over, og `agent.start`/`agent.stop` eier
fangsten. De gir tre ting Task-veien ikke kan:

- `agent_type` fra MOTOREN, ikke utledet av `args.subagent_type` — som
  rapporterer `unknown` på OpenCode av årsaker ingen har funnet
- `last_assistant_message` ferdig, framfor `tool_response` parset gjennom
  fire formvarianter
- `running` ved spawn, så en subagent som krasjer blir SYNLIG i registeret
  framfor aldri å ha eksistert der

**Verktøyet heter `Agent`, ikke `Task`** (målt 2026-09-22, ende-til-ende).
Navnetabellen bor i `pai-core/lib/tool-names.ts`, og rutetabellen her må
kjenne nøyaktig de samme navnene — ellers forkastes kallet i hurtigutgangen
før kjernen ser det. En test låser de to sammen.

## Turblokkering: en annen utdataform enn verktøyblokkering

`Stop` kan nekte modellen å gi seg, og formen er en ANNEN enn `PreToolUse`
sin: toppnivå `decision: "block"` + `reason`, ikke
`hookSpecificOutput.permissionDecision`. Derfor skiller `PaiResult` feltene
`permission` og `block` — ett felt for begge ville tvunget adapteren til å
gjette ut fra hendelsesnavnet hvilken av de to formene kjernen mente.

Avgjørelsen tas i kjernen, bak `PAI_ISC_ENFORCE` med `warn` som default.
Løkkevakten er `stop_hook_active`: blokkerer vi en tur, får modellen beskjeden
og svarer på nytt, og er det nye svaret like mangelfullt, ville de to stått i
ring til brukeren grep inn. Maks én blokkering per tur er hele regelen.

## Det som fortsatt ikke dekkes

Arbeid kjernen har sluppet løs uten å vente på det, kuttes når hook-prosessen
avslutter. `handleImplicitSentiment` er det ene tilfellet i dag.

Claude Code har en ferdig mekanisme for nettopp dette: en hook kan svare
`{"async": true, "asyncTimeout": <ms>}` og bli bakgrunnskjørt av motoren
(funnet i binærens skjema 2026-09-22, ikke prøvd). Det er trolig en enklere
vei enn jobbfil og `unref()`, og hører hjemme i batch 12.

## Ytelse

Målt 2026-09-21 på testmaskinen, 20 kall per sti:

| Sti | ms/kall |
|---|---|
| bun kaldstart alene | 69,3 |
| Hurtigutgang (ingen modulgraf lastet) | 67–70 |
| `PreToolUse` med full sikkerhetsvakt | 79–86 |

Kaldstarten dominerer. Hurtigutgangen koster nøyaktig bun-oppstart, altså
gjør den jobben sin — PAIs eget arbeid er 10–17 ms. Gevinsten i batch 12
ligger derfor i `bun build --compile` (~10–20 ms), ikke i mer filtrering.
Kontrakten som gjør byttet gratis: `hooks.json` peker kun på `bin/pai-hook`,
så en kompilert binær på samme sti krever ingen reinstall.
