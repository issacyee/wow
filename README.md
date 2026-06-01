# pi.zero

A foundational pi package bundling essential features for daily AI coding workflows.

## Installation

Clone the repository into your pi packages directory:

```bash
git clone <repo-url> ~/.pi/packages/pi.zero
```

Or symlink to a local development directory. See [pi packages docs](https://github.com/earendil-works/pi) for details.

## Features

### Plan Mode — `?` / `??` / `$`

A stateless planning workflow that prompts the AI to produce a plan before executing.

| Input | Behavior |
|-------|----------|
| `? <text>` | Start a new plan, read-only exploration |
| `?? <text>` | Continue/adjust the previous plan |
| `$` | Execute the current plan |
| `$ <text>` | Execute the plan with adjustments |

- **Editor border colors**: orange (`#f5a742`) in `?` / `??` mode, blue (`#5c9cf5`) in `$` execution mode — visual feedback for the current mode
- **Read-only safety**: planning mode automatically blocks `edit` / `write` tools and dangerous bash commands, preventing accidental modifications
- **Progress tracking**: `[DONE:n]` markers in AI responses are recognized automatically; a completion summary is emitted when all steps are done
- **Chinese IME friendly**: Full-width `？` `！` `￥` typed at the start of the editor
  are automatically converted to `?` `!` `$` — no need to switch input methods

## Development

```bash
# After editing extensions, run /reload or restart pi
```

### Conventions

- **Dialogue**: user-AI communication uses the OS locale language
- **Technical content**: code, comments, config, documentation, commit messages use English
- **Code style**: TypeScript, following existing conventions

### Project Structure

```
pi.zero/
├── AGENTS.md                # Project context
├── LICENSE                  # MIT License
├── package.json             # Pi package manifest
├── extensions/
│   └── plan-mode/           # ?/??/$ plan mode extension
│       ├── index.ts         # Entry: prefix detection, context injection, tool interception
│       ├── plan.ts          # Plan item extraction, [DONE:n] tracking, text cleaning
│       └── safe.ts          # Bash safety check in planning mode
├── prompts/                 # Prompt templates (optional)
└── skills/                  # Skills (optional)
```

## License

[MIT](LICENSE) © 2026 issacyee
