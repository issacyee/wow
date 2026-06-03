# Wow

A foundational pi package bundling essential features for daily AI coding workflows.

## Installation

Clone the repository into your pi packages directory:

```bash
git clone <repo-url> ~/.pi/packages/wow
```

Or symlink to a local development directory. See [pi packages docs](https://github.com/earendil-works/pi) for details.

## Features

### Plan Mode — `?` / `??` / `$`

A multi-phase planning workflow that prompts the AI to explore, design, and then execute.

| Input | Behavior |
|-------|----------|
| `? <text>` | Start a new plan — read-only exploration, design, review
| `?? <text>` | Continue/adjust the previous plan
| `$` | Execute the current plan
| `$ <text>` | Execute the plan with adjustments

- **Multi-phase workflow**: new plans go through Understand → Design → Review & Write phases before producing the final plan
- **Localized prompts**: plan prompts are generated in the user's OS language (zh/en supported) for natural reading experience
- **Editor border colors**: orange (`#f5a742`) in `?` / `??` mode, blue (`#5c9cf5`) in `$` execution mode — visual feedback for the current mode
- **Read-only safety**: planning mode blocks `edit` / `write` tools and dangerous bash commands via runtime `tool_call` gates, preventing accidental modifications without changing the active tool schema
- **Progress tracking**: `[DONE:n]` markers in AI responses are recognized automatically; a completion summary is emitted when all steps are done
- **Chinese IME friendly**: Full-width `？` `！` `￥` typed at the start of the editor
  are automatically converted to `?` `!` `$` — no need to switch input methods

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

### Focus Mode — Minimal Tool Rendering

Overrides all 7 built-in tools (read, bash, edit, write, grep, find, ls) to replace the
default green-background Box with a single dim-text line per tool call. Tool output is
hidden entirely. Multiple consecutive tool calls appear flush together with no spacing.
Paths are shortened (`~/` for home, truncation for long paths), commands are collapsed.
File paths are rendered as clickable OSC 8 `file://` hyperlinks in supported terminals.

Custom tools can reuse the same dim rendering via shared utilities from `wow/renderer.ts`
(`createFocusRenderCall`, `focusRenderResult`).

| Before (default) | After (focus mode) |
|------------------|-------------------|
| Green background Box per tool | Single `theme.fg("dim", ...)` line |
| Tool call + output preview | Tool call only (1 line) |
| 3+ lines per tool, spaced apart | 1 line per tool, flush together |

**Usage:**
- Load via `package.json` (enabled automatically)
- Use `Ctrl+O` to fold/expand (results remain hidden with this override)
- Use `Ctrl+T` to hide thinking blocks (in combination with `hideThinkingBlock` setting)

### Prefix Cache — Reasonix-Style Prompt Stability

Optimizes provider prefix-cache hit rate, especially for DeepSeek/OpenAI-compatible
reasoning models:

- Strips assistant `thinking` / `reasoning_content` from the provider context copy while preserving it in the local session/UI
- Canonicalizes OpenAI-compatible provider tool schemas and sorts tools by name for deterministic payload bytes
- Caps text tool results at 32KB in LLM context and saves oversized full output to a temp file
- Keeps plan-mode from switching active tools; safety is enforced by `tool_call` gates instead
- Provides `/cache-stats` for session cache usage and `/cache-doctor` for common stability problems

**Development rule:** future extensions should avoid per-turn system prompt mutations,
active tool switching, nondeterministic tool schemas, and oversized tool results.
Put dynamic mode state in user/custom turn-tail messages or runtime gates instead.

### Footer — Custom Status Bar

Replaces the built-in footer with a custom two-line layout using a dedicated color palette:

**Line 1**: working directory (yellow, clickable `file://` link) + git branch (purple) … LLM model + thinking level (green, right-aligned)

**Line 2**: context usage progress bar (green → yellow → red) + percentage + token I/O (blue) + cache hit rate (green) + cost (yellow) … extension statuses (dim)

The CWD path is shortened (`~/` for home) and rendered as an OSC 8 hyperlink for
one-click open in supporting terminals. A 10-character Unicode progress bar (`█░`)
shows context window usage at a glance — always visible, color-coded by threshold.
When the terminal is narrow, the left side truncates to guarantee the model name
stays visible on the right.

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
- Allowed during plan-mode exploration; write safety is enforced by runtime gates, not active-tool switching

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
| `locale.ts` | `detectLocale`, `detectPrimaryLocale`, `localeToDisplayName`, `buildLanguageInstruction`, `buildStableLanguagePolicy`, `LOCALE_MAP` | locale, plan-mode |
| `renderer.ts` | `createFocusRenderCall`, `focusRenderCall`, `focusRenderResult` | focus-mode, webfetch |
| `paths.ts` | `shortenPath`, `linkPath`, `shortenCommand` | focus-mode, footer |
| `html.ts` | `convertHTMLToMarkdown`, `extractTextFromHTML`, `stripTags`, `isRasterImage`, `STRIP_TAGS` | webfetch |
| `shell.ts` | `execOrNull`, `execWithError` | git-commit |

Each sub-module can be imported directly by relative path:

```typescript
import { detectPrimaryLocale } from "../wow/locale.ts";
import { createFocusRenderCall, focusRenderResult } from "../wow/renderer.ts";
import { shortenPath, linkPath } from "../wow/paths.ts";
import { convertHTMLToMarkdown } from "../wow/html.ts";
import { execOrNull, execWithError } from "../wow/shell.ts";
```

Or import everything from the unified entry:

```typescript
import { detectLocale, createFocusRenderCall, shortenPath } from "../wow/index.ts";
```

## Development

```bash
# After editing extensions, run /reload or restart pi
```

### Conventions

- **Dialogue**: user-AI communication follows the user's current language
- **Technical content**: code, comments, config, documentation, commit messages use English
- **Code style**: TypeScript, following existing conventions
- **Shared utilities**: all reusable functions live in `extensions/wow/` — import from there, don't duplicate
- **Prefix-cache safety**: do not add per-turn timestamps/random IDs/locale-specific text to the system prompt; do not switch active tools for modes; truncate custom tool output before returning it to the LLM

### Project Structure

```
wow/
├── AGENTS.md                # Project context for AI agents
├── LICENSE                  # MIT License
├── package.json             # Pi package manifest
├── README.md                # This file
├── extensions/
│   ├── wow/                 # Base extension — shared utilities
│   │   ├── index.ts         # Extension entry (no-op), unified re-export of all sub-modules
│   │   ├── locale.ts        # Locale detection and stable language policy utilities
│   │   ├── renderer.ts      # Focus-style dim rendering (createFocusRenderCall, focusRenderResult)
│   │   ├── paths.ts         # Path shortening & OSC 8 hyperlink (shortenPath, linkPath, shortenCommand)
│   │   ├── html.ts          # HTML → Markdown/Text conversion (convertHTMLToMarkdown, extractTextFromHTML)
│   │   └── shell.ts         # Sync command execution wrappers (execOrNull, execWithError)
│   ├── locale/              # Stable same-language policy
│   │   └── index.ts         # Appends byte-stable language policy to system prompt
│   ├── plan-mode/           # ?/??/$ plan mode extension
│   │   ├── index.ts         # Entry: prefix detection, context injection, tool interception, custom editor
│   │   ├── plan.ts          # Plan item extraction, [DONE:n] tracking, text cleanup, i18n locale detection
│   │   └── safe.ts          # Bash destructive-pattern whitelist (planning mode safety)
│   ├── git-commit/          # /git-commit — LLM-generated Conventional Commits
│   │   └── index.ts         # Standalone LLM call, parses output, executes commit via temp file
│   ├── command-mappings/    # Generic declarative command alias registry
│   │   └── index.ts         # Define command aliases (/exit, etc.) declaratively
│   ├── focus-mode/          # Minimal, unobtrusive tool rendering
│   │   ├── index.ts         # Overrides 7 built-in tools with dim single-line rendering
│   │   └── renderer.ts      # Re-export from wow/renderer.ts (backward compatibility shim)
│   ├── webfetch/            # Fetch web content and convert to markdown/text/html
│   │   └── index.ts         # webfetch tool using native fetch + node-html-markdown HTML conversion
│   ├── prefix-cache/        # Reasonix-style prefix-cache optimizations and diagnostics
│   │   ├── index.ts         # Reasoning stripping, schema canonicalization, cache commands
│   │   ├── reasoning.ts     # Provider/model allowlist and thinking block removal
│   │   ├── schema.ts        # Deterministic JSON/schema canonicalization
│   │   └── stats.ts         # Cache/diagnostic stats helpers
│   └── footer/              # Custom two-line footer with CWD hyperlink & context/cache bar
│       └── index.ts         # setFooter replacement with custom color palette
├── prompts/                 # Prompt templates (reserved, currently empty)
└── skills/                  # Skills (reserved, currently empty)
```

## License

[MIT](LICENSE) © 2026 issacyee
