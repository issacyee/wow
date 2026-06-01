/**
 * Plan Mode — ?/??/$ stateless planning workflow
 *
 * Input conventions:
 *   ?       Start a new plan
 *   ??      Continue/adjust the previous plan (fallback to new plan if none)
 *   $       Execute the current plan
 *   $ <text> Execute the plan with adjustments
 *
 * Chinese IME support: full-width ？ (U+FF1F) and ￥ (U+FFE5) entered at the
 * start of the editor are automatically converted to ? and $, so users don't
 * need to toggle between Chinese/English input methods.
 *
 * Editor border colors:
 *   ? / ??  #f5a742 (orange)
 *   $        #5c9cf5 (blue)
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

import { isSafeCommand } from "./safe.ts";
import { extractPlanItems, markCompletedSteps, type TodoItem } from "./plan.ts";

// ── Constants ──

/** Read-only tools available in planning mode */
const PLANNING_TOOLS = ["read", "grep", "find", "ls", "questionnaire"];

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
    // toggle between Chinese/English input methods to use ?/??/$ commands.
    if (data.length === 1 && (data === "\uFF1F" || data === "\uFFE5")) {
      const text = this.getText();
      const cursor = this.getCursor();

      if (cursor.line === 0 && cursor.col === 0) {
        // At the very beginning of input: ？ → ?, ￥ → $
        super.handleInput(data === "\uFF1F" ? "?" : "$");
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
      }
      return { action: "transform", text };
    }

    if (event.text.startsWith("?")) {
      const text = event.text.slice(1).trim();
      turnMode = "plan-new";
      todoItems = [];
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
          content: `[PLAN MODE - NEW PLAN]

You are creating a completely new plan.

Guidelines:
- Use read-only tools (read, grep, find, ls) to explore the codebase
- Ask clarifying questions if needed
- Think about the best approach

Output the plan in the following format:

<plan-mode>

## Plan: {short title describing the goal}

1. **Action** — brief description, \`target file\`.
2. **Action** — brief description, \`target file\`.
3. ...

</plan-mode>

Rules:
- DO NOT edit any files
- Each step should have a clear action verb and target`,
          display: false,
        },
      };
    }

    if (turnMode === "plan-continue") {
      return {
        message: {
          customType: "plan-mode-context",
          content: `[PLAN MODE - CONTINUE PLAN]

Review the existing plan and adjust based on new input.

Guidelines:
- Use read-only tools (read, grep, find, ls) to explore if needed
- Output the FULL updated plan, not just the changes

Format (output the complete plan):

<plan-mode>

## Plan: {short title}

1. **Action** — description, \`target file\`.
2. **Action** — description, \`target file\`.
3. ...

</plan-mode>

Rules:
- DO NOT edit any files
- Always wrap the FULL plan in <plan-mode> tags`,
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

      if (hasAdjustment) {
        return {
          message: {
            customType: "plan-execution-context",
            content: `[EXECUTING PLAN - WITH ADJUSTMENTS]

The user has provided additional input.
First review and adjust the existing plan based on this input, then execute the updated steps.

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
${steps}

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
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const msg = event.messages[i];
        if (!isAssistantMessage(msg)) continue;
        const text = getTextContent(msg);
        extracted = extractPlanItems(text);
        if (extracted.length > 0) break;
      }
      if (extracted.length > 0) {
        todoItems = extracted;
        lastTurnHadPlan = true;
      } else {
        lastTurnHadPlan = false;
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
