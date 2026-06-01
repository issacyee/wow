/**
 * Plan Mode — ?/??/$ stateless planning workflow
 *
 * Input conventions:
 *   ?       Start a new plan
 *   ??      Continue/adjust the previous plan (fallback to new plan if none)
 *   $       Execute the current plan
 *   $ <text> Execute the plan with adjustments
 *
 * Chinese IME support: full-width ？ (U+FF1F), ！ (U+FF01) and ￥ (U+FFE5)
 * entered at the start of the editor are automatically converted to ?, ! and
 * $, so users don't need to toggle between Chinese/English input methods.
 *
 * Editor border colors:
 *   ? / ??  #f5a742 (orange)
 *   $        #5c9cf5 (blue)
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

import { isSafeCommand } from "./safe.ts";
import { extractPlanItems, markCompletedSteps, detectPrimaryLocale, ACTION_MARKER, type TodoItem } from "./plan.ts";

// ── Constants ──

/** Read-only tools available in planning mode */
const PLANNING_TOOLS = ["read", "grep", "find", "ls", "questionnaire"];

// ── Plan locale i18n ──

interface PlanLocale {
  hereIsMyPlan: string;
  plan: string;
  background: string;
  approach: string;
  filesToModify: string;
  verification: string;
  backgroundDesc: string;
  approachDesc: string;
  filesDesc: string;
  verificationDesc: string;
}

const PLAN_LOCALES: Record<string, PlanLocale> = {
  zh: {
    hereIsMyPlan: "这是我的计划：",
    plan: "计划",
    background: "背景",
    approach: "方案",
    filesToModify: "待修改文件",
    verification: "验证",
    backgroundDesc: "为什么需要这个改动（问题背景、触发原因、预期目标）",
    approachDesc: "推荐的解决方案及编号步骤",
    filesDesc: "关键文件路径及改动说明",
    verificationDesc: "如何端到端测试改动（命令、测试步骤等）",
  },
  en: {
    hereIsMyPlan: "Here's my plan:",
    plan: "Plan",
    background: "Background",
    approach: "Approach",
    filesToModify: "Files to Modify",
    verification: "Verification",
    backgroundDesc: "why this change is needed (problem, trigger, expected outcome)",
    approachDesc: "recommended solution with numbered, actionable steps",
    filesDesc: "critical file paths with brief descriptions of changes",
    verificationDesc: "how to test the changes end-to-end (commands, test steps)",
  },
};

function getPlanLocale(): PlanLocale {
  const locale = detectPrimaryLocale();
  return PLAN_LOCALES[locale] ?? PLAN_LOCALES.en;
}

function buildNewPlanPrompt(): string {
  const t = getPlanLocale();
  return `[PLAN MODE - NEW PLAN]

You are creating a completely new plan. Follow this structured multi-phase workflow:

## Phase 1: Understand the Request
Goal: Understand the user\'s request and explore the codebase.
- Use read, grep, find, ls to explore relevant code
- Ask clarifying questions if the request is ambiguous
- Do NOT make assumptions about user intent — verify by reading code
- If the scope is uncertain or spans multiple areas, you may use the subagent tool to delegate exploration tasks
- Make sure you understand what files and patterns exist before designing

## Phase 2: Design the Approach
Goal: Design an implementation approach based on your findings.
- Design the solution based on your Phase 1 understanding
- For complex tasks, you may use the subagent tool (e.g., with a "planner" agent) to help design
- Converge on one recommended approach — do not present multiple alternatives
- You may ask the user about key tradeoffs if uncertain

## Phase 3: Review and Write Final Plan
Goal: Verify alignment with user intent and write the final plan.
- Verify the design addresses the original request
- Read critical files to deepen understanding if needed
- Output the plan starting with \`## ${t.plan}:\` header following the quality standards below

## Plan Quality Standards

The plan must include:
1. **${t.background}** — ${t.backgroundDesc}
2. **${t.approach}** — ${t.approachDesc}
3. **${t.filesToModify}** — ${t.filesDesc}
4. **${t.verification}** — ${t.verificationDesc}

Do NOT include:
- Alternative approaches that were rejected
- Actual code implementation (that belongs in execution phase)
- Information the user already provided

Each numbered step should be concrete and directly actionable — detailed enough to execute without additional exploration, but concise enough to scan quickly.

Output format:

${t.hereIsMyPlan}

## ${t.plan}: {short title}

### ${t.background}
{${t.backgroundDesc}}

### ${t.approach}
1. **Action** — description, \`target file\`.
2. **Action** — description, \`target file\`.
3. ...

### ${t.filesToModify}
- \`path/to/file.ts\` — {description}

### ${t.verification}
{${t.verificationDesc}}

After the human-readable plan above, add a concise action summary. Start with a line:

${ACTION_MARKER}

Then list each numbered step (plain text, no bold/backticks):

1. Do this first
2. Then do this
3. Finally do this

This action summary is REQUIRED — the system needs it to reliably move from planning to execution.

Rules:
- DO NOT edit any files
- Only read-only tools allowed
- At any point, feel free to ask the user questions`;
}

function buildContinuePlanPrompt(): string {
  const t = getPlanLocale();
  return `[PLAN MODE - CONTINUE PLAN]

Review the existing plan in light of new user input and update it.

1. Understand the new input and how it affects the existing plan
2. Read relevant code if needed to verify your understanding
3. Update the plan following these quality standards:
   - Include **${t.background}** — ${t.backgroundDesc}
   - Include **${t.approach}** — ${t.approachDesc}
   - Include **${t.filesToModify}** — ${t.filesDesc}
   - Include **${t.verification}** — ${t.verificationDesc}
4. Output the FULL updated plan starting with \`## ${t.plan}:\` header

Plan quality rules:
- Only include the recommended approach, not alternatives
- Do not include actual code (that\'s for execution)
- Keep steps concise but actionable

Output format:

${t.hereIsMyPlan}

## ${t.plan}: {short title}

### ${t.background}
{${t.backgroundDesc}}

### ${t.approach}
1. **Action** — description, \`target file\`.
2. **Action** — description, \`target file\`.
3. ...

### ${t.filesToModify}
- \`path/to/file.ts\` — {description}

### ${t.verification}
{${t.verificationDesc}}

After the human-readable plan above, add a concise action summary. Start with a line:

${ACTION_MARKER}

Then list each numbered step (plain text, no bold/backticks):

1. Do this first
2. Then do this
3. Finally do this

This action summary is REQUIRED — the system needs it to reliably move from planning to execution.

Rules:
- DO NOT edit any files
- Always output the COMPLETE plan, not just the changes`;
}

// ── Helpers ──

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent & { type: "text" } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// ── Custom editor (border color by input prefix) ──

class PlanModeEditor extends CustomEditor {
  private planBorderColor: (str: string) => string;
  private execBorderColor: (str: string) => string;
  /** Native border color set by the framework (thinking level, bash mode) */
  private _storedBorderColor!: (str: string) => string;
  /** Mode border color override (null = use stored native color) */
  private _modeBorderColor: ((str: string) => string) | null = null;

  constructor(tui: any, theme: any, keybindings: any) {
    super(tui, theme, keybindings);
    this.planBorderColor = (s) => `\x1b[38;2;245;167;66m${s}\x1b[0m`;
    this.execBorderColor = (s) => `\x1b[38;2;92;156;245m${s}\x1b[0m`;

    // Save initial native border color from theme
    this._storedBorderColor = theme.borderColor;

    // Intercept borderColor property to track framework changes
    // (updateEditorBorderColor sets this.editor.borderColor on thinking/bash mode changes)
    Object.defineProperty(this, "borderColor", {
      get: () => this._modeBorderColor ?? this._storedBorderColor,
      set: (fn) => { this._storedBorderColor = fn; },
      configurable: true,
      enumerable: true,
    });
  }

  handleInput(data: string): void {
    // Chinese IME: convert full-width prefix characters to half-width
    // when typing at the start of the editor, so users don't need to
    // toggle between Chinese/English input methods to use ?/??/!/$ commands.
    if (data.length === 1 && (data === "\uFF1F" || data === "\uFF01" || data === "\uFFE5")) {
      const text = this.getText();
      const cursor = this.getCursor();

      if (cursor.line === 0 && cursor.col === 0) {
        // At the very beginning of input: ？ → ?, ！ → !, ￥ → $
        const map: Record<string, string> = {
          "\uFF1F": "?",
          "\uFF01": "!",
          "\uFFE5": "$",
        };
        super.handleInput(map[data]);
        return;
      }

      // After an existing "?" to form "??" (e.g. ？ + ？ → ??)
      if (data === "\uFF1F" && text === "?" && cursor.line === 0 && cursor.col === 1) {
        super.handleInput("?");
        return;
      }
    }

    super.handleInput(data);
  }

  render(width: number): string[] {
    const text = this.getText();

    if (text.startsWith("??") || text.startsWith("?")) {
      this._modeBorderColor = this.planBorderColor;
    } else if (text.startsWith("$")) {
      this._modeBorderColor = this.execBorderColor;
    } else {
      // Fall back to native border color managed by the framework
      this._modeBorderColor = null;
    }

    return super.render(width);
  }
}

// ── Module-level state ──

type TurnMode = "plan-new" | "plan-continue" | "executing" | null;

let turnMode: TurnMode = null;
let todoItems: TodoItem[] = [];
let lastTurnHadPlan = false;
let hasAdjustment = false;
let planFullText = "";

// ── Extension entry ──

export default function planModeExtension(pi: ExtensionAPI): void {

  // ──────────────────────────────────────
  //  input — detect ? / ?? / $ prefix
  // ──────────────────────────────────────

  pi.on("input", async (event, ctx) => {
    // ?? must come first to avoid being consumed by ?
    if (event.text.startsWith("??")) {
      const text = event.text.slice(2).trim();
      if (lastTurnHadPlan || todoItems.length > 0) {
        turnMode = "plan-continue";
        pi.setActiveTools(PLANNING_TOOLS);
      } else {
        // No previous plan, fallback to new plan
        turnMode = "plan-new";
        pi.setActiveTools(PLANNING_TOOLS);
        todoItems = [];
        planFullText = "";
      }
      return { action: "transform", text };
    }

    if (event.text.startsWith("?")) {
      const text = event.text.slice(1).trim();
      turnMode = "plan-new";
      todoItems = [];
      planFullText = "";
      pi.setActiveTools(PLANNING_TOOLS);
      return { action: "transform", text };
    }

    if (event.text.startsWith("$")) {
      const text = event.text.slice(1).trim();
      if (!lastTurnHadPlan && todoItems.length === 0) {
        ctx.ui.notify("No active plan to execute", "info");
        turnMode = null;
        return { action: "handled" };
      }
      turnMode = "executing";
      hasAdjustment = text.length > 0;
      pi.setActiveTools(pi.getAllTools().map(t => t.name));
      return { action: "transform", text };
    }

    // Normal input, no plan mode behavior
    turnMode = null;
    return { action: "continue" };
  });

  // ──────────────────────────────────────
  //  before_agent_start — inject system context
  // ──────────────────────────────────────

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (turnMode === "plan-new") {
      return {
        message: {
          customType: "plan-mode-context",
          content: buildNewPlanPrompt(),
          display: false,
        },
      };
    }

    if (turnMode === "plan-continue") {
      return {
        message: {
          customType: "plan-mode-context",
          content: buildContinuePlanPrompt(),
          display: false,
        },
      };
    }

    if (turnMode === "executing") {
      const remaining = todoItems.filter((t) => !t.completed);
      const steps =
        remaining.length > 0
          ? remaining.map((t) => `${t.step}. ${t.text}`).join("\n")
          : "(no extracted plan items, use best judgment)";

      const planSection = planFullText
        ? `\n---\nFull plan context:\n${planFullText}\n---`
        : "";

      if (hasAdjustment) {
        return {
          message: {
            customType: "plan-execution-context",
            content: `[EXECUTING PLAN - WITH ADJUSTMENTS]

The user has provided additional input.
First review and adjust the existing plan based on this input, then execute the updated steps.${planSection}

Current remaining steps:
${steps}

After completing a step, include [DONE:n] in your response.`,
            display: false,
          },
        };
      }

      return {
        message: {
          customType: "plan-execution-context",
          content: `[EXECUTING PLAN]

Remaining steps:
${steps}${planSection}

Execute each step in order using full tool access.
After completing a step, include [DONE:n] in your response.

Example: "...created the user model. [DONE:1]"`,
          display: false,
        },
      };
    }
  });

  // ──────────────────────────────────────
  //  tool_call — block write operations in planning mode
  // ──────────────────────────────────────

  pi.on("tool_call", async (event) => {
    if (turnMode !== "plan-new" && turnMode !== "plan-continue") return;

    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        block: true,
        reason: `Plan mode: ${event.toolName} is disabled. Create a plan first with ?, then execute with $.`,
      };
    }

    if (event.toolName === "bash") {
      const command = event.input.command as string;
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Plan mode: dangerous command blocked. Only read-only commands are allowed.
Blocked command: ${command}`,
        };
      }
    }
  });

  // ──────────────────────────────────────
  //  turn_end — [DONE:n] progress tracking
  // ──────────────────────────────────────

  pi.on("turn_end", async (event, _ctx) => {
    if (turnMode !== "executing" || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    markCompletedSteps(text, todoItems);
  });

  // ──────────────────────────────────────
  //  agent_end — extract plan / detect completion
  // ──────────────────────────────────────

  pi.on("agent_end", async (event) => {
    if (turnMode === "plan-new" || turnMode === "plan-continue") {
      // Search assistant messages in REVERSE for the most recent plan.
      // The AI may output a tentative plan early (before tool calls) then refine
      // it later — the last occurrence is the latest version the user wants to execute.
      // But it may also put the plan only in an early message with just a summary
      // at the end, so we can't only check the very last message either.
      let extracted: TodoItem[] = [];
      let extractedText = "";
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const msg = event.messages[i];
        if (!isAssistantMessage(msg)) continue;
        const text = getTextContent(msg);
        extracted = extractPlanItems(text);
        if (extracted.length > 0) {
          extractedText = text;
          break;
        }
      }
      if (extracted.length > 0) {
        todoItems = extracted;
        planFullText = extractedText;
        lastTurnHadPlan = true;
      } else {
        lastTurnHadPlan = false;
        planFullText = "";
      }
    }

    if (turnMode === "executing" && todoItems.length > 0) {
      if (todoItems.every((t) => t.completed)) {
        const completedList = todoItems
          .map((t) => (t.completed ? `☑ ${t.text}` : `☐ ${t.text}`))
          .join("\n");
        pi.sendMessage(
          { customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
          { triggerTurn: false },
        );
        todoItems = [];
        planFullText = "";
        lastTurnHadPlan = false;
      }
    }

    turnMode = null;
    hasAdjustment = false;
  });

  // ──────────────────────────────────────
  //  session_start — install custom editor
  // ──────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      return new PlanModeEditor(tui, theme, keybindings);
    });
  });
}
