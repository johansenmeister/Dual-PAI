# Wisdom Frame: development

## Anti-Patterns
- Using npm instead of Bun for package management causes inconsistency (source: PAI-OpenCode setup, type: anti-pattern)
- Using ESLint+Prettier instead of Biome adds unnecessary complexity (source: tech stack decisions, type: anti-pattern)

## Contextual Rules
- Always use Bun as runtime and package manager — never npm, yarn, or pnpm (source: tech stack preferences, type: contextual-rule)
- TypeScript for everything: backend, frontend, CLIs, Workers, tools (source: tech stack preferences, type: contextual-rule)
- Biome replaces ESLint+Prettier as the single linting/formatting tool (source: tech stack preferences, type: contextual-rule)

## Predictions

## Principles
- Code solves infrastructure problems. Prompts solve thinking problems. Don't confuse the two. (source: Algorithm v1.1.0, type: principle)
- CLI tools must be pure — no LLM inside. The orchestrator decides, tools execute. (source: PAI architecture, type: principle)
