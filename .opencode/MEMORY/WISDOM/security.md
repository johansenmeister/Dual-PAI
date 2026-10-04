# Wisdom Frame: security

## Anti-Patterns
- Env var prefixes (export, set, declare) can bypass SecurityValidator pattern matching — must strip before checking (source: upstream fix #620, type: anti-pattern)
- Fail-closed on plugin errors disrupts the user more than the security risk warrants for non-critical checks (source: ADR-006, type: anti-pattern)

## Contextual Rules
- Security patterns must be preserved 1:1 from upstream per ADR-006 (source: PAI-OpenCode architecture, type: contextual-rule)
- Fail-open on plugin errors is a deliberate design decision for non-blocking security (source: security-validator.ts, type: contextual-rule)
- No secrets in git history. TruffleHog before commits. (source: tech stack preferences, type: contextual-rule)

## Predictions

## Principles
- Security is additive — only ADD checks, never remove existing patterns during porting (source: ADR-006, type: principle)
