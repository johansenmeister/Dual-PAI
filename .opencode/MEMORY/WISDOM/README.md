# Wisdom Frames

Wisdom Frames are PAI's dual-loop learning system (v1.8.0). They compound knowledge across sessions:

- **OBSERVE reads:** Before ISC creation, applicable frames are read to inform better criteria
- **LEARN writes:** After Algorithm Reflection, domain-relevant observations are extracted and appended

## Frame Format

Each frame is a Markdown file named after its domain (e.g., `development.md`, `security.md`).

```markdown
# Wisdom Frame: {domain}

## Anti-Patterns
- {observation} (source: session {date}, type: anti-pattern)

## Contextual Rules
- {observation} (source: session {date}, type: contextual-rule)

## Predictions
- {observation} (source: session {date}, type: prediction)

## Principles
- {observation} (source: session {date}, type: principle)
```

## Management

Frames can be updated:
1. **Manually:** Edit the Markdown file directly
2. **Via CLI:** `bun WisdomFrameUpdater.ts --domain X --observation "Y" --type Z`
3. **Via Algorithm:** The LEARN phase appends observations automatically

## Domains

| Domain | Focus |
|--------|-------|
| `development` | Code patterns, build tools, testing, languages |
| `deployment` | Infrastructure, CI/CD, environments, hosting |
| `security` | Auth, secrets, vulnerability patterns, scanning |
| `architecture` | System design, integration patterns, ADRs |
| `communication` | User interaction, documentation, formatting |

New domains can be created as needed. The CLI tool creates the frame file if it doesn't exist.
