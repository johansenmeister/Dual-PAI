# ResearchController Workflow

**Purpose:** Execute research with enforced constraints to prevent recursive agent spawning.

---

## The Matryoshka Problem

Research Agents spawning Research Agents spawning Research Agents creates:
- Exponential cost escalation ($0.01 → $0.50 → $5.00+)
- Unpredictable latency (15s → 60s → 5min+)
- Loss of quality control at deeper levels
- Cascade failures when one sub-agent fails

**This workflow enforces hard limits.**

---

## Constraint Enforcement

### Tier Limits by Call Depth

| Depth | Caller | Allowed Modes | Max Cost |
|-------|--------|--------------|----------|
| 0 | You (User/Opus) | All (Quick/Standard/Extensive) | - |
| 1 | Sub-Agent spawned by you | QuickResearch, StandardResearch only | ~$0.01 |
| 2+ | **FORBIDDEN** | No spawning allowed | - |

### Rule: No ExtensiveResearch in Sub-Agents

**ExtensiveResearch requires explicit human confirmation.**

When spawning research Sub-Agents:
- ✅ Use `QuickResearch` for focused queries
- ✅ Use `StandardResearch` for multi-angle (3 agents)
- ❌ **NEVER** use `ExtensiveResearch` in Sub-Agents
- ❌ **NEVER** let Sub-Agents decide to spawn more agents

---

## Execution Patterns

### Pattern 1: Simple Research (You → QuickResearch)

```
User asks for research
    ↓
You spawn ONE QuickResearch agent
    ↓
Agent returns results directly to you
    ↓
You synthesize and respond
```

### Pattern 2: Multi-Angle (You → StandardResearch)

```
User asks for thorough research
    ↓
You spawn StandardResearch (Claude + Gemini + Perplexity)
    ↓
All 3 agents return results TO YOU
    ↓
You synthesize cross-agent findings
    ↓
You respond with unified analysis
```

### Pattern 3: Deep Research (You → Ask → ExtensiveResearch)

```
User asks for extensive research
    ↓
You estimate cost ($0.10-0.50)
    ↓
You ASK user: "Extensive research costs ~$0.30. Proceed?"
    ↓
User confirms
    ↓
You spawn ExtensiveResearch agent
    ↓
Agent returns results TO YOU
    ↓
You synthesize (NO further agent spawning)
    ↓
You respond
```

### ❌ ANTI-PATTERN: The Matryoshka

```
You spawn Research Agent A
    ↓
Agent A spawns 3 Sub-Agents (B, C, D) for "parallel angles"
    ↓
Agent B spawns 2 more Sub-Agents
    ↓
Agent C spawns ExtensiveResearch "for thoroughness"
    ↓
Cost: $0.01 → $0.03 → $0.15 → $0.50 → $2.00+
Latency: 15s → 45s → 2min → 5min → 10min+
Result: Unpredictable, expensive, uncontrolled
```

---

## Implementation Template

### When Spawning Research Sub-Agents

**ALWAYS include this constraint in your prompt:**

```markdown
## CONSTRAINT: No Further Agent Spawning

You are executing research at DEPTH LEVEL 1.

**YOU MAY NOT:**
- Spawn additional research agents
- Call any `Research:*` workflows
- Use `Task` tool with researcher subagent_types
- Trigger ExtensiveResearch mode

**YOU MUST:**
- Complete research using your own capabilities
- Return findings directly to parent
- Flag if you need more resources (parent decides)

**Violation:** Spawning agents from this context will be rejected.
```

### Cost Control Checklist

Before spawning any research agent:

- [ ] What is my current depth level? (0 = you, 1 = sub-agent)
- [ ] What mode am I using? (Quick/Standard allowed at depth 1, Extensive only at depth 0)
- [ ] If Extensive: Have I gotten user confirmation?
- [ ] Have I included "no further spawning" constraint in prompt?
- [ ] Does my plan stop at depth 1?

---

## Error Recovery

### If a Sub-Agent Tries to Spawn More Agents

**Detect:**
```
Sub-Agent output includes:
- "I will now spawn..."
- "Launching parallel researchers..."
- Task tool calls with subagent_type
```

**Response:**
```
STOP. Your plan violates the Research Constraint.

You are at DEPTH 1. You may NOT spawn further agents.

Restructure your approach:
1. Complete research using your own capabilities
2. Return raw findings to me
3. I will synthesize across all sub-agents
```

### If Cost Exceeds Budget

**At spawn time:**
```
Estimated cost: $0.45 (ExtensiveResearch)
Do you want to proceed? [Y/n]
```

**If user declines:**
- Fall back to StandardResearch
- Or break into smaller QuickResearch chunks

---

## Examples

### ✅ CORRECT: You orchestrate all spawning

```
User: "Research MoltBook security failures, crypto scams, and workforce impact"

You:
1. Recognize 3 parallel topics
2. Spawn 3× StandardResearch agents simultaneously (DEPTH 1)
   - Agent A: Security failures (MoltBook CVEs, Wiz)
   - Agent B: Crypto scams (CLAW token, Evil Manifesto)
   - Agent C: Workforce impact (Hourglass, skill degradation)
3. All return to YOU
4. YOU synthesize into unified blog outline
5. YOU respond with structured research brief
```

### ❌ WRONG: Recursive delegation

```
User: "Research MoltBook security failures, crypto scams, and workforce impact"

You:
1. Spawn ONE Research Agent with: "Research all 3 topics"
    ↓
Agent A (depth 1):
2. Spawns 3 Sub-Agents for parallel topics (now depth 2)
    ↓
Agent A-1 (depth 2):
3. Spawns ExtensiveResearch for "thoroughness" (depth 3, $0.30)
    ↓
Total cost: $0.01 → $0.03 → $0.30+ per branch
Total latency: Unpredictable
Quality control: Lost at depth 2+
```

---

## Quick Reference

| Scenario | Your Action | Sub-Agent Mode | Max Depth |
|----------|-------------|----------------|-----------|
| Quick fact check | Spawn 1 agent | QuickResearch | 1 |
| Multi-angle analysis | Spawn 3 agents | StandardResearch | 1 |
| Deep investigation | Ask user first, then spawn 1 | ExtensiveResearch | 1 |
| Complex synthesis | YOU synthesize results | N/A | 0 |
| 4+ parallel topics | Spawn 4 agents | StandardResearch | 1 |

**Remember:** You are the orchestrator. Sub-agents execute. Sub-agents do NOT orchestrate.
