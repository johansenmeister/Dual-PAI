# Wisdom Frame: architecture

## Anti-Patterns
- Porting Claude Code hooks as-is to OpenCode — must translate to plugin handlers per ADR-001 (source: v3.0 migration, type: anti-pattern)
- Hardcoding ~/.claude/ or ~/.opencode/ paths instead of using PAI_DIR environment variable (source: upstream sync, type: anti-pattern)

## Contextual Rules
- Hooks translate to unified plugin handlers in pai-unified.ts per ADR-001 (source: PAI-OpenCode architecture, type: contextual-rule)
- .claude/ paths become .opencode/ paths per ADR-002 (source: PAI-OpenCode architecture, type: contextual-rule)
- Skills port 1:1 from upstream per ADR-003 (source: PAI-OpenCode architecture, type: contextual-rule)
- File logging only in plugins — never console.log per ADR-004 (source: PAI-OpenCode architecture, type: contextual-rule)
- Use PAI_DIR env var with ~/.opencode fallback for all tool path construction (source: upstream sync v1.8.0, type: contextual-rule)

## Predictions

## Principles
- Three-Layer Sovereignty: self-hosted for critical, API-first for replaceable, SaaS for convenience (source: ADR-001, type: principle)
