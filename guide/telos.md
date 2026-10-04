---
title: Your goals (TELOS)
updated: 2026-10-04
---

# Your goals (TELOS)

TELOS is a short file about what you are working towards: your mission, your
goals, and what gets in the way. With it, your assistant can weigh advice
against what matters to you, instead of giving the same answer it would give
anyone. It is optional; PAI works without it.

## Before you write it

`.opencode/PAI/USER/TELOS/TELOS.md` goes into the context of **every session**:
the model provider receives it each time. So:

- **Know the model's data terms.** `SETUP.md`, "Language and welcome", has a
  table for the free models. Some providers keep what you send, or train on it.
  Write TELOS with a model whose terms you accept, or leave it out.
- **Keep it in a private repository.** It is in git, like the rest of
  `PAI/USER/`. Never push it anywhere public.
- **Keep it short.** Under a page. Every line is sent with every session.

## Writing it

The setup conversation (`SETUP.md`, "Goals (TELOS), optional and last") asks a
few questions and writes the file. By hand, three headings are enough:

```markdown
# TELOS

## Mission
One or two sentences: what you are about.

## Goals
- What you want to reach this year, a few lines.

## Challenges
- What gets in the way.
```

## Growing it

The **Telos** skill keeps it up to date. Say "update my goals" or "add to my
TELOS": it changes the file, keeps a dated backup in `TELOS/backups/`, and logs
the change in `TELOS/updates.md`. It can also hold more than the one file (books,
beliefs, lessons, predictions); only `TELOS.md` goes into every session, the
others are read when the skill needs them.

## Taking it out

Delete or empty `TELOS.md`. The next session starts without it.
