# Wow

[English](README.md) | [简体中文](README.zh-CN.md)

一个打包日常 AI 编码工作流基础功能的 pi package。

## 安装

Wow 是一个 [pi](https://pi.dev) package。Pi 是一个终端里的 coding agent/harness，可以通过 TypeScript extensions、skills、prompt templates 和 themes 扩展。Pi packages 会把这些资源打包起来，方便从 npm、git 或本地路径安装。

如果你还没有安装 pi，请先安装：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
# 或
curl -fsSL https://pi.dev/install.sh | sh
```

然后使用 `/login` 或 provider API key 完成 pi 认证。模型和 provider 配置请参考 pi 文档。

这个仓库是 GitHub template repository，因为 Wow 是一个个人专用 pi package。许多功能都是围绕我的个人工作流定制的，会根据日常使用体验频繁调整，并且可能包含没有版本化发布的破坏性更新。

如果你想直接使用这个包，推荐从 git 安装：

```bash
pi install git:github.com/issacyee/wow
```

Pi packages 会通过 extensions 获得完整系统访问权限，因此安装任何第三方 package 前都应先审查源码。

如果你想基于 Wow 定制自己的个人工作流包，请从这个模板创建一个新的仓库，而不是 fork 它。这样你的自定义包可以独立于本仓库频繁的个人化改动。

## 功能

### Human-Led Coding Workflow — `?` / `??` / `?!` / `$`

一个以人为主导的编码工作流：由用户决定何时探讨、规划、修正和执行。普通输入保持 pi 的默认行为；只有使用前缀时才会进入该工作流。

| 输入 | 行为 |
|------|------|
| `? <text>` | 仅探讨/分析 — 只读探索，不要求输出计划 |
| `?? <text>` | 写一份新的可审查计划，并替换当前 active plan |
| `??` | 如果存在最近一次 `?` 探讨，则基于该探讨写计划 |
| `?! <text>` | 根据明确的审查反馈修正当前 active plan |
| `$` | 执行当前 active plan |
| `$ <text>` | 带额外约束执行当前 active plan |

- **人主导控制**：普通输入保持自由；计划反馈必须使用 `?!`；执行必须使用 `$`
- **只读探讨/规划/修正**：这些模式允许 `read`、`grep`、`find`、`ls`、安全只读 `bash` 和 `webfetch`，并阻止 `edit`、`write` 和不安全命令
- **可审查计划结构**：计划包含 Goals、Background、Key Decisions、Non-goals、Implementation Steps、Acceptance Criteria、Verification 和 Risks，并以 `Ready to execute?` 结尾
- **执行总结**：执行回复会被引导包含 Summary、Modified Files 和 Follow-up Suggestions；提交仍由用户手动完成
- **Prefix-cache friendly**：扩展不会修改 system prompt，不会切换 active tools，会从 provider context 过滤过期 workflow context，并把状态存储在 LLM context 外的 custom entries 中
- **编辑器边框颜色**：`?` 为紫色，`??` 为橙色，`?!` 为黄色，`$` 为蓝色
- **中文 IME 友好**：在编辑器开头输入全角 `？` `！` `￥` 会转换为 `?` `!` `$`，包括 `？？` → `??` 和 `？！` → `?!`

### Locale — Stable Same-Language Policy

向 system prompt 添加 byte-stable 的语言策略：使用与用户相同的语言回复，同时精确保留技术标识符。该扩展不再在每轮注入 OS-specific hidden messages，从而保持 provider prefix-cache/APC 系统的 prompt prefix 稳定。

### Git Commit — `/git-commit`

基于 staged changes 生成简洁的 [Conventional Commits](https://www.conventionalcommits.org/) 提交信息，并执行提交。它通过独立于主会话 context 的直接 LLM 调用工作，使用 “caveman-commit” 风格：极简、subject ≤50 字符，只有在 “why” 不明显时才写 body。不包含 AI attribution、emoji 或废话。

可选地传入额外上下文：`/git-commit refactor for performance`。

### Command Mappings — Declarative Aliases

通过一个声明式数组注册命令别名，而不是为每个别名创建独立文件。目前提供 `/exit` 作为内置 `/quit` 的别名。新增映射时只需追加到 `COMMAND_MAPPINGS` 数组。

### Focus Mode — Minimal Tool Rendering

覆盖 7 个内置工具（`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`），把默认的绿色背景 Box 替换为单行 dim-text 工具调用展示。工具输出完全隐藏。多个连续工具调用会紧凑排列，不额外留空。路径会缩短显示（home 使用 `~/`，长路径截断），命令会折叠。文件路径会以 OSC 8 `file://` hyperlink 形式渲染，在支持的终端中可点击。

自定义工具可以复用 `wow/renderer.ts` 中的共享 dim rendering 工具（`createFocusRenderCall`、`focusRenderResult`）。

| Before (default) | After (focus mode) |
|------------------|-------------------|
| 每个工具一个绿色背景 Box | 单行 `theme.fg("dim", ...)` |
| 展示工具调用 + 输出预览 | 仅展示工具调用（1 行） |
| 每个工具 3+ 行且有间距 | 每个工具 1 行且紧凑排列 |

**使用：**
- 通过 `package.json` 加载（默认启用）
- 使用 `Ctrl+O` 折叠/展开（该 override 下结果仍保持隐藏）
- 配合 `hideThinkingBlock` 设置使用 `Ctrl+T` 隐藏 thinking blocks

### Prefix Cache — Reasonix-Style Prompt Stability

优化 provider prefix-cache 命中率，尤其适用于 DeepSeek/OpenAI-compatible reasoning models：

- 从 provider context copy 中移除 assistant `thinking` / `reasoning_content`，同时保留在本地 session/UI 中
- 规范化 OpenAI-compatible provider tool schemas，并按工具名排序，保持 deterministic payload bytes
- 将 LLM context 中的 text tool results 限制在 32KB，并把超大完整输出保存到临时文件
- workflow modes 不切换 active tools；安全限制通过 `tool_call` gates 实现
- 提供 `/cache-stats` 查看 session cache usage，提供 `/cache-doctor` 检查常见稳定性问题

**开发规则：** 后续扩展应避免 per-turn system prompt mutations、active tool switching、nondeterministic tool schemas 和 oversized tool results。动态 mode state 应放在 user/custom turn-tail messages 或 runtime gates 中。

### Footer — Custom Status Bar

用自定义两行布局替换内置 footer，并使用专用配色：

**Line 1**：working directory（黄色、可点击 `file://` link）+ git branch（紫色）… LLM model + thinking level（绿色、右对齐）

**Line 2**：context usage progress bar（绿色 → 黄色 → 红色）+ percentage + token I/O（蓝色）+ cache hit rate（绿色）+ cost（黄色）… extension statuses（dim）

CWD 路径会缩短显示（home 使用 `~/`），并渲染为 OSC 8 hyperlink，支持的终端可一键打开。10 字符 Unicode progress bar（`█░`）用于直观展示 context window usage，并按阈值着色。终端较窄时会截断左侧内容，确保右侧 model name 始终可见。

### WebFetch — Fetch Web Content

获取 URL 内容，并转换为 markdown、text 或 html。基于 Node.js native `fetch`，HTML 转换由 node-html-markdown（AST-based）提供。

**功能：**
- User-Agent spoofing 和 Accept header negotiation，以获得更合适的 content type
- Cloudflare 403 bot-detection retry，并使用 honest UA fallback
- 5MB response size limit，可配置 timeout（默认 30s，最大 120s）
- 32KB LLM-context output limit；超大完整输出会保存到临时文件
- Raster image detection with base64 encoding
- URL 参数会以支持终端可点击的 hyperlink 展示
- 可在 human-led workflow exploration 中使用；写入安全通过 runtime gates 控制，而不是切换 active tools

**参数：**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `url` | (required) | 要获取的 URL |
| `format` | `"markdown"` | 输出格式：`markdown`、`text` 或 `html` |
| `timeout` | 30 | Timeout 秒数（最大 120） |

## 架构

### Shared Utility Layer — `extensions/wow/`

该包使用集中式 base extension（`wow`）为其他扩展提供共享工具。它本身不注册运行时行为、没有副作用，只作为通用函数的 import source。

| Sub-module | Exports | Used by |
|------------|---------|---------|
| `locale.ts` | `detectLocale`, `detectPrimaryLocale`, `localeToDisplayName`, `buildLanguageInstruction`, `buildStableLanguagePolicy`, `LOCALE_MAP` | locale |
| `renderer.ts` | `createFocusRenderCall`, `focusRenderCall`, `focusRenderResult` | focus-mode, webfetch |
| `paths.ts` | `shortenPath`, `linkPath`, `shortenCommand` | focus-mode, footer |
| `html.ts` | `convertHTMLToMarkdown`, `extractTextFromHTML`, `stripTags`, `isRasterImage`, `STRIP_TAGS` | webfetch |
| `shell.ts` | `execOrNull`, `execWithError` | git-commit |
| `safe.ts` | `isSafeCommand` | human-led-coding-workflow, plan-mode shim |

可以直接通过相对路径导入各 sub-module：

```typescript
import { detectPrimaryLocale } from "../wow/locale.ts";
import { createFocusRenderCall, focusRenderResult } from "../wow/renderer.ts";
import { shortenPath, linkPath } from "../wow/paths.ts";
import { convertHTMLToMarkdown } from "../wow/html.ts";
import { execOrNull, execWithError } from "../wow/shell.ts";
import { isSafeCommand } from "../wow/safe.ts";
```

也可以从统一入口导入：

```typescript
import { detectLocale, createFocusRenderCall, shortenPath } from "../wow/index.ts";
```

## 开发

```bash
# 修改扩展后，运行 /reload 或重启 pi
```

### 约定

- **对话**：user-AI communication follows the user's current language
- **技术内容**：code、comments、config、documentation、commit messages 使用 English
- **代码风格**：TypeScript，遵循现有代码风格
- **共享工具**：所有可复用函数放在 `extensions/wow/`，不要重复实现
- **Prefix-cache safety**：不要向 system prompt 添加 per-turn timestamp/random ID/locale-specific text；不要为 modes 切换 active tools；返回给 LLM 前截断 custom tool output

### 项目结构

```text
wow/
├── AGENTS.md                # Project context for AI agents
├── LICENSE                  # MIT License
├── package.json             # Pi package manifest
├── README.md                # English README
├── README.zh-CN.md          # 简体中文 README
├── extensions/
│   ├── wow/                 # Base extension — shared utilities
│   │   ├── index.ts         # Extension entry (no-op), unified re-export of all sub-modules
│   │   ├── locale.ts        # Locale detection and stable language policy utilities
│   │   ├── renderer.ts      # Focus-style dim rendering (createFocusRenderCall, focusRenderResult)
│   │   ├── paths.ts         # Path shortening & OSC 8 hyperlink (shortenPath, linkPath, shortenCommand)
│   │   ├── html.ts          # HTML → Markdown/Text conversion (convertHTMLToMarkdown, extractTextFromHTML)
│   │   ├── shell.ts         # Sync command execution wrappers (execOrNull, execWithError)
│   │   └── safe.ts          # Read-only bash command safety checks (isSafeCommand)
│   ├── locale/              # Stable same-language policy
│   │   └── index.ts         # Appends byte-stable language policy to system prompt
│   ├── human-led-coding-workflow/ # ?/??/?!/$ human-led workflow extension
│   │   ├── index.ts         # Entry: prefix routing, context injection, tool gates, state persistence
│   │   ├── prompts.ts       # Byte-stable workflow prompts
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

## License

[MIT](LICENSE) © 2026 issacyee
