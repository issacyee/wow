/**
 * Plan Mode — ?/??/$ stateless planning workflow
 *
 * Input conventions:
 *   ?       Start a new plan
 *   ??      Continue/adjust the previous plan (fallback to new plan if none)
 *   $       Execute the current plan
 *   $ <text> Execute the plan with adjustments
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
const PLANNING_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];

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
  private defaultBorderColor: ((str: string) => string) | null = null;
  private planBorderColor: (str: string) => string;
  private execBorderColor: (str: string) => string;

  constructor(tui: any, theme: any, keybindings: any) {
    super(tui, theme, keybindings);
    this.planBorderColor = (s) => `\x1b[38;2;245;167;66m${s}\x1b[0m`;
    this.execBorderColor = (s) => `\x1b[38;2;92;156;245m${s}\x1b[0m`;
  }

  render(width: number): string[] {
    const text = this.getText();

    if (!this.defaultBorderColor) {
      this.defaultBorderColor = this.borderColor;
    }

    if (text.startsWith("??") || text.startsWith("?")) {
      this.borderColor = this.planBorderColor;
    } else if (text.startsWith("$")) {
      this.borderColor = this.execBorderColor;
    } else {
      this.borderColor = this.defaultBorderColor;
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
Your job:
- Use read-only tools (read, grep, find, ls) to explore the codebase
- Ask clarifying questions if needed
- Think about the best approach
- Produce a numbered plan under a "Plan:" header

Rules:
- DO NOT edit any files
- DO NOT execute non-read-only bash commands

Example plan format:
Plan:
1. First step description
2. Second step description
3. Third step description`,
          display: false,
        },
      };
    }

    if (turnMode === "plan-continue") {
      return {
        message: {
          customType: "plan-mode-context",
          content: `[PLAN MODE - CONTINUE PLAN]

Continue the previous plan discussion.
Your job:
- Review the existing plan (if any) and adjust it based on new input
- Use read-only tools (read, grep, find, ls) to explore if needed
- Think about adjustments and produce an updated numbered plan under a "Plan:" header

Rules:
- DO NOT edit any files
- DO NOT execute non-read-only bash commands`,
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
    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (!lastAssistant) {
      turnMode = null;
      hasAdjustment = false;
      return;
    }

    const text = getTextContent(lastAssistant);

    if (turnMode === "plan-new" || turnMode === "plan-continue") {
      const extracted = extractPlanItems(text);
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
