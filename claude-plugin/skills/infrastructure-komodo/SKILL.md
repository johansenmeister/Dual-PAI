---
# GENERERT av Tools/BuildClaudePlugin.ts — ikke rediger.
# Kilde: .opencode/skills/Infrastructure/Komodo/SKILL.md
# Endringer hører hjemme i kilden; kjør deretter generatoren på nytt.
name: infrastructure-komodo
description: Komodo (Docker-stacker, servere, deploy-historikk og resource syncs) — lesing og kontroll, ingen endringer. USE WHEN komodo, stack status, docker stack, hvilke stacker kjører, oppdatering tilgjengelig, update available, deploy-logg, feilet deploy, resource sync, sync-diff, periphery, hvilken versjon kjører, sjekk stacken.
---

## Customization

**Before executing, check for user customizations at:**
`~/.opencode/PAI/USER/SKILLCUSTOMIZATIONS/Komodo/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

# Komodo

Les tilstanden i Komodo Core: stacker, tjenester og containere, servere,
oppdateringer som er tilgjengelige, deploy-historikken og hva en resource sync vil endre.

**Bare lesing.** Skillen endrer ingenting. Deploy, sync, `exec`, terminal,
rettigheter og nøkler gjør brukeren i Komodo-UI-et. Skillen leser før og etter og
viser hva som skjedde.

## 🚨 Den viktigste regelen

**All lesing går gjennom `Scripts/komodo.ts`.** Kall aldri API-et med `curl`, og
kjør aldri `km` direkte. Komodos lese-API gir ut hemmeligheter til alle som kan lese:

- Steget «Compose Config» i deploy-loggen viser den oppløste composen, med verdiene fra `.env`.
- `GetStack` gir compose-filene (`remote_contents`, `deployed_contents`, `deployed_config`)
  og stackens `environment`.
- En update bærer ressursens TOML (`prev_toml`, `current_toml`).
- `Inspect` gir `docker inspect`, med containerens miljøvariabler.

Verktøyet skriver bare ut feltene det kjenner (en allowlist), og holder alltid tilbake
«Compose Config». Et felt Komodo legger til senere, blir borte, ikke sluppet gjennom.

## Quick Reference

- **Verktøy:** `bun ~/.opencode/skills/Infrastructure/Komodo/Scripts/komodo.ts <kommando>`
  (i et prosjekttre: stien under `.opencode/skills/` i repoet). Svaret er JSON.
- **Kommandoene:**

  | Kommando | Gir |
  |---|---|
  | `stacks` | alle stacker: server, tilstand, status, `deployed_hash`/`latest_hash`, tjenester med `update_available` |
  | `stack <navn\|id>` | én stack: repo, filstier, tjenestene og containerne deres (navn, tilstand, image) |
  | `servers` | servere: tilstand, Periphery-versjon |
  | `updates [--stack <s>] [--page n]` | historikken, nyeste først: operasjon, status, suksess, hvem |
  | `update <id>` | én update med loggstegene; stdout/stderr er de siste 40 linjene per strøm |
  | `syncs` | resource syncs: tilstand, `managed`, siste sync |
  | `sync <navn\|id>` | hva synken vil endre: ressurs, type endring, deployer som venter |

- **Miljøet:** `KOMODO_CLI_HOST`, `KOMODO_CLI_KEY` og `KOMODO_CLI_SECRET`, de samme
  navnene som `km` leser. Verktøyet leser dem fra miljøet, og ellers fra `.env` i
  PAI-treet. Økten trenger ikke laste `.env` selv.
- **Nøkkelen** skal høre til en bruker som bare kan lese (en service user med `Read`, uten
  `Terminal`, `Attach`, `Processes` og `Inspect`). En API-nøkkel i Komodo har ikke eget
  scope; den arver brukerens rettigheter.
- **Vertene og stackene** står i `PAI/USER/INFRASTRUCTURE.md` og i runbookene, ikke her.
- **Fallgruvene:** `KnownPitfalls.md`. Les den før du tolker en status eller foreslår en endring.

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Status** | "komodo status", "hvilke stacker kjører", "er det oppdateringer", "update available", "hvordan står det til med docker" | `Workflows/Status.md` |
| **InspectStack** | "sjekk stacken", "hva kjører i <stack>", "hvilken versjon kjører <tjeneste>", "hvorfor feilet deployen" | `Workflows/InspectStack.md` |
| **ReviewChange** | "hva vil synken endre", "sjekk sync-diffen", "jeg skal deploye", "gikk deployen bra", "oppgrader <stack>" | `Workflows/ReviewChange.md` |

## Examples

**Example 1: Status**
```
User: "Er det noen oppdateringer i Komodo?"
→ Status: komodo.ts stacks
→ Lister stackene med update_available, og de der deployed_hash ≠ latest_hash
```

**Example 2: En deploy som feilet**
```
User: "Deployen av web feilet, hva skjedde?"
→ InspectStack: komodo.ts updates --stack web, så komodo.ts update <id>
→ Viser steget som feilet og stderr; «Compose Config» er holdt tilbake
```

**Example 3: Før en sync**
```
User: "Hva vil synken gjøre?"
→ ReviewChange: komodo.ts sync <navn>
→ Lister ressursene som opprettes, endres eller slettes; brukeren kjører synken i UI-et
```
