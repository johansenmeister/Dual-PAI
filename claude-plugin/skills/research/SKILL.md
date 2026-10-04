---
# GENERERT av Tools/BuildClaudePlugin.ts — ikke rediger.
# Kilde: .opencode/skills/Research/SKILL.md
# Endringer hører hjemme i kilden; kjør deretter generatoren på nytt.
name: research
description: Comprehensive research and content extraction. USE WHEN research, investigate, extract wisdom, analyze content. For OSINT use the WebAssessment skill.
---

## Customization

**Before executing, check for user customizations at:**
`~/.opencode/PAI/USER/SKILLCUSTOMIZATIONS/Research/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

# Research Skill

Comprehensive research, analysis, and content extraction system.

## MANDATORY: URL Verification

**READ:** `UrlVerificationProtocol.md` - Every URL must be verified before delivery.

Research agents hallucinate URLs. A single broken link is a catastrophic failure.

---

## Notification

**When executing a workflow:**


1. **Output text notification**:
   ```
   Running the **WorkflowName** workflow from the **Research** skill...
   ```

## Workflow Routing

Route to the appropriate workflow based on the request.

**CRITICAL:** For due diligence, company/person background checks, or vetting -> **use the OSINT workflows in the WebAssessment skill** (`skills/Security/WebAssessment/Workflows/osint/MasterGuide.md`)

### Research Modes (Primary Workflows)
- Quick research - **DEFAULT** (1 Claude, FREE) → `Workflows/QuickResearch.md`
- Standard research (3 agents: Claude + Gemini + Perplexity Sonar, ~$0.01) → `Workflows/StandardResearch.md`  
  Trigger: "standard research", "thorough research", "research X from multiple angles"
- Extensive research (4-5 providers, flexible angles, ~$0.10-0.50) → `Workflows/ExtensiveResearch.md`
  Trigger: "extensive research" - **REQUIRES USER CONFIRMATION**

### Controller & Constraints
- Research with enforced recursion limits → `ResearchController.md`  
  **READ FIRST:** When spawning parallel research agents to prevent Matryoshka Paradox

### Deep Content Analysis
- Extract alpha / deep analysis / highest-alpha insights -> `Workflows/ExtractAlpha.md`

### Content Retrieval
- Difficulty accessing content (CAPTCHA, bot detection, blocking) -> `Workflows/Retrieve.md`
- YouTube URL extraction (use `fabric -y URL` immediately) -> `Workflows/YoutubeExtraction.md`
- Web scraping -> `Workflows/WebScraping.md`

### Specific Research Types
- Claude WebSearch only (free, no API keys) -> `Workflows/ClaudeResearch.md`
- Perplexity API research (use Quick for single-agent) -> `Workflows/QuickResearch.md`
- Interview preparation (Tyler Cowen style) -> `Workflows/InterviewResearch.md`
- AI trends analysis -> `Workflows/AnalyzeAiTrends.md`

### Fabric Pattern Processing
- Use Fabric patterns (242+ specialized prompts) -> `Workflows/Fabric.md`

### Content Enhancement
- Enhance/improve content -> `Workflows/Enhance.md`
- Extract knowledge from content -> `Workflows/ExtractKnowledge.md`

---

## Quick Reference

**READ:** `QuickReference.md` for detailed examples and mode comparison.

| Trigger | Mode | Agents | Cost | Speed |
|---------|------|--------|------|-------|
| "research X" (default) | Quick | 1 Claude | **$0 FREE** | ~10-15s |
| "standard research" | Standard | 3 (Claude+Gemini+Perplexity) | ~$0.01 | ~15-30s |
| "extensive research" | Extensive | 4-15 (flexible) | ~$0.10-0.50 | ~60-120s |

---

## Integration

### Feeds Into
- **blogging** - Research for blog posts
- **newsletter** - Research for newsletters
- **xpost** - Create posts from research

### Uses
- **be-creative** - deep thinking for extract alpha
- **WebAssessment (OSINT workflows)** - MANDATORY for company/people comprehensive research
- **BrightData MCP** - CAPTCHA solving, advanced scraping
- **Apify MCP** - RAG browser, specialized site scrapers

---

## File Organization

**Scratch (temporary work artifacts):** `~/.opencode/MEMORY/WORK/{current_work}/scratch/`
- Read `~/.opencode/MEMORY/STATE/current-work.json` to get the `work_dir` value
- All iterative work artifacts go in the current work item's scratch/ subdirectory
- This ties research artifacts to the work item for learning and context

**History (permanent):** `~/.opencode/History/research/YYYY-MM/YYYY-MM-DD_[topic]/`

---

## ⚠️ MANDATORY: Research Agent Constraints

**CRITICAL RULES to prevent Matryoshka Paradox (recursive agent spawning):**

### 1. Recursion Depth Limit
- **MAXIMUM 1 level deep**: Parent Research Agent → Sub-Agent(s)
- **Sub-Agents CANNOT spawn further research agents**
- Any research task requiring more depth must be handled by the parent

### 2. Sub-Agent Tier Restrictions
When a Research Agent spawns Sub-Agents:
- ✅ **ALLOWED**: `QuickResearch` (1 agent, FREE)
- ✅ **ALLOWED**: `StandardResearch` (3 agents, ~$0.01)
- ❌ **FORBIDDEN**: `ExtensiveResearch` in Sub-Agents

### 3. ExtensiveResearch Requires Human Approval
- ExtensiveResearch (~$0.10-0.50) **MUST** get explicit user confirmation before executing
- Sub-Agents **CANNOT** auto-trigger expensive research modes
- Pattern: Ask user → Get confirmation → Then spawn

### 4. Enforcement
**When implementing research workflows:**
```
// Parent agent (you) decides tier
IF cost < $0.01 AND no_sub_agents_needed:
  → Use QuickResearch or StandardResearch
  
IF cost > $0.01 OR complex multi-angle:
  → Ask user for ExtensiveResearch approval
  → Only spawn Sub-Agents with Quick/Standard modes
  → Sub-Agents return results to parent
  → Parent synthesizes (no further spawning)
```

**Violation:** If you see a plan with 3+ levels of research agents, STOP and restructure.
