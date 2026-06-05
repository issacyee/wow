# Wow — Foundational AI Workflow pi Package

A foundational pi package bundling essential features for daily AI coding workflows.

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
│   │   ├── renderer.ts      # Focus-style dim rendering (createFocusRenderCall, focusRenderResult)
│   │   ├── paths.ts         # Path shortening & OSC 8 hyperlink (shortenPath, linkPath, shortenCommand)
│   │   ├── html.ts          # HTML → Markdown/Text conversion (convertHTMLToMarkdown, extractTextFromHTML)
│   │   ├── shell.ts         # Sync command execution wrappers (execOrNull, execWithError)
│   │   └── safe.ts          # Read-only bash safety check (isSafeCommand)
│   ├── locale/              # Stable same-language policy via before_agent_start
│   │   └── index.ts         # Appends byte-stable language policy to the system prompt
│   ├── human-led-coding-workflow/ # ?/??/?!/$ human-led coding workflow
│   │   ├── index.ts         # Prefix routing, context injection, tool gates, state persistence
│   │   ├── prompts.ts       # Byte-stable discuss/plan/revise/execute prompts
│   │   ├── plan.ts          # Plan detection, extraction, [DONE:n] tracking
│   │   └── editor.ts        # Prefix colors and Chinese IME conversion
│   ├── plan-mode/           # Legacy plan-mode source, not loaded by package.json
│   │   ├── index.ts         # Legacy entry
│   │   ├── plan.ts          # Legacy plan helpers
│   │   └── safe.ts          # Backward-compatible shim to wow/safe.ts
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

## Development Conventions

### Technical Content Convention

Code, comments, config, documentation (including this file), commit messages,
and other technical content use English.

> AI response language is handled automatically by the `locale` extension —
> it appends a byte-stable same-language policy to the system prompt via
> `before_agent_start`, avoiding per-turn OS-locale text that would hurt prefix caching.

### Technical Conventions

- Use TypeScript, following existing code style
- Extension runtime dependencies (peerDependencies):
  - `@earendil-works/pi-coding-agent` — extension API, tool factories, custom editor
  - `@earendil-works/pi-agent-core` — agent message types
  - `@earendil-works/pi-ai` — LLM completion API (`complete`, message types)
  - `@earendil-works/pi-tui` — TUI components (`Text`, `Container`), used by focus-mode
- Run `/reload` or restart pi after editing extensions
- **Shared utilities** live in `extensions/wow/` — import from there, don't duplicate
- **Prefix-cache safety**: preserve byte-stable prompt prefixes. Do not add per-turn timestamps, random IDs, counters, or OS-locale strings to the system prompt. Do not switch active tools for modes; enforce permissions with `tool_call` gates. Truncate custom tool outputs before returning them to the LLM.
- Keep the read-only bash allowlist in `extensions/wow/safe.ts` comprehensive — omissions may cause data loss in read-only workflow modes
- The custom editor (`HumanLedWorkflowEditor`) is installed via `session_start` event and overrides `handleInput()` to convert full-width `？`/`！`/`￥` to half-width `?`/`!`/`$` at cursor position 0, so Chinese IME users don't need to toggle input method for workflow commands
- The editor border color is intercepted via `Object.defineProperty` on `borderColor` to overlay mode-specific colors (purple/orange/yellow/blue) while preserving the framework's native border color for thinking/bash mode

## Extension Details

### wow (base extension)

A pure utility layer with no runtime side effects. It registers nothing and serves as the centralized import source for shared functions used across all other extensions.

Sub-modules:
- **locale.ts** — `detectLocale()`, `detectPrimaryLocale()`, `localeToDisplayName()`, `buildLanguageInstruction()`, `buildStableLanguagePolicy()`, `LOCALE_MAP`. Shared locale and stable language policy helpers.
- **renderer.ts** — `createFocusRenderCall()`, `focusRenderCall()`, `focusRenderResult()`. Dim-style TUI rendering for custom tools. Formerly `focus-mode/renderer.ts`.
- **paths.ts** — `shortenPath()`, `linkPath()`, `shortenCommand()`. Path display utilities with OSC 8 hyperlink support. Extracted from `focus-mode/index.ts`.
- **html.ts** — `convertHTMLToMarkdown()`, `extractTextFromHTML()`, `stripTags()`, `isRasterImage()`, `STRIP_TAGS`. AST-based HTML conversion via node-html-markdown. Extracted from `webfetch/index.ts`.
- **shell.ts** — `execOrNull()`, `execWithError()`. Synchronous command execution wrappers with error handling. Extracted from `git-commit/index.ts`.
- **safe.ts** — `isSafeCommand()`. Shared read-only bash allowlist used by workflow gates and legacy plan-mode shims.

### locale

Appends a byte-stable `[LANGUAGE]` policy to the system prompt via `before_agent_start`: reply in the same language the user is using and preserve technical identifiers exactly. It intentionally avoids injecting OS-specific locale text into every turn. `detectLocale()` / `detectPrimaryLocale()` remain available for local UI/prompt-template choices, but LLM context should prefer `buildStableLanguagePolicy()`.

### human-led-coding-workflow

A human-led coding workflow triggered by `?`/`??`/`?!`/`$` input prefixes. Normal prompts keep pi's default behavior; workflow behavior only applies when a prefix is used.

**Modes:**
1. **Discuss (`?`)** — analyze and discuss, with read-only exploration; do not write a plan unless the user asks with `??`.
2. **Plan (`??`)** — create a new reviewable plan, replacing any active plan.
3. **Revise (`?!`)** — revise the active plan from explicit human review feedback.
4. **Execute (`$`)** — execute the active human-approved plan.

**Key mechanics:**
- `EXECUTE_MARKER` (`"Ready to execute?"`) is the bridge between planning/revision and execution. Plans are captured from reverse-scanned assistant messages at `agent_end`.
- Plans use Goals / Background / Key Decisions / Non-goals / Implementation Steps / Acceptance Criteria / Verification / Risks. There is no separate Files to Modify section in plans.
- `[DONE:n]` markers in AI responses are tracked via `markCompletedSteps()` to show execution progress.
- Discuss/plan/revise modes allow `read`, `grep`, `find`, `ls`, `webfetch`, and safe read-only `bash`; they block `edit`, `write`, unsafe bash, and unrelated tools.
- Prefix-cache safety is a hard requirement: the extension never mutates the system prompt, never switches active tools, registers no dynamic tools, filters stale workflow context messages from provider context, and persists state via custom entries outside LLM context.
- Editor border colors: purple for `?`, orange for `??`, yellow for `?!`, blue for `$`.
- State is module-level (`turnMode`, `activePlan`, `todoItems`, `planFullText`) and restored from `human-led-coding-workflow` custom entries on `session_start`.

### plan-mode

Legacy source kept for compatibility/reference only. It is no longer loaded by `package.json`; `plan-mode/safe.ts` re-exports `isSafeCommand()` from `wow/safe.ts`.

### git-commit

Standalone LLM call (isolated from main session context) using the caveman-commit system prompt. Reads staged diff via `git diff --cached`, truncates at 800 lines, sends to LLM for message generation. Parses output (strips code fences, preamble, attribution) and commits via temp `COMMIT_EDITMSG` file. Supports optional user-provided extra context via command args. Uses `execOrNull()` and `execWithError()` from `wow/shell.ts`.

### command-mappings

Declarative array (`COMMAND_MAPPINGS`) of `{ name, description, handler }` objects. Currently provides `/exit` as alias for `/quit`. Add new mappings by appending entries.

### focus-mode

Overrides all 7 built-in tools (read, bash, edit, write, grep, find, ls) using `createXxxTool()` factory functions from the SDK. Each overridden tool uses `renderShell: "self"` with custom `renderCall` (single dim-text line) and empty `renderResult`. Tool sets are cached per cwd via `toolCache` map.

File paths are rendered as OSC 8 `file://` hyperlinks (clickable in supported terminals) via `linkPath()` from `wow/paths.ts`. Rendering utilities are imported from `wow/renderer.ts` (the `focus-mode/renderer.ts` file is a backward-compatibility re-export shim).

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

### footer

Replaces the built-in footer with a custom two-line layout using a dedicated color palette (green `#1faf7a`, yellow `#c9a84c`, red `#e8634f`, blue `#17dae7`, purple `#7a5ea0`):

**Line 1** (left to right): CWD path as clickable OSC 8 `file://` hyperlink via `hyperlink()` from `pi-tui` and `shortenPath()` from `wow/paths.ts` (yellow) + git branch (purple) ... LLM model name + thinking level (green, right-aligned). Left side is truncated when space is insufficient to guarantee the model name stays visible.

**Line 2** (left to right): context usage progress bar (`█░`, 10 chars, color by threshold: green <50%, yellow 50-80%, red >80%) + percentage (same color) + token input/output stats (blue) + prefix-cache hit rate (green) + cost (yellow) ... extension statuses (dim, right-aligned).

Installed via `setFooter()` in `session_start`. Reacts to git branch changes via `footerData.onBranchChange()`. Context usage from `ctx.getContextUsage()`, thinking level from `pi.getThinkingLevel()`, token stats computed from `ctx.sessionManager.getBranch()`.

## Human-Led Workflow Reference

| Input | Behavior |
|-------|----------|
| `? <text>` | Discuss/analyze only, read-only exploration |
| `?? <text>` | Write a new reviewable plan |
| `?! <text>` | Revise the active plan from explicit feedback |
| `$` | Execute the active plan |
| `$ <text>` | Execute the active plan with additional constraints |

> **Chinese IME**: Full-width `？` `！` `￥` are automatically converted to `?` `!` `$`
> when typed at the start of the editor — no need to switch input methods.
