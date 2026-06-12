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

| 输入        | 行为                                          |
| ----------- | --------------------------------------------- |
| `? <text>`  | 仅探讨/分析 — 只读探索，不要求输出计划        |
| `?? <text>` | 写一份新的可审查计划，并替换当前 active plan  |
| `??`        | 如果存在最近一次 `?` 探讨，则基于该探讨写计划 |
| `?! <text>` | 根据明确的审查反馈修正当前 active plan        |
| `$`         | 执行当前 active plan                          |
| `$ <text>`  | 带额外约束执行当前 active plan                |

- **人主导控制**：普通输入保持自由；计划反馈必须使用 `?!`；执行必须使用 `$`
- **只读探讨/规划/修正**：这些模式允许 `read`、`grep`、`find`、`ls`、安全只读 `bash` 和 `webfetch`，并阻止 `edit`、`write` 和不安全命令
- **可审查计划结构**：计划包含 Goals、Background、Key Decisions、Non-goals、Implementation Steps、Acceptance Criteria、Verification 和 Risks，并以 `Ready to execute?` 结尾
- **执行总结**：执行回复会被引导包含 Summary、Modified Files 和 Follow-up Suggestions；提交仍由用户手动完成
- **Prefix-cache friendly**：扩展不会修改 system prompt，不会切换 active tools，会从 provider context 过滤过期 workflow context，并把状态存储在 LLM context 外的 custom entries 中
- **UI-independent logic**：workflow 状态由 `state.ts` 暴露；编辑器颜色、status、todo widget 由 `wow-tui` 展示

### Locale — Stable Same-Language Policy

向 system prompt 添加 byte-stable 的语言策略：使用与用户相同的语言回复，同时精确保留技术标识符。该扩展不再在每轮注入 OS-specific hidden messages，从而保持 provider prefix-cache/APC 系统的 prompt prefix 稳定。

### Git Commit — `/git-commit`

基于 staged changes 生成平衡的 [Conventional Commits](https://www.conventionalcommits.org/) 提交信息，并执行提交。它通过独立于主会话 context 的直接 LLM 调用工作：subject 保持简洁；当 diff 包含多个有意义变化时，使用 2–5 条 body bullets 总结重要的次要变化或不明显的原因。不包含 AI attribution、emoji 或废话。

语言变体：
- `/git-commit` 保持默认的灵活语言行为。
- `/git-commit:en` 强制使用英文 subject/body。
- `/git-commit:zh-CN` 强制使用简体中文 subject/body，但 Conventional Commit type/scope 保持英文。

可选地传入额外上下文：`/git-commit:zh-CN 重构性能相关逻辑`。

### BTW — Isolated Side Q&A

用于概念追问、术语解释和临时澄清的线程化旁路问答，不污染主编码上下文。
BTW 使用独立 LLM 调用，并把 topic state 作为 custom entries 持久化在 provider context 外。
多次 `/btw` 会继续当前 BTW topic；不同 topic 彼此隔离。需要 topic id 的命令支持参数补全；
在交互模式下未提供 id 时会打开选择器。

| Command               | Behavior                                                      |
| --------------------- | ------------------------------------------------------------- |
| `/btw <question>`     | 在当前 open topic 中提问；没有 current topic 时创建或选择一个 |
| `/btw:new <question>` | 创建新 topic 并提出第一个问题                                 |
| `/btw:list`           | 列出 open topics（`--closed` / `--all` 查看归档 topic）       |
| `/btw:switch <id>`    | 切换当前 topic                                                |
| `/btw:show <id>`      | 查看 topic transcript                                         |
| `/btw:close <id>`     | 归档 topic，不删除记录                                        |
| `/btw:reopen <id>`    | 重新打开归档 topic                                            |
| `/btw:promote <id>`   | 显式把精简结论带回主上下文                                    |

### Command Mappings — Declarative Aliases

通过一个声明式数组注册命令别名，而不是为每个别名创建独立文件。目前提供 `/exit` 作为内置 `/quit` 的别名。新增映射时只需追加到 `COMMAND_MAPPINGS` 数组。

### Wow TUI — Unified Visual Shell

`wow-tui` 是本包唯一的视觉组合层。它集中管理纯 TUI 行为，使逻辑扩展可以脱离视觉代码运行。从 `package.json` 中移除 `./extensions/wow-tui/index.ts` 会关闭这些视觉效果，但 workflow/cache/tool 逻辑仍然可用。

它拥有包级别的 TUI 单例资源：

- **Footer compositor**：自定义两行 footer，包含可点击 CWD、git branch、model/thinking level、context usage bar、token/cache/cost stats 和 extension statuses
- **Composite editor**：`𝝅` 顶部边框 label、workflow prefix 边框颜色、中文 IME 全角前缀转换（`？` `！` `￥` → `?` `!` `$`）
- **Workflow presenter**：基于 workflow state 展示 status indicator 和 todo widget
- **BTW message rendering**：为 `/btw:*` side-channel messages 提供自定义渲染
- **Focus-style tool rendering**：内置工具（`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`）以单行 dim-text 显示工具调用，并隐藏结果预览
- **Config UI**：`/config:global` 和 `/config:project` 打开固定 scope 的交互式配置界面，可管理模型/thinking 默认值、常用 settings（theme、transport、queue、retry、compaction、terminal/editor、shell/session、warnings），以及资源路径/source 数组（`extensions`、`skills`、`prompts`、`themes`、`packages`）。按 `Ctrl+U` 可在当前 scope unset 并回退到继承的 global 或内置默认值；`Esc` 用于返回或退出菜单。项目级模型变更会立即应用，同时恢复原来的全局默认模型。

自定义工具可以复用 `wow/renderer.ts` 中的共享 dim rendering 工具（`createFocusRenderCall`、`focusRenderResult`）。

#### Wow Theme Variables

Wow 专属颜色通过 pi theme 的可选 `vars` 条目定义，不会写入 pi 封闭的
`colors` schema，因此 theme 文件仍然是合法的 pi theme。未定义或无效的值会回退到 Wow 内置 palette。

```json
{
  "vars": {
    "wow.workflow.discussBorder": "#7a5ea0",
    "wow.workflow.planBorder": "#f5a742",
    "wow.workflow.reviseBorder": "#c9a84c",
    "wow.workflow.executeBorder": "#5c9cf5",
    "wow.footer.cwd": "#c9a84c",
    "wow.footer.branch": "#7a5ea0",
    "wow.footer.model": "#1faf7a",
    "wow.footer.tokens": "#17dae7",
    "wow.footer.cache": "#1faf7a",
    "wow.footer.cost": "#c9a84c",
    "wow.footer.status": "#666666",
    "wow.footer.contextOk": "#1faf7a",
    "wow.footer.contextWarn": "#c9a84c",
    "wow.footer.contextDanger": "#e8634f"
  }
}
```

取值格式与 pi theme vars 相同：`"#RRGGBB"`、`0`-`255`、`""` 或另一个 var 名称。

### Prefix Cache — Reasonix-Style Prompt Stability

优化 provider prefix-cache 命中率，尤其适用于 DeepSeek/OpenAI-compatible reasoning models：

- 从 provider context copy 中移除 assistant `thinking` / `reasoning_content`，同时保留在本地 session/UI 中
- 规范化 OpenAI-compatible provider tool schemas，并按工具名排序，保持 deterministic payload bytes
- 将 LLM context 中的 text tool results 限制在 32KB，并把超大完整输出保存到临时文件
- workflow modes 不切换 active tools；安全限制通过 `tool_call` gates 实现
- 提供 `/cache-stats` 查看 session cache usage，提供 `/cache-doctor` 检查常见稳定性问题

**开发规则：** 后续扩展应避免 per-turn system prompt mutations、active tool switching、nondeterministic tool schemas 和 oversized tool results。动态 mode state 应放在 user/custom turn-tail messages 或 runtime gates 中。

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

| Parameter | Default      | Description                            |
| --------- | ------------ | -------------------------------------- |
| `url`     | (required)   | 要获取的 URL                           |
| `format`  | `"markdown"` | 输出格式：`markdown`、`text` 或 `html` |
| `timeout` | 30           | Timeout 秒数（最大 120）               |

## 架构

### Shared Utility Layer — `extensions/wow/`

该包使用集中式 base extension（`wow`）为其他扩展提供共享工具。它本身不注册运行时行为、没有副作用，只作为通用函数的 import source。

| Sub-module    | Exports                                                                                                                             | Used by                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `locale.ts`   | `detectLocale`, `detectPrimaryLocale`, `localeToDisplayName`, `buildLanguageInstruction`, `buildStableLanguagePolicy`, `LOCALE_MAP` | locale, local UI/template helpers |
| `renderer.ts` | `createFocusRenderCall`, `focusRenderCall`, `focusRenderResult`                                                                     | webfetch, custom tools            |
| `paths.ts`    | `shortenPath`, `linkPath`, `shortenCommand`                                                                                         | wow-tui                           |
| `html.ts`     | `convertHTMLToMarkdown`, `extractTextFromHTML`, `stripTags`, `isRasterImage`, `STRIP_TAGS`                                          | webfetch                          |
| `shell.ts`    | `execOrNull`, `execWithError`                                                                                                       | git-commit                        |
| `safe.ts`     | `isSafeCommand`                                                                                                                     | human-led-coding-workflow         |

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

### Logic / Visual Boundary

- 逻辑扩展负责行为、状态、工具、命令、provider hooks 和安全 gate。
- `wow-tui` 负责包级视觉组合和 TUI 单例资源。
- 逻辑扩展不应调用 `ctx.ui.setFooter()` 或 `ctx.ui.setEditorComponent()`。
- 移除 `wow-tui` 不应破坏 workflow、cache、commit 或 webfetch 行为。

## 开发

```bash
# 修改扩展后，运行 /reload 或重启 pi
```

### 约定

- **对话**：user-AI communication follows the user's current language
- **技术内容**：code、comments、config、documentation、commit messages 使用 English
- **代码风格**：TypeScript，遵循现有代码风格
- **共享工具**：所有可复用函数放在 `extensions/wow/`，不要重复实现
- **视觉组合**：包级视觉放在 `extensions/wow-tui/`；feature logic 应暴露 UI-independent state
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
│   │   ├── widgets.ts       # Workflow status/todo presenters
│   │   └── btw.ts           # BTW custom message renderers
│   ├── webfetch/            # Fetch web content and convert to markdown/text/html
│   │   └── index.ts         # webfetch tool using native fetch + node-html-markdown conversion
│   ├── btw/                 # /btw:* isolated side-channel Q&A threads
│   │   ├── index.ts         # Commands, standalone LLM calls, context filtering
│   │   ├── prompts.ts       # Side-channel and promotion prompts
│   │   ├── state.ts         # Topic state persisted via custom entries
│   │   └── types.ts         # Shared custom message type identifiers
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
