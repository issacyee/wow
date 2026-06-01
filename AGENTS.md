# pi.zero — Foundational AI Workflow pi Package

My personal foundational pi package, bundling essential universal features for daily AI coding workflows.

## Structure

```
pi.zero/
├── AGENTS.md               # This file — project context
├── package.json             # pi package manifest
├── extensions/
│   └── plan-mode/           # ?/??/$ plan mode extension
│       ├── index.ts         # Entry: prefix detection, context injection, tool interception
│       ├── plan.ts          # Plan item extraction, [DONE:n] tracking, text cleanup
│       └── safe.ts          # Bash safety check in planning mode
├── prompts/                 # Prompt templates (optional)
└── skills/                  # Skills (optional)
```

## Development Conventions

### Language Convention

- **Dialogue & output**: User-AI communication and AI responses use the OS language (dynamically determined by querying the OS locale).
- **Everything else**: Code, comments, config, documentation (including this file), commit messages, and technical content use English.

### Technical Conventions

- Use TypeScript, following existing code style
- Extension runtime dependencies (peerDependencies): `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`
- Run `/reload` or restart pi after editing extensions
- Keep the destructive patterns list in `safe.ts` comprehensive — omissions may cause data loss in plan mode
- The custom editor (`PlanModeEditor`) overrides `handleInput()` to convert full-width
  `？`/`！`/`￥` to half-width `?`/`!`/`$` at cursor position 0, so Chinese IME users
  don't need to toggle input method for plan-mode commands

## Plan Mode Reference

| Input | Behavior |
|-------|----------|
| `? <text>` | Start a new plan, read-only exploration |
| `?? <text>` | Continue/adjust the previous plan |
| `$` | Execute the current plan |
| `$ <text>` | Execute the plan with adjustments |

> **Chinese IME**: Full-width `？` `！` `￥` are automatically converted to `?` `!` `$`
> when typed at the start of the editor — no need to switch input methods.
