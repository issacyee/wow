# Wow — Foundational AI Workflow pi Package

A pi package bundling essential features for daily AI coding workflows.

## Structure

```
wow/
├── AGENTS.md               # This file — project context
├── LICENSE                  # MIT License
├── package.json             # pi package manifest
├── README.md                # User-facing documentation
├── extensions/
│   ├── wow/                 # Base extension — shared utilities for all other extensions
│   │   ├── index.ts         # Extension entry (no-op), unified re-export of all sub-modules
│   │   ├── locale.ts        # Locale detection and stable language policy utilities
│   │   ├── renderer.ts      # Focus-style dim rendering helpers for custom tools
│   │   ├── paths.ts         # Path shortening & OSC 8 hyperlink helpers
│   │   ├── html.ts          # HTML → Markdown/Text conversion helpers
│   │   ├── shell.ts         # Sync command execution wrappers
│   │   └── safe.ts          # Read-only bash safety check
│   ├── locale/              # Stable same-language policy via before_agent_start
│   │   └── index.ts         # Appends byte-stable language policy to the system prompt
│   ├── human-led-coding-workflow/ # ?/??/?!/$ human-led coding workflow logic
│   │   ├── index.ts         # Prefix routing, context injection, tool gates, state persistence
│   │   ├── prompts.ts       # Byte-stable discuss/plan/revise/execute prompts
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
│   │   ├── editor.ts        # Composite editor: pi label, workflow border, IME conversion
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

## Development Conventions

### Technical Content Convention

Code, comments, config, documentation (including this file), commit messages,
and other technical content use English.

> AI response language is handled automatically by the `locale` extension —
> it appends a byte-stable same-language policy to the system prompt via
> `before_agent_start`, avoiding per-turn OS-locale text that would hurt prefix caching.

### Technical Conventions

- Use TypeScript, following existing code style.
- Extension runtime dependencies (peerDependencies):
  - `@earendil-works/pi-coding-agent` — extension API, tool factories, custom editor
  - `@earendil-works/pi-agent-core` — agent message types
  - `@earendil-works/pi-ai` — LLM completion API (`complete`, message types)
  - `@earendil-works/pi-tui` — TUI components (`Text`, `Container`), used by `wow-tui` and tool renderers
- Run `/reload` or restart pi after editing extensions.
- **Shared utilities** live in `extensions/wow/` — import from there, don't duplicate.
- **Visual shell boundary**: `extensions/wow-tui/` is the only package extension that should own singleton TUI resources such as `ctx.ui.setFooter()`, `ctx.ui.setEditorComponent()`, and package-wide tool rendering overrides. Logic extensions should expose state and behavior, not visual composition.
- **Prefix-cache safety**: preserve byte-stable prompt prefixes. Do not add per-turn timestamps, random IDs, counters, or OS-locale strings to the system prompt. Do not switch active tools for workflow modes; enforce permissions with `tool_call` gates. Truncate custom tool outputs before returning them to the LLM.
- Keep the read-only bash allowlist in `extensions/wow/safe.ts` comprehensive — omissions may cause data loss in read-only workflow modes.
- The unified editor in `wow-tui` converts full-width `？`/`！`/`￥` to half-width `?`/`!`/`$` at workflow-prefix positions so Chinese IME users don't need to toggle input method.
- The editor border color is intercepted via `Object.defineProperty` on `borderColor` to overlay workflow prefix colors (purple/orange/yellow/blue) while preserving the framework's native border color for thinking/bash mode.

## Extension Details

### wow (base extension)

A pure utility layer with no runtime side effects. It registers nothing and serves as the centralized import source for shared functions used across all other extensions.

Sub-modules:
- **locale.ts** — `detectLocale()`, `detectPrimaryLocale()`, `localeToDisplayName()`, `buildLanguageInstruction()`, `buildStableLanguagePolicy()`, `LOCALE_MAP`. Shared locale and stable language policy helpers.
- **renderer.ts** — `createFocusRenderCall()`, `focusRenderCall()`, `focusRenderResult()`. Dim-style rendering helpers for custom tools.
- **paths.ts** — `shortenPath()`, `linkPath()`, `shortenCommand()`. Path display utilities with OSC 8 hyperlink support.
- **html.ts** — `convertHTMLToMarkdown()`, `extractTextFromHTML()`, `stripTags()`, `isRasterImage()`, `STRIP_TAGS`. AST-based HTML conversion via node-html-markdown.
- **shell.ts** — `execOrNull()`, `execWithError()`. Synchronous command execution wrappers with error handling.
- **safe.ts** — `isSafeCommand()`. Shared read-only bash allowlist used by workflow gates.

### locale

Appends a byte-stable `[LANGUAGE]` policy to the system prompt via `before_agent_start`: reply in the same language the user is using and preserve technical identifiers exactly. It intentionally avoids injecting OS-specific locale text into every turn. `detectLocale()` / `detectPrimaryLocale()` remain available for local UI/prompt-template choices, but LLM context should prefer `buildStableLanguagePolicy()`.

### human-led-coding-workflow

A human-led coding workflow triggered by `?`/`??`/`?!`/`$` input prefixes. Normal prompts keep pi's default behavior; workflow behavior only applies when a prefix is used.

**Modes:**
1. **Discuss (`?`)** — analyze and discuss, with read-only exploration; do not write a plan unless the user asks with `??`.
2. **Plan (`??`)** — create a new reviewable plan, replacing any active plan. Empty `??` means the human fully approves the most recent `?` discussion result and wants a plan from it, when such discussion exists.
3. **Revise (`?!`)** — revise the active plan from explicit human review feedback.
4. **Execute (`$`)** — execute the active human-approved plan.

**Key mechanics:**
- `EXECUTE_MARKER` (`"Ready to execute?"`) is the bridge between planning/revision and execution. Plans are captured from reverse-scanned assistant messages at `agent_end`.
- Plans use Goals / Background / Key Decisions / Non-goals / Implementation Steps / Acceptance Criteria / Verification / Risks.
- `[DONE:n]` markers in AI responses are tracked via `markCompletedSteps()` to update execution progress state.
- Discuss/plan/revise modes allow `read`, `grep`, `find`, `ls`, `webfetch`, and safe read-only `bash`; they block `edit`, `write`, unsafe bash, and unrelated tools.
- Prefix-cache safety is a hard requirement: the extension never mutates the system prompt, never switches active tools, registers no dynamic tools, filters stale workflow context messages from provider context, and persists state via custom entries outside LLM context.
- State is managed by `state.ts` and restored from `human-led-coding-workflow` custom entries on `session_start`.
- TUI presentation for editor colors, status, and todo widgets is handled by `wow-tui`.

### wow-tui

Unified visual shell and TUI compositor for this package. It centralizes pure visual features so logic extensions can be used without visual code.

Responsibilities:
- Installs the two-line footer via `ctx.ui.setFooter()`.
- Installs the composite editor via `ctx.ui.setEditorComponent()`.
- Applies the editor `𝝅` top-border label.
- Applies workflow prefix border colors and Chinese IME prefix conversion.
- Presents workflow status and todo widgets by subscribing to workflow state.
- Re-registers built-in tools with focus-style minimal rendering.

Removing `./extensions/wow-tui/index.ts` from `package.json` disables these package visuals while leaving logic extensions functional.

### git-commit

Standalone LLM call (isolated from main session context) using the caveman-commit system prompt. Reads staged diff via `git diff --cached`, truncates at 800 lines, sends to LLM for message generation. Parses output (strips code fences, preamble, attribution) and commits via temp `COMMIT_EDITMSG` file. Supports optional user-provided extra context via command args. Uses `execOrNull()` and `execWithError()` from `wow/shell.ts`.

### command-mappings

Declarative array (`COMMAND_MAPPINGS`) of `{ name, description, handler }` objects. Currently provides `/exit` as alias for `/quit`. Add new mappings by appending entries.

### webfetch

Fetches content from a URL and converts to the requested format (markdown, text, or html). Uses Node.js native `fetch` — zero external dependencies. HTML conversion is handled by `convertHTMLToMarkdown()` and `extractTextFromHTML()` from `wow/html.ts`. Uses `createFocusRenderCall("webfetch")` from `wow/renderer.ts` for consistent dim rendering with clickable URL hyperlinks. Returned LLM context is capped at 32KB; full oversized output is saved to a temp file and referenced in the result.

### prefix-cache

Reasonix-inspired prefix-cache optimization layer. It preserves local session/UI fidelity while stabilizing bytes sent to providers:
- `context` hook strips assistant `thinking` blocks and tool-call thought signatures for DeepSeek/OpenAI-compatible reasoning models. Anthropic/Gemini/Bedrock/Mistral are intentionally excluded because their thinking signatures can be protocol-sensitive.
- `before_provider_request` canonicalizes OpenAI-compatible provider `tools` by sorting tool names and JSON schema keys / order-insensitive arrays (`required`, `enum`, `dependentRequired`). It also removes provider-level `reasoning_content` / `reasoning` fields from assistant messages for the same OpenAI-compatible reasoning targets.
- `tool_result` caps text returned to the LLM at 32KB and saves oversized full output to a temp file.
- `/cache-stats` shows aggregated input/output/cache read/cache write/hit-rate/cost for the current branch.
- `/cache-doctor` reports common prefix-cache breakers: system prompt hash changes, tool schema hash changes, filtered active tools, old locale custom messages, stored thinking size, and oversized tool results.

Future extensions must treat prefix stability as a compatibility contract: dynamic instructions belong in user/custom turn-tail messages or runtime gates, not in changing system prompts or changing tool sets.

## Human-Led Workflow Reference

| Input | Behavior |
|-------|----------|
| `? <text>` | Discuss/analyze only, read-only exploration |
| `?? <text>` | Write a new reviewable plan |
| `??` | Write a plan from the most recent `?` discussion, if available |
| `?! <text>` | Revise the active plan from explicit feedback |
| `$` | Execute the active plan |
| `$ <text>` | Execute the active plan with additional constraints |

> **Chinese IME**: Full-width `？` `！` `￥` are automatically converted to `?` `!` `$`
> when typed at workflow-prefix positions — no need to switch input methods.
