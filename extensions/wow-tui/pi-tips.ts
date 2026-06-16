/**
 * Advanced pi-native working tips.
 */

import { registerWowTips, type WowTipInput } from "../wow/tips.ts";

const TIPS: WowTipInput[] = [
  {
    id: "pi-tree-branching",
    short: "Use /tree to jump to earlier session entries and continue from there without creating a new file.",
    tags: ["pi", "sessions", "tree"],
    priority: 70,
  },
  {
    id: "pi-tree-edit-resubmit",
    short: "Selecting a user message in /tree puts it back in the editor so you can edit and resubmit a new branch.",
    tags: ["pi", "sessions", "tree"],
    priority: 70,
  },
  {
    id: "pi-tree-labels",
    short: "Label important checkpoints in /tree, then use labeled-only filtering to find them quickly later.",
    tags: ["pi", "sessions", "tree"],
    priority: 60,
  },
  {
    id: "pi-tree-branch-summary",
    short: "When /tree leaves a branch, ask for a branch summary to carry useful context into the new path.",
    tags: ["pi", "sessions", "compaction"],
    priority: 70,
  },
  {
    id: "pi-fork-vs-tree",
    short: "Use /tree for alternatives inside one session; use /fork when you want a separate session file.",
    tags: ["pi", "sessions"],
    priority: 60,
  },
  {
    id: "pi-clone-safety",
    short: "Use /clone before a risky direction change to duplicate the active branch into a new session file.",
    tags: ["pi", "sessions"],
    priority: 55,
  },
  {
    id: "pi-name-sessions",
    short: "Use /name to give long-running sessions searchable names before you need to find them in /resume.",
    tags: ["pi", "sessions"],
    priority: 50,
  },
  {
    id: "pi-resume-filters",
    short: "The /resume picker can search, sort, toggle paths, filter named sessions, rename, and delete old sessions.",
    tags: ["pi", "sessions"],
    priority: 45,
  },
  {
    id: "pi-compact-custom-prompt",
    short: "Use /compact with custom instructions to focus the summary on decisions, files, or unresolved risks.",
    tags: ["pi", "compaction"],
    priority: 70,
  },
  {
    id: "pi-auto-compaction-settings",
    short: "Tune compaction.reserveTokens and compaction.keepRecentTokens when you want different context retention behavior.",
    tags: ["pi", "compaction", "settings"],
    priority: 50,
  },
  {
    id: "pi-branch-summary-settings",
    short: "Set branchSummary.skipPrompt to skip the /tree branch-summary prompt and default to no summary.",
    tags: ["pi", "compaction", "settings"],
    priority: 45,
  },
  {
    id: "pi-message-steering",
    short: "Submit while the agent is working to queue a steering message after the current tool-call batch.",
    tags: ["pi", "queue"],
    priority: 65,
  },
  {
    id: "pi-message-follow-up",
    short: "Queue a follow-up message when you want it delivered only after the agent finishes all current work.",
    tags: ["pi", "queue"],
    priority: 60,
  },
  {
    id: "pi-message-dequeue",
    short: "Queued the wrong thing? Use the dequeue shortcut from /hotkeys to pull queued messages back into the editor.",
    tags: ["pi", "queue", "keybindings"],
    priority: 50,
  },
  {
    id: "pi-message-abort-restore",
    short: "Interrupting active work restores queued messages to the editor, so they are not lost.",
    tags: ["pi", "queue"],
    priority: 50,
  },
  {
    id: "pi-shell-visible-output",
    short: "Prefix input with ! to run a shell command and send its output to the model as context.",
    tags: ["pi", "shell"],
    priority: 60,
  },
  {
    id: "pi-shell-hidden-output",
    short: "Prefix input with !! to run a shell command without sending its output to the model.",
    tags: ["pi", "shell"],
    priority: 65,
  },
  {
    id: "pi-shell-prefix",
    short: "Use shellCommandPrefix to preload aliases, environment setup, or shell options for every bash tool call.",
    tags: ["pi", "shell", "settings"],
    priority: 45,
  },
  {
    id: "pi-prompt-template-arguments",
    short: "Prompt templates support $1, $@, defaults like ${1:-value}, and argument slicing.",
    tags: ["pi", "prompts"],
    priority: 60,
  },
  {
    id: "pi-prompt-template-hints",
    short: "Add description and argument-hint frontmatter to prompt templates for better slash-command autocomplete.",
    tags: ["pi", "prompts"],
    priority: 55,
  },
  {
    id: "pi-prompt-template-project",
    short: "Share team prompt templates from .pi/prompts; they load after the project is trusted.",
    tags: ["pi", "prompts", "trust"],
    priority: 50,
  },
  {
    id: "pi-skills-progressive-disclosure",
    short: "Skills keep only descriptions in the system prompt; full SKILL.md files load on demand when needed.",
    tags: ["pi", "skills"],
    priority: 60,
  },
  {
    id: "pi-skill-command-force",
    short: "Use /skill:name to force-load a skill when you do not want to rely on automatic skill selection.",
    tags: ["pi", "skills"],
    priority: 55,
  },
  {
    id: "pi-skills-cross-harness",
    short: "Point the skills setting at ~/.claude/skills or ~/.codex/skills to reuse skills from other harnesses.",
    tags: ["pi", "skills", "settings"],
    priority: 45,
  },
  {
    id: "pi-packages-project-local",
    short: "Use pi install -l to add a package to project settings so teammates get the same resources after trust.",
    tags: ["pi", "packages", "trust"],
    priority: 55,
  },
  {
    id: "pi-package-filtering",
    short: "Use object-form package filters to load only selected extensions, skills, prompts, or themes from a package.",
    tags: ["pi", "packages", "settings"],
    priority: 50,
  },
  {
    id: "pi-package-temporary",
    short: "Use pi -e npm:pkg or pi -e git:repo to try an extension package for the current run only.",
    tags: ["pi", "packages", "cli"],
    priority: 45,
  },
  {
    id: "pi-scoped-models",
    short: "Use /scoped-models to choose and order the models that model-cycling should visit.",
    tags: ["pi", "models"],
    priority: 60,
  },
  {
    id: "pi-model-thinking-shorthand",
    short: "Start pi with --model provider/model:high to choose both model and thinking level in one flag.",
    tags: ["pi", "models", "cli"],
    priority: 50,
  },
  {
    id: "pi-thinking-hide",
    short: "Set hideThinkingBlock when you want reasoning blocks hidden while still preserving normal session flow.",
    tags: ["pi", "thinking", "settings"],
    priority: 45,
  },
  {
    id: "pi-print-pipe",
    short: "Pipe stdin into pi -p for fast one-shot analysis, for example: cat README.md | pi -p \"Summarize\".",
    tags: ["pi", "cli"],
    priority: 60,
  },
  {
    id: "pi-cli-at-files",
    short: "Use @files at startup, including images, to include them in the initial message.",
    tags: ["pi", "cli", "files"],
    priority: 55,
  },
  {
    id: "pi-cli-readonly-tools",
    short: "Start read-only reviews with --tools read,grep,find,ls so write-capable tools are unavailable.",
    tags: ["pi", "cli", "tools"],
    priority: 60,
  },
  {
    id: "pi-cli-exclude-tools",
    short: "Use --exclude-tools to disable one risky or noisy tool while leaving the rest of the toolset enabled.",
    tags: ["pi", "cli", "tools"],
    priority: 45,
  },
  {
    id: "pi-context-discovery",
    short: "Pi loads AGENTS.md or CLAUDE.md globally and from parent directories, so repo conventions can follow the cwd.",
    tags: ["pi", "context"],
    priority: 55,
  },
  {
    id: "pi-append-system",
    short: "Use APPEND_SYSTEM.md to extend the default system prompt without replacing pi's built-in instructions.",
    tags: ["pi", "context"],
    priority: 50,
  },
  {
    id: "pi-project-trust",
    short: "Use /trust to save a project trust decision; restart pi afterward so project resources are loaded.",
    tags: ["pi", "trust"],
    priority: 60,
  },
  {
    id: "pi-approve-flags",
    short: "Use --approve or --no-approve to control project trust for one CLI or non-interactive run.",
    tags: ["pi", "trust", "cli"],
    priority: 50,
  },
  {
    id: "pi-theme-hot-reload",
    short: "Edit the active custom theme file and pi hot-reloads it for immediate visual feedback.",
    tags: ["pi", "themes"],
    priority: 45,
  },
  {
    id: "pi-theme-schema",
    short: "Add the theme $schema field to custom themes for editor completion and validation.",
    tags: ["pi", "themes"],
    priority: 40,
  },
  {
    id: "pi-export-html",
    short: "Use /export [file] to archive a session as HTML for review, debugging, or sharing internally.",
    tags: ["pi", "sessions", "export"],
    priority: 45,
  },
  {
    id: "pi-share-gist",
    short: "Use /share to upload the current session as a private GitHub gist with a shareable HTML link.",
    tags: ["pi", "sessions", "share"],
    priority: 40,
  },
  {
    id: "pi-session-dir",
    short: "Set sessionDir or PI_CODING_AGENT_SESSION_DIR when you want sessions stored outside the default agent dir.",
    tags: ["pi", "sessions", "settings"],
    priority: 40,
  },
  {
    id: "pi-reload-resources",
    short: "Use /reload after changing keybindings, extensions, skills, prompt templates, or themes.",
    tags: ["pi", "resources"],
    priority: 55,
  },
  {
    id: "pi-npm-command",
    short: "Set npmCommand to force package installs through a wrapper such as mise, asdf, or a pinned Node toolchain.",
    tags: ["pi", "packages", "settings"],
    priority: 40,
  },
];

export function registerPiNativeTips(): () => void {
  return registerWowTips("pi-native", TIPS);
}
