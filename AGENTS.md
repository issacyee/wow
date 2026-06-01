# pi.zero — Foundational AI Workflow pi Package

My personal foundational pi package, bundling essential universal features for daily AI coding workflows.

## Structure

```
pi.zero/
├── AGENTS.md               # This file — project context
├── LICENSE                  # MIT License
├── package.json             # pi package manifest
├── README.md                # User-facing documentation
├── extensions/
│   ├── locale/              # OS language detection (injects language instruction via before_agent_start)
│   │   └── index.ts         # Detects locale → injects language directive into each AI turn
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
│   │   └── renderer.ts      # Shared dim-style rendering utilities (focusRenderCall, focusRenderResult)
│   └── webfetch/            # Fetch web content and convert to markdown/text/html
│       └── index.ts         # Zero-dep webfetch tool using native fetch + regex HTML conversion
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
- Keep the destructive patterns list in `safe.ts` comprehensive — omissions may cause data loss in plan mode
- The custom editor (`PlanModeEditor`) is installed via `session_start` event and overrides `handleInput()` to convert full-width `？`/`！`/`￥` to half-width `?`/`!`/`$` at cursor position 0, so Chinese IME users don't need to toggle input method for plan-mode commands
- The editor border color is intercepted via `Object.defineProperty` on `borderColor` to overlay mode-specific colors (orange/blue) while preserving the framework's native border color for thinking/bash mode

## Extension Details

### locale

Detects OS language via `Intl.DateTimeFormat().resolvedOptions().locale` and maps it to a human-readable name via `LOCALE_MAP`. Injects a `[LANGUAGE]` instruction into every agent turn via `before_agent_start`.

### plan-mode

A multi-phase planning workflow triggered by `?`/`??`/`$` input prefixes.

**Phases (new plan):**
1. **Understand** — read-only codebase exploration (read, grep, find, ls, questionnaire)
2. **Design** — converge on one recommended approach
3. **Review & Write** — output structured plan with Background / Approach / Files to Modify / Verification sections

**Key mechanics:**
- `ACTION_MARKER` (`"Ready to go?"`) is the stable bridge between plan mode and execution mode — detected in reverse-scanned assistant messages at `agent_end`
- `[DONE:n]` markers in AI responses are tracked via `markCompletedSteps()` to show progress during `$` execution
- Plan prompts are localized (zh/en) via `PLAN_LOCALES` and `getPlanLocale()`, detecting locale from `detectPrimaryLocale()` in `plan.ts`
- Tool restriction in planning mode: only read-only tools allowed (read, grep, find, ls, webfetch); `edit`/`write` blocked, bash filtered through `safe.ts` pattern list
- Editor border colors: orange (`#f5a742`) for `?`/`??`, blue (`#5c9cf5`) for `$`
- State is module-level (`turnMode`, `todoItems`, `lastTurnHadPlan`, `planFullText`) — per-session, reset on `agent_end`

### git-commit

Standalone LLM call (isolated from main session) using the caveman-commit system prompt. Reads staged diff via `git diff --cached`, truncates at 800 lines, sends to LLM for message generation. Parses output (strips code fences, preamble, attribution) and commits via temp `COMMIT_EDITMSG` file. Supports optional user-provided extra context via command args.

### command-mappings

Declarative array (`COMMAND_MAPPINGS`) of `{ name, description, handler }` objects. Currently provides `/exit` as alias for `/quit`. Add new mappings by appending entries.

### focus-mode

Overrides all 7 built-in tools (read, bash, edit, write, grep, find, ls) using `createXxxTool()` factory functions from the SDK. Each overridden tool uses `renderShell: "self"` with custom `renderCall` (single dim-text line) and empty `renderResult`. Tool sets are cached per cwd via `toolCache` map.

File paths are rendered as OSC 8 `file://` hyperlinks (clickable in supported terminals) via the `hyperlink()` utility from `@earendil-works/pi-tui`. The shared `renderer.ts` module exports `createFocusRenderCall()` and `focusRenderResult()` for custom tools to reuse the same dim rendering style.

### webfetch

Fetches content from a URL and converts to the requested format (markdown, text, or html). Uses Node.js native `fetch` — zero external dependencies. HTML conversion is done with inline regex: `convertHTMLToMarkdown()` handles headings, lists, links, emphasis, code blocks, and tables; `extractTextFromHTML()` strips tags and script/style content.

Features: User-Agent spoofing, Accept header negotiation, Cloudflare 403 retry, 5MB response size limit, timeout control (default 30s, max 120s), raster image base64 detection. Uses `createFocusRenderCall("webfetch")` from the shared renderer module for consistent dim rendering with clickable URL hyperlinks.

## Plan Mode Reference

| Input | Behavior |
|-------|----------|
| `? <text>` | Start a new plan, read-only exploration |
| `?? <text>` | Continue/adjust the previous plan |
| `$` | Execute the current plan |
| `$ <text>` | Execute the plan with adjustments |

> **Chinese IME**: Full-width `？` `！` `￥` are automatically converted to `?` `!` `$`
> when typed at the start of the editor — no need to switch input methods.
