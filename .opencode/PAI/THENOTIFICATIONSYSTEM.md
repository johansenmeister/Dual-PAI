# The Notification System

**Tekstvarsling for PAI-workflows, og eksterne kanaler for push.**

> **Voice-varsling er FJERNET.** Den POSTet til en voice-server på
> `localhost:8888` som ikke finnes i dette oppsettet — ingenting lytter der,
> og det har ingenting gjort. Handleren `voice-notification.ts` er slettet,
> og `curl`-oppskriftene som lå her ba modellen kalle en død endepunkt.
> Se K-08-nabolaget i `runbooks/hooksystemet.md`.
>
> `🗣️`-linja i responsformatet består. Den driver terminalfanens tittel via
> `handlers/tab-state.ts`, ikke tale.

---

## Task Start Announcements

**Når du STARTER en oppgave, si hva du gjør:**

```
[Det {PRINCIPAL.NAME} ba om]...
```

Hopp over det for samtalepregede svar — hilsener, kvitteringer, enkle
spørsmål og svar.

---

## Context-Aware Announcements

**Match varselet til det {PRINCIPAL.NAME} faktisk spurte om.** Start med
riktig verbalsubstantiv:

| {PRINCIPAL.NAME}s forespørsel | Form |
|------------------|-------------------|
| Spørsmål («Hvor er…», «Hva gjør…») | «Sjekker…», «Slår opp…», «Finner…» |
| Kommando («Fiks dette», «Lag det») | «Fikser…», «Lager…», «Oppdaterer…» |
| Undersøkelse («Hvorfor virker ikke…») | «Undersøker…», «Feilsøker…», «Analyserer…» |
| Research («Finn ut om…») | «Undersøker…», «Utforsker…», «Ser på…» |

---

## Workflow Invocation Notifications

**For skills med `Workflows/`-katalog:**

```
Executing the **WorkflowName** workflow within the **SkillName** skill...
```

For skills UTEN `Workflows/`-katalog: ingen egen varselseksjon. De beskriver
bare hva de gjør i svaret sitt.

---

## When to Skip Notifications

**Hopp alltid over når:**
- **Samtalepregede svar** — hilsener, kvitteringer, enkle spørsmål og svar
- **Skillet har ingen workflows**
- **SKILL.md håndterer forespørselen uten å laste en workflow-fil**
- **Raske operasjoner** — enkle fillesinger, statussjekker
- **Under-workflows** — når en workflow kaller en annen

**Regelen:** varsle bare når du faktisk laster og følger en `.md`-fil fra en
`Workflows/`-katalog, eller når du starter reelt arbeid.

---

## External Notifications (Push, Discord)

**Beyond voice notifications, PAI supports external notification channels:**

### Available Channels

| Channel | Service | Purpose | Configuration |
|---------|---------|---------|---------------|
| **ntfy** | ntfy.sh | Mobile push notifications | `settings.json → notifications.ntfy` |
| **Discord** | Webhook | Team/server notifications | `settings.json → notifications.discord` |
| **Desktop** | macOS native | Local desktop alerts | Always available |

### Smart Routing

Notifications are automatically routed based on event type:

| Event | Default Channels | Trigger |
|-------|------------------|---------|
| `taskComplete` | Voice only | Normal task completion |
| `longTask` | Voice + ntfy | Task duration > 5 minutes |
| `backgroundAgent` | ntfy | Background agent completes |
| `error` | Voice + ntfy | Error in response |
| `security` | Voice + ntfy + Discord | Security alert |

### Configuration

Located in `~/.opencode/settings.json`:

```json
{
  "notifications": {
    "ntfy": {
      "enabled": true,
      "topic": "kai-[random-topic]",
      "server": "ntfy.sh"
    },
    "discord": {
      "enabled": false,
      "webhook": "https://discord.com/api/webhooks/..."
    },
    "thresholds": {
      "longTaskMinutes": 5
    },
    "routing": {
      "taskComplete": [],
      "longTask": ["ntfy"],
      "backgroundAgent": ["ntfy"],
      "error": ["ntfy"],
      "security": ["ntfy", "discord"]
    }
  }
}
```

### ntfy.sh Setup

1. **Generate topic**: `echo "kai-$(openssl rand -hex 8)"`
2. **Install app**: iOS App Store or Android Play Store → "ntfy"
3. **Subscribe**: Add your topic in the app
4. **Test**: `curl -d "Test" ntfy.sh/your-topic`

Topic name acts as password - use random string for security.

### Discord Setup

1. Create webhook in your Discord server
2. Add webhook URL to `settings.json`
3. Set `discord.enabled: true`

### SMS (Not Recommended)

**SMS is impractical for personal notifications.** US carriers require A2P 10DLC campaign registration since Dec 2024, which involves:
- Brand registration + verification (weeks)
- Campaign approval + monthly fees
- Carrier bureaucracy for each number

**Alternatives researched (Jan 2025):**

| Option | Status | Notes |
|--------|--------|-------|
| **ntfy.sh** | ✅ RECOMMENDED | Same result (phone alert), zero hassle |
| **Textbelt** | ❌ Blocked | Free tier disabled for US due to abuse |
| **AppleScript + Messages.app** | ⚠️ Requires permissions | Works if you grant automation access |
| **Twilio Toll-Free** | ⚠️ Simpler | 5-14 day verification (vs 3-5 weeks for 10DLC) |
| **Email-to-SMS** | ⚠️ Carrier-dependent | `number@vtext.com` (Verizon), `@txt.att.net` (AT&T) |

**Bottom line:** ntfy.sh already alerts your phone. SMS adds carrier bureaucracy for the same outcome.

### Implementation

The notification service is in `~/.opencode/hooks/lib/notifications.ts`:

```typescript
import { notify, notifyTaskComplete, notifyBackgroundAgent, notifyError } from './lib/notifications';

// Smart routing based on task duration
await notifyTaskComplete("Task completed successfully");

// Explicit background agent notification
await notifyBackgroundAgent("Researcher", "Found 5 relevant articles");

// Error notification
await notifyError("Database connection failed");

// Direct channel access
await sendPush("Message", { title: "Title", priority: "high" });
await sendDiscord("Message", { title: "Title", color: 0x00ff00 });
```

---

## Event Log Channel (events.jsonl)

In addition to the voice, push, and Discord channels above, PAI hooks emit structured events to `${PAI_DIR}/MEMORY/STATE/events.jsonl`. This is an append-only JSONL file where each line is a typed event (e.g., `algorithm.phase`, `work.created`, `rating.captured`, `voice.sent`). It serves as a unified observability channel that any process can consume by tailing or watching the file.

Events are emitted via `appendEvent()` from `${PAI_DIR}/hooks/lib/event-emitter.ts`, which is synchronous and fire-and-forget. The event type system is defined in `${PAI_DIR}/hooks/lib/event-types.ts` as a TypeScript discriminated union covering 22 event interfaces. This channel is additive -- it does not replace any of the notification channels above, and hooks emit events alongside their existing state writes and notifications.

---

### Design Principles

1. **Fire and forget** - Notifications never block hook execution
2. **Fail gracefully** - Missing services don't cause errors
3. **Conservative defaults** - Avoid notification fatigue
4. **Duration-aware** - Only push for long-running tasks (>5 min)
