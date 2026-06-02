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
│   │   ├── locale.ts        # OS language detection (detectLocale, detectPrimaryLocale, LOCALE_MAP)
│   │   ├── renderer.ts      # Focus-style dim rendering (createFocusRenderCall, focusRenderResult)
│   │   ├── paths.ts         # Path shortening & OSC 8 hyperlink (shortenPath, linkPath, shortenCommand)
│   │   ├── html.ts          # HTML → Markdown/Text conversion (convertHTMLToMarkdown, extractTextFromHTML)
│   │   └── shell.ts         # Sync command execution wrappers (execOrNull, execWithError)
│   ├── locale/              # Language injection via before_agent_start
│   │   └── index.ts         # Detects locale → injects language directive into each AI turn
│   ├── plan-mode/           # ?/??/$ plan mode extension
│   │   ├── index.ts         # Entry: prefix detection, context injection, tool interception, custom editor
│   │   ├── plan.ts          # Plan item extraction, [DONE:n] tracking, plan structure fallback detection, text cleanup, i18n locale detection
│   │   └── safe.ts          # Bash destructive-pattern whitelist (planning mode safety)
│   ├── git-commit/          # /git-commit — LLM-generated Conventional Commits
│   │   └── index.ts         # Standalone LLM call, parses output, executes commit via temp file
│   ├── command-mappings/    # Generic declarative command alias registry
│   │   └── index.ts         # Define command aliases (/exit, etc.) declaratively
│   ├── focus-mode/          # Minimal, unobtrusive tool rendering
│   │   ├── index.ts         # Overrides 7 built-in tools with dim single-line rendering
│   │   └── renderer.ts      # Re-export from wow/renderer.ts (backward compatibility shim)
│   └── webfetch/            # Fetch web content and convert to markdown/text/html
│       └── index.ts         # Zero-dep webfetch tool using native fetch + regex HTML conversion
│   └── footer/              # Custom two-line footer with CWD hyperlink & context bar
│       └── index.ts         # setFooter replacement with custom color palette
├── prompts/                 # Prompt templates (reserved, currently empty)
└── skills/                  # Skills (reserved, currently empty)
```

## Development Conventions

### Technical Content Convention

Code, comments, config, documentation (including this file), commit messages,
and other technical content use English.

> AI response language is handled automatically by the `locale` extension —
> it detects the OS language at runtime and injects a language instruction
> into each agent turn via `before_agent_start`.

### Technical Conventions

- Use TypeScript, following existing code style
- Extension runtime dependencies (peerDependencies):
  - `@earendil-works/pi-coding-agent` — extension API, tool factories, custom editor
  - `@earendil-works/pi-agent-core` — agent message types
  - `@earendil-works/pi-ai` — LLM completion API (`complete`, message types)
  - `@earendil-works/pi-tui` — TUI components (`Text`, `Container`), used by focus-mode
- Run `/reload` or restart pi after editing extensions
- **Shared utilities** live in `extensions/wow/` — import from there, don't duplicate
- Keep the destructive patterns list in `safe.ts` comprehensive — omissions may cause data loss in plan mode
- The custom editor (`PlanModeEditor`) is installed via `session_start` event and overrides `handleInput()` to convert full-width `？`/`！`/`￥` to half-width `?`/`!`/`$` at cursor position 0, so Chinese IME users don't need to toggle input method for plan-mode commands
- The editor border color is intercepted via `Object.defineProperty` on `borderColor` to overlay mode-specific colors (orange/blue) while preserving the framework's native border color for thinking/bash mode

## Extension Details

### wow (base extension)

A pure utility layer with no runtime side effects. It registers nothing and serves as the centralized import source for shared functions used across all other extensions.

Sub-modules:
- **locale.ts** — `detectLocale()`, `detectPrimaryLocale()`, `localeToDisplayName()`, `buildLanguageInstruction()`, `LOCALE_MAP`. Consolidated from `locale/` and `plan-mode/plan.ts`.
- **renderer.ts** — `createFocusRenderCall()`, `focusRenderCall()`, `focusRenderResult()`. Dim-style TUI rendering for custom tools. Formerly `focus-mode/renderer.ts`.
- **paths.ts** — `shortenPath()`, `linkPath()`, `shortenCommand()`. Path display utilities with OSC 8 hyperlink support. Extracted from `focus-mode/index.ts`.
- **html.ts** — `convertHTMLToMarkdown()`, `extractTextFromHTML()`, `stripTags()`, `isRasterImage()`, `STRIP_TAGS`. Zero-dep HTML conversion. Extracted from `webfetch/index.ts`.
- **shell.ts** — `execOrNull()`, `execWithError()`. Synchronous command execution wrappers with error handling. Extracted from `git-commit/index.ts`.

### locale

Detects OS language via `Intl.DateTimeFormat().resolvedOptions().locale` and injects a `[LANGUAGE]` instruction into every agent turn via `before_agent_start`. Uses `buildLanguageInstruction()` from `wow/locale.ts`.

### plan-mode

A multi-phase planning workflow triggered by `?`/`??`/`$` input prefixes.

**Phases (new plan):**
1. **Understand** — read-only codebase exploration (read, grep, find, ls, questionnaire)
2. **Design** — converge on one recommended approach
3. **Review & Write** — output structured plan with Background / Approach / Files to Modify / Verification sections

**Key mechanics:**
- `ACTION_MARKER` (`"Ready to go?"`) is the primary bridge between plan mode and execution mode — detected in reverse-scanned assistant messages at `agent_end`. Fallback: if the marker is missing, `hasPlanStructure()` detects `## <word>:` headers (Plan:, 计划:, etc.) to still capture the plan. The `$` input handler also attempts recovery from session entries when no plan is detected in memory.
- `[DONE:n]` markers in AI responses are tracked via `markCompletedSteps()` to show progress during `$` execution
- Plan prompts are localized (zh/en) via `PLAN_LOCALES` and `getPlanLocale()`, detecting locale from `detectPrimaryLocale()` in `wow/locale.ts`
- Tool restriction in planning mode: only read-only tools allowed (read, grep, find, ls, webfetch); `edit`/`write` blocked, bash filtered through `safe.ts` pattern list
- Editor border colors: orange (`#f5a742`) for `?`/`??`, blue (`#5c9cf5`) for `$`
- State is module-level (`turnMode`, `todoItems`, `lastTurnHadPlan`, `planFullText`) — per-session, reset on `agent_end`

### git-commit

Standalone LLM call (isolated from main session context) using the caveman-commit system prompt. Reads staged diff via `git diff --cached`, truncates at 800 lines, sends to LLM for message generation. Parses output (strips code fences, preamble, attribution) and commits via temp `COMMIT_EDITMSG` file. Supports optional user-provided extra context via command args. Uses `execOrNull()` and `execWithError()` from `wow/shell.ts`.

### command-mappings

Declarative array (`COMMAND_MAPPINGS`) of `{ name, description, handler }` objects. Currently provides `/exit` as alias for `/quit`. Add new mappings by appending entries.

### focus-mode

Overrides all 7 built-in tools (read, bash, edit, write, grep, find, ls) using `createXxxTool()` factory functions from the SDK. Each overridden tool uses `renderShell: "self"` with custom `renderCall` (single dim-text line) and empty `renderResult`. Tool sets are cached per cwd via `toolCache` map.

File paths are rendered as OSC 8 `file://` hyperlinks (clickable in supported terminals) via `linkPath()` from `wow/paths.ts`. Rendering utilities are imported from `wow/renderer.ts` (the `focus-mode/renderer.ts` file is a backward-compatibility re-export shim).

### webfetch

Fetches content from a URL and converts to the requested format (markdown, text, or html). Uses Node.js native `fetch` — zero external dependencies. HTML conversion is handled by `convertHTMLToMarkdown()` and `extractTextFromHTML()` from `wow/html.ts`. Uses `createFocusRenderCall("webfetch")` from `wow/renderer.ts` for consistent dim rendering with clickable URL hyperlinks.

### footer

Replaces the built-in footer with a custom two-line layout using a dedicated color palette (green `#1faf7a`, yellow `#c9a84c`, red `#e8634f`, blue `#17dae7`, purple `#7a5ea0`):

**Line 1** (left to right): CWD path as clickable OSC 8 `file://` hyperlink via `hyperlink()` from `pi-tui` and `shortenPath()` from `wow/paths.ts` (yellow) + git branch (purple) ... LLM model name + thinking level (green, right-aligned). Left side is truncated when space is insufficient to guarantee the model name stays visible.

**Line 2** (left to right): context usage progress bar (`█░`, 10 chars, color by threshold: green <50%, yellow 50-80%, red >80%) + percentage (same color) + token input/output stats (blue) + cost (yellow) ... extension statuses (dim, right-aligned).

Installed via `setFooter()` in `session_start`. Reacts to git branch changes via `footerData.onBranchChange()`. Context usage from `ctx.getContextUsage()`, thinking level from `pi.getThinkingLevel()`, token stats computed from `ctx.sessionManager.getBranch()`.

## Plan Mode Reference

| Input | Behavior |
|-------|----------|
| `? <text>` | Start a new plan, read-only exploration |
| `?? <text>` | Continue/adjust the previous plan |
| `$` | Execute the current plan |
| `$ <text>` | Execute the plan with adjustments |

> **Chinese IME**: Full-width `？` `！` `￥` are automatically converted to `?` `!` `$`
> when typed at the start of the editor — no need to switch input methods.
