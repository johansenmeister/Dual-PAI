---
name: SuggestSkills
description: Discover WHICH new skills to create, from your own work sessions plus low ratings. Read-only and proposal-only — surfaces recurring pain no existing skill or workflow covers, and hands back a ranked shortlist to build with CreateSkill; never creates or edits a skill itself. USE WHEN should I create a skill, what skills do I need, suggest skills, skill gap, am I missing a skill, what should I build next, based on my recent work. NOT FOR creating, validating or updating one skill (use CreateSkill).
---

# SuggestSkills

A read-only pass over your own work that answers one question: is there a recurring problem that deserves its own skill and does not have one yet? It proposes; you decide; `CreateSkill` builds. It has no way to create or edit a skill, by design.

Ported from [LifeOS v7.40.4](https://github.com/danielmiessler/LifeOS/tree/v7.40.4/LifeOS/install/skills/SuggestSkills) (MIT), adapted to this tree's memory layout.

## Notification

**When executing a workflow, output a text notification:**

```
Running **Scan** in **SuggestSkills**...
```

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Scan** | "what skills should I build", "skill gap", "suggest skills", "am I missing a skill" | `Workflows/Scan.md` |

In short:

1. **Gather deterministically.** `Tools/CollectSignals.ts` emits the corpus: work sessions in the window (title, date, harness), low ratings with their note, and every skill and workflow for dedup. The model does not gather; it judges what the tool returns, so two runs see the same evidence.
2. **Cluster by pain**, carrying both how often a theme recurs and how much frustration it drew.
3. **Dedup against real coverage.** Read the bodies of the skills and workflows that might cover a theme. A name match is not coverage.
4. **Two independent passes, report the UNION**, tagged by agreement.
5. **Propose, never create.** A ranked shortlist with evidence; accepted proposals go to `CreateSkill` as a separate step.

## Examples

**Example 1: Routine gap scan**
```
User: "What skills should I build based on my recent work?"
→ Invokes Scan
→ CollectSignals over the last 45 days
→ Clusters sessions and low ratings, dedups against existing skills and workflows
→ Ranked shortlist with evidence per proposal; nothing is created
```

**Example 2: Frustration-led scan**
```
User: "I keep hitting the same wall — am I missing a skill?"
→ Invokes Scan with the low ratings as the lead signal
→ Surfaces discipline gaps hiding under topics that look covered
→ User accepts one proposal → handed to CreateSkill as a separate step
```

## Gotchas

- **A clean coverage result with dirty frustration signals is a false negative.** If the ratings show recurring frustration in an area marked covered, re-open it: the discipline under that topic is the gap.
- **The rating signal is thin.** Implicit ratings are only written for non-neutral messages, and explicit ones are rare, so a 45-day window may hold a handful. Say how many the scan saw; widen the window rather than present a topic-only result as complete.
- **Recurrence is severity-weighted, not a bare count.** One long, painful, repeated migration outweighs three trivial sessions.
- **Behavior is not a skill.** "Too verbose", "misread the scope", "repeated a reminder" are steering, not skill gaps: route them to the steering rules or memory, not to CreateSkill.
- **Gathering is deterministic on purpose.** If you find yourself grepping the stores by hand, use the tool instead.
- **Session dates come from the directory name or `META.yaml`, not mtime.** The memory tree is synced with git, so mtime is the last pull.
