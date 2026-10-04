---
name: Agents
description: Dynamic agent composition. USE WHEN custom agents, agent personalities, traits, personas.
---

# Agents - Custom Agent Composition System

**Auto-routes when user mentions custom agents, agent creation, or specialized personalities.**

## Customization

**Before executing, check for user customizations at:**
`~/.opencode/PAI/USER/SKILLCUSTOMIZATIONS/Agents/`

If this directory exists, load and apply:
- `PREFERENCES.md` - Named agent roster summary
- `NamedAgents.md` - Full agent backstories and character definitions (optional)

These define user-specific named agents with persistent identities. If the directory does not exist, use only dynamic agent composition from traits.

## Overview

The Agents skill is a complete agent composition and management system. It consolidates all agent-related infrastructure:
- Dynamic agent composition from traits (expertise + personality + approach)
- Personality definitions
- Custom agent creation with unique personas
- Parallel agent orchestration patterns


## Notification

**When executing a workflow:**


1. **Output text notification**:
   ```
   Running the **WorkflowName** workflow from the **Agents** skill...
   ```

## Workflow Routing

**Available Workflows:**
- **CREATECUSTOMAGENT** - Create specialized custom agents → `Workflows/CreateCustomAgent.md`
- **LISTTRAITS** - Show available agent traits → `Workflows/ListTraits.md`
- **SPAWNPARALLEL** - Launch parallel agents → `Workflows/SpawnParallelAgents.md`

## Examples

**Example 1: Create custom agents for analysis**
```
User: "Spin up 5 custom science agents to analyze this data"
→ Invokes CREATECUSTOMAGENT workflow
→ Runs AgentFactory 5 times with DIFFERENT trait combinations
→ Each agent gets a unique personality
→ Launches agents in parallel with model: "sonnet"
```

**Example 2: List available traits**
```
User: "What agent personalities can you create?"
→ Invokes LISTTRAITS workflow
→ Displays expertise (security, legal, finance, etc.)
→ Shows personality types (skeptical, enthusiastic, analytical, etc.)
→ Lists approach styles (thorough, rapid, systematic, etc.)
```

**Example 3: Spawn parallel researchers**
```
User: "Launch 10 agents to research these companies"
→ Invokes SPAWNPARALLEL workflow
→ Creates 10 Intern agents (generic)
→ Uses model: "haiku" for speed
→ Launches spotcheck agent after completion
```

## Architecture

### Hybrid Agent Model

The system uses two types of agents:

| Type | Definition | Best For |
|------|------------|----------|
| **Named Agents** | Persistent identities with backstories (Remy, Ava, Marcus) | Recurring work, relationships |
| **Dynamic Agents** | Task-specific specialists composed from traits | One-off tasks, novel combinations, parallel work |

### The Agent Spectrum

```
┌─────────────────────────────────────────────────────────────────────┐
│   NAMED AGENTS          HYBRID USE          DYNAMIC AGENTS          │
│   (Relationship)        (Best of Both)      (Task-Specific)         │
├──────────────────────────────────────────────────────────────────────┤
│ Remy, Ava, Marcus   "Security expert      Ephemeral specialist      │
│                      with Johannes's      composed from traits      │
│                      skepticism"                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Route Triggers

**CRITICAL: The word "custom" is the KEY trigger:**

| User Says | What to Use | Why |
|-----------|-------------|-----|
| "**custom agents**", "create **custom** agents" | AgentFactory | Unique prompts + unique personas |
| "agents", "launch agents", "bunch of agents" | Generic Interns | Parallel grunt work |
| "use Remy", "get Ava to" | Named agent | Pre-defined personality |

**Other triggers:**
- "agent personalities", "available traits" → LISTTRAITS workflow
- "specialized agents", "expert in X" → CREATECUSTOMAGENT workflow
- "parallel agents", "spawn 5 agents" → SPAWNPARALLEL workflow

## Components

### Data

**Traits.yaml** (`Data/Traits.yaml`)
- Expertise areas: security, legal, finance, medical, technical, research, creative, business, data, communications
- Personality dimensions: skeptical, enthusiastic, cautious, bold, analytical, creative, empathetic, contrarian, pragmatic, meticulous
- Approach styles: thorough, rapid, systematic, exploratory, comparative, synthesizing, adversarial, consultative

### Templates

**DynamicAgent.hbs** (`Templates/DynamicAgent.hbs`)
- Handlebars template for dynamic agent prompts
- Composes: expertise + personality + approach
- Includes operational guidelines and response format

### Tools

**AgentFactory.ts** (`Tools/AgentFactory.ts`)
- Dynamic agent composition engine
- Infers traits from task description
- Outputs complete agent prompt ready for Task tool

```bash
# Usage examples
bun run ~/.opencode/skills/Agents/Tools/AgentFactory.ts --task "Review security architecture"
bun run ~/.opencode/skills/Agents/Tools/AgentFactory.ts --traits "legal,skeptical,meticulous"
bun run ~/.opencode/skills/Agents/Tools/AgentFactory.ts --list
```

### Personalities

**AgentPersonalities.md** (`AgentPersonalities.md`)
- Named agent definitions with full backstories
- Personality traits
- Character development and communication styles

**Named Agents:**
- Jamie - Expressive eager buddy
- Rook Blackburn (Pentester) - Reformed grey hat
- Priya Desai (Artist) - Aesthetic anarchist
- Aditi Sharma (Designer) - Design school perfectionist
- Dev Patel (Intern) - Brilliant overachiever
- Ava Chen (Perplexity) - Investigative analyst
- Ava Sterling (Claude) - Strategic sophisticate
- Alex Rivera (Gemini) - Multi-perspective analyst
- Marcus Webb (Engineer) - Battle-scarred leader
- Serena Blackwood (Architect) - Academic visionary
- Emma Hartley (Writer) - Technical storyteller

## Integration Points

**PAI Skill** (`~/.opencode/PAI/`)
- References Agents skill for custom agent creation
- Documents the custom vs generic distinction
- Includes agent creation in delegation patterns

## Usage Patterns

### For Users (Natural Language)

Users talk naturally:
- "I need a legal expert to review this contract" → System composes legal + analytical + thorough agent
- "Spin up 5 custom science agents" → System uses AgentFactory 5 times with different traits
- "Launch agents to research these companies" → System spawns generic Intern agents
- "Get me someone skeptical about security" → System composes security + skeptical + adversarial agent

### Internal Process

When user says "custom agents", the assistant:
1. Invokes CREATECUSTOMAGENT workflow
2. Runs AgentFactory for EACH agent with DIFFERENT trait combinations
3. Gets a unique prompt for each
4. Launches agents using Task tool with the composed prompt
5. Each agent has a distinct personality

Example internal execution:
```bash
# User: "Create 3 custom research agents"

# Agent 1
bun run AgentFactory.ts --traits "research,enthusiastic,exploratory"
# Output: Prompt for an energetic persona

# Agent 2
bun run AgentFactory.ts --traits "research,skeptical,thorough"
# Output: Prompt for an intellectual persona

# Agent 3
bun run AgentFactory.ts --traits "research,analytical,systematic"
# Output: Prompt for a professional persona

# Launch all 3 with Task tool
Task({ prompt: <agent1_prompt>, subagent_type: "Intern", model: "sonnet" })
Task({ prompt: <agent2_prompt>, subagent_type: "Intern", model: "sonnet" })
Task({ prompt: <agent3_prompt>, subagent_type: "Intern", model: "sonnet" })
```

## Model Selection

Always specify the appropriate model:

| Task Type | Model | Speed Multiplier |
|-----------|-------|------------------|
| Grunt work, simple checks | `haiku` | 10-20x faster |
| Standard analysis, research | `sonnet` | Balanced |
| Deep reasoning, architecture | `opus` | Maximum intelligence |

**Rule:** Parallel agents especially benefit from `haiku` for speed.

## Related Skills

- **CORE** - Main system identity and delegation patterns
- **Development** - Uses Engineer and Architect agents

## Version History

- **v1.0.0** (2025-12-16): Initial creation - consolidated all agent infrastructure into discrete skill
