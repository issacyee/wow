# Wow

[English](README.md) | [简体中文](README.zh-CN.md)

A pi package bundling essential features for daily AI coding workflows.

## Installation

Wow is a [pi](https://pi.dev) package. Pi is a terminal coding agent/harness
that can be extended with TypeScript extensions, skills, prompt templates, and
themes. Pi packages bundle those resources so they can be installed from npm,
git, or local paths.

Install pi first if you do not already have it:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
# or
curl -fsSL https://pi.dev/install.sh | sh
```

Then authenticate pi with `/login` or a provider API key. See the pi docs for
model/provider setup.

This repository is a GitHub template repository because Wow is a personal pi
package. Many features are tailored to my own workflow, may change frequently
based on day-to-day usage, and can include breaking changes without versioned
releases.

If you want to use this package as-is, install it from git:

```bash
pi install git:github.com/issacyee/wow
```

Pi packages run with full system access through their extensions, so review the
source before installing any third-party package.

If you want to build your own personal workflow package based on Wow, create a
new repository from this template instead of forking it. That keeps your custom
package independent from this repository's frequent personal changes.

## Features

### Human-Led Coding Workflow — `?` / `??` / `?!` / `$`

A human-led coding workflow where the user decides when to discuss, plan, revise,
and execute. Normal prompts keep pi's default behavior; the workflow only activates
when a prefix is used.

| Input | Behavior |
|-------|----------|
| `? <text>` | Discuss/analyze only — read-only exploration, no plan required |
| `?? <text>` | Write a new reviewable plan, replacing any active plan |
| `??` | Write a plan from the most recent `?` discussion, if available |
| `?! <text>` | Revise the current active plan from explicit review feedback |
| `$` | Execute the current active plan |
| `$ <text>` | Execute the current active plan with extra constraints |

- **Human-led control**: ordinary input remains free-form; plan feedback requires `?!`; execution requires `$`
- **Read-only discussion/planning/revision**: these modes allow `read`, `grep`, `find`, `ls`, safe read-only `bash`, and `webfetch`, while blocking `edit`, `write`, and unsafe commands
- **Reviewable plan structure**: plans include Goals, Background, Key Decisions, Non-goals, Implementation Steps, Acceptance Criteria, Verification, and Risks, ending with `Ready to execute?`
- **Execution summary**: execution responses are guided to include Summary, Modified Files, and Follow-up Suggestions; commits remain manual
- **Prefix-cache friendly**: the extension never mutates the system prompt, never switches active tools, filters stale workflow context messages from provider context, and stores state in custom entries outside LLM context
- **UI-independent logic**: workflow state is exposed from `state.ts`; editor colors, status, and todo widgets are presented by `wow-tui`

### Locale — Stable Same-Language Policy

Adds a byte-stable language policy to the system prompt: reply in the same language
the user is using, while preserving technical identifiers exactly. The extension no
longer injects OS-specific hidden messages every turn, which keeps the prompt prefix
stable for provider prefix-cache/APC systems.

### Git Commit — `/git-commit`

Generates a terse [Conventional Commits](https://www.conventionalcommits.org/) message
from staged changes via a direct LLM call (isolated from main session context), then
executes the commit. Uses "caveman-commit" style — ultra-compressed, subject ≤50 chars,
body only when the "why" isn't obvious. No AI attribution, no emoji, no fluff.

Optionally pass extra context: `/git-commit refactor for performance`.

### Command Mappings — Declarative Aliases

Registers command aliases via a declarative array in one extension, instead of creating
one file per alias. Currently provides `/exit` as an alias for the built-in `/quit`.
Add new mappings by appending entries to the `COMMAND_MAPPINGS` array.

### Wow TUI — Unified Visual Shell

`wow-tui` is the package's single visual compositor. It centralizes pure TUI behavior
so logic extensions can be used without visual code. Removing `./extensions/wow-tui/index.ts`
from `package.json` disables these visuals while leaving workflow/cache/tool logic enabled.

It owns package-level singleton TUI resources:

- **Footer compositor**: custom two-line footer with clickable CWD, git branch, model/thinking level, context usage bar, token/cache/cost stats, and extension statuses
- **Composite editor**: `𝝅` top-border label, workflow prefix border colors, and Chinese IME full-width prefix conversion (`？` `！` `￥` → `?` `!` `$`)
- **Workflow presenter**: status indicator and todo widget based on workflow state
- **Focus-style tool rendering**: built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) render as single dim-text lines with hidden result previews

Custom tools can reuse the same dim rendering via shared utilities from `wow/renderer.ts`
(`createFocusRenderCall`, `focusRenderResult`).

### Prefix Cache — Reasonix-Style Prompt Stability

Optimizes provider prefix-cache hit rate, especially for DeepSeek/OpenAI-compatible
reasoning models:

- Strips assistant `thinking` / `reasoning_content` from the provider context copy while preserving it in the local session/UI
- Canonicalizes OpenAI-compatible provider tool schemas and sorts tools by name for deterministic payload bytes
- Caps text tool results at 32KB in LLM context and saves oversized full output to a temp file
- Keeps workflow modes from switching active tools; safety is enforced by `tool_call` gates instead
- Provides `/cache-stats` for session cache usage and `/cache-doctor` for common stability problems

**Development rule:** future extensions should avoid per-turn system prompt mutations,
active tool switching, nondeterministic tool schemas, and oversized tool results.
Put dynamic mode state in user/custom turn-tail messages or runtime gates instead.

### WebFetch — Fetch Web Content

Fetches content from a URL and converts to the requested format (markdown, text, or html).
Built on Node.js native `fetch` — HTML conversion powered by node-html-markdown
(AST-based) for reliable, high-quality output.

**Features:**
- User-Agent spoofing and Accept header negotiation for best content type
- Cloudflare 403 bot-detection retry with honest UA fallback
- 5MB response size limit, configurable timeout (default 30s, max 120s)
- 32KB LLM-context output limit; full oversized output is saved to a temp file
- Raster image detection with base64 encoding
- URL parameters rendered as clickable hyperlinks in supported terminals
- Allowed during human-led workflow exploration; write safety is enforced by runtime gates, not active-tool switching

**Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `url` | (required) | The URL to fetch content from |
| `format` | `"markdown"` | Output format: `markdown`, `text`, or `html` |
| `timeout` | 30 | Timeout in seconds (max 120) |

## Architecture

### Shared Utility Layer — `extensions/wow/`

The package uses a centralized base extension (`wow`) that provides shared utilities
for all other extensions. It registers nothing at runtime and has no side effects —
it serves purely as an import source for common functions.

| Sub-module | Exports | Used by |
|------------|---------|---------|
| `locale.ts` | `detectLocale`, `detectPrimaryLocale`, `localeToDisplayName`, `buildLanguageInstruction`, `buildStableLanguagePolicy`, `LOCALE_MAP` | locale, local UI/template helpers |
| `renderer.ts` | `createFocusRenderCall`, `focusRenderCall`, `focusRenderResult` | webfetch, custom tools |
| `paths.ts` | `shortenPath`, `linkPath`, `shortenCommand` | wow-tui |
| `html.ts` | `convertHTMLToMarkdown`, `extractTextFromHTML`, `stripTags`, `isRasterImage`, `STRIP_TAGS` | webfetch |
| `shell.ts` | `execOrNull`, `execWithError` | git-commit |
| `safe.ts` | `isSafeCommand` | human-led-coding-workflow |

Each sub-module can be imported directly by relative path:

```typescript
import { detectPrimaryLocale } from "../wow/locale.ts";
import { createFocusRenderCall, focusRenderResult } from "../wow/renderer.ts";
import { shortenPath, linkPath } from "../wow/paths.ts";
import { convertHTMLToMarkdown } from "../wow/html.ts";
import { execOrNull, execWithError } from "../wow/shell.ts";
import { isSafeCommand } from "../wow/safe.ts";
```

Or import everything from the unified entry:

```typescript
import { detectLocale, createFocusRenderCall, shortenPath } from "../wow/index.ts";
```

### Logic / Visual Boundary

- Logic extensions own behavior, state, tools, commands, provider hooks, and safety gates.
- `wow-tui` owns package-level visual composition and singleton TUI resources.
- Logic extensions should not call `ctx.ui.setFooter()` or `ctx.ui.setEditorComponent()`.
- Removing `wow-tui` should not break workflow, cache, commit, or webfetch behavior.

## Development

```bash
# After editing extensions, run /reload or restart pi
```

### Conventions

- **Dialogue**: user-AI communication follows the user's current language
- **Technical content**: code, comments, config, documentation, commit messages use English
- **Code style**: TypeScript, following existing conventions
- **Shared utilities**: all reusable functions live in `extensions/wow/` — import from there, don't duplicate
- **Visual composition**: package visuals live in `extensions/wow-tui/`; feature logic should expose UI-independent state
- **Prefix-cache safety**: do not add per-turn timestamps/random IDs/locale-specific text to the system prompt; do not switch active tools for modes; truncate custom tool output before returning it to the LLM

### Project Structure

```text
wow/
├── AGENTS.md                # Project context for AI agents
├── LICENSE                  # MIT License
├── package.json             # Pi package manifest
├── README.md                # This file
├── README.zh-CN.md          # Simplified Chinese README
├── extensions/
│   ├── wow/                 # Base extension — shared utilities
│   │   ├── index.ts         # Extension entry (no-op), unified re-export of all sub-modules
│   │   ├── locale.ts        # Locale detection and stable language policy utilities
│   │   ├── renderer.ts      # Focus-style dim rendering helpers
│   │   ├── paths.ts         # Path shortening & OSC 8 hyperlink helpers
│   │   ├── html.ts          # HTML → Markdown/Text conversion helpers
│   │   ├── shell.ts         # Sync command execution wrappers
│   │   └── safe.ts          # Read-only bash command safety checks
│   ├── locale/              # Stable same-language policy
│   │   └── index.ts         # Appends byte-stable language policy to system prompt
│   ├── human-led-coding-workflow/ # ?/??/?!/$ human-led workflow logic
│   │   ├── index.ts         # Prefix routing, context injection, tool gates, state persistence
│   │   ├── prompts.ts       # Byte-stable workflow prompts
│   │   ├── plan.ts          # Plan detection, extraction, [DONE:n] tracking
│   │   └── state.ts         # UI-independent workflow state store
│   ├── git-commit/          # /git-commit — LLM-generated Conventional Commits
│   │   └── index.ts         # Standalone LLM call, parses output, executes commit via temp file
│   ├── command-mappings/    # Generic declarative command alias registry
│   │   └── index.ts         # Define command aliases (/exit, etc.) declaratively
│   ├── wow-tui/             # Unified visual shell / TUI compositor
│   │   ├── index.ts         # Owns singleton TUI resources and installs presenters
│   │   ├── config.ts        # Static visual feature toggles
│   │   ├── palette.ts       # Shared color palette
│   │   ├── footer.ts        # Two-line footer compositor
│   │   ├── editor.ts        # Composite editor
│   │   ├── tools.ts         # Focus-style built-in tool rendering overrides
│   │   └── widgets.ts       # Workflow status/todo presenters
│   ├── webfetch/            # Fetch web content and convert to markdown/text/html
│   │   └── index.ts         # webfetch tool using native fetch + node-html-markdown conversion
│   └── prefix-cache/        # Reasonix-style prefix-cache optimizations and diagnostics
│       ├── index.ts         # Reasoning stripping, schema canonicalization, cache commands
│       ├── reasoning.ts     # Provider/model allowlist and thinking block removal
│       ├── schema.ts        # Deterministic JSON/schema canonicalization
│       └── stats.ts         # Cache/diagnostic stats helpers
├── prompts/                 # Prompt templates (reserved, currently empty)
└── skills/                  # Skills (reserved, currently empty)
```

## License

[MIT](LICENSE) © 2026 issacyee
