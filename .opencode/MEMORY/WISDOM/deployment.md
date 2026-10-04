# Wisdom Frame: deployment

## Anti-Patterns
- Wrangler hangs indefinitely if stdin is not closed — always use `< /dev/null` suffix (source: Cloudflare Pages deployment, type: anti-pattern)
- File permissions below 644 cause silent upload failures on Cloudflare Pages (source: wrangler deployment debugging, type: anti-pattern)

## Contextual Rules
- Always close stdin for wrangler deployments: `wrangler pages deploy . --project-name=X < /dev/null` (source: deployment learning, type: contextual-rule)
- Ensure correct file permissions before deployment: 644 for files, 755 for directories (source: deployment learning, type: contextual-rule)
- Hetzner-first for sovereignty and cost. Cloudflare for edge compute and static hosting. (source: tech stack preferences, type: contextual-rule)

## Predictions

## Principles
- Push to main → live in 30 seconds. Zero-config deployment is the standard. (source: VitePress+CF Pages pattern, type: principle)
