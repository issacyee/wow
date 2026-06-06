/**
 * Human-Led Coding Workflow — ? / ?? / ?! / $ workflow extension.
 *
 * The human stays the decision maker. The AI can discuss, write plans, revise
 * plans, and execute only after explicit approval.
 *
 * Prefix-cache rules:
 * - Never mutate the system prompt.
 * - Never switch active tools for modes.
 * - Enforce read-only restrictions with tool_call gates.
 * - Persist extension state with custom entries, not context messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { HumanLedWorkflowEditor } from "./editor.ts";
import {
  buildDiscussPrompt,
  buildExecutePrompt,
  buildPlanPrompt,
  buildRevisePrompt,
  WORKFLOW_CONTEXT_TYPE,
  type WorkflowMode,
} from "./prompts.ts";
import {
  extractPlanItems,
  extractPlanText,
  hasExecuteMarker,
  hasPlanStructure,
  isCompletePlan,
  markCompletedSteps,
  type TodoItem,
} from "./plan.ts";
import { isSafeCommand } from "../wow/safe.ts";

const STATE_TYPE = "human-led-coding-workflow";
const MAX_RESTORED_PLAN_CHARS = 12_000;
const READ_ONLY_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "webfetch"]);

type TurnMode = WorkflowMode | null;

interface WorkflowState {
  activePlan: boolean;
  planFullText: string;
  todoItems: TodoItem[];
  executed: boolean;
}

let turnMode: TurnMode = null;
let hasExecutionAdjustment = false;
let planFromPreviousDiscussion = false;
let activePlan = false;
let planFullText = "";
let todoItems: TodoItem[] = [];
let executed = false;

function resetState(): void {
  turnMode = null;
  hasExecutionAdjustment = false;
  planFromPreviousDiscussion = false;
  activePlan = false;
  planFullText = "";
  todoItems = [];
  executed = false;
}

function currentState(): WorkflowState {
  return {
    activePlan,
    planFullText,
    todoItems,
    executed,
  };
}

function restoreState(data: Partial<WorkflowState> | undefined): void {
  activePlan = data?.activePlan ?? false;
  planFullText = typeof data?.planFullText === "string" ? data.planFullText : "";
  todoItems = Array.isArray(data?.todoItems) ? data.todoItems : [];
  executed = data?.executed ?? false;
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry(STATE_TYPE, currentState());
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent & { type: "text" } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function truncatePlanForRestore(text: string): string | undefined {
  if (!text) return undefined;
  if (text.length <= MAX_RESTORED_PLAN_CHARS) return text;
  return `${text.slice(0, MAX_RESTORED_PLAN_CHARS)}\n\n[Plan context truncated for prefix-cache safety.]`;
}

function planVisibleInCurrentBranch(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch() as any[];
  let scanStart = 0;

  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry?.type !== "compaction") continue;

    if (entry.firstKeptEntryId) {
      const firstKeptIndex = branch.findIndex((candidate) => candidate?.id === entry.firstKeptEntryId);
      scanStart = firstKeptIndex >= 0 ? firstKeptIndex : i + 1;
    } else {
      scanStart = i + 1;
    }
  }

  for (const entry of branch.slice(scanStart)) {
    if (entry?.type !== "message" || !isAssistantMessage(entry.message)) continue;
    const text = getTextContent(entry.message);
    if (hasExecuteMarker(text)) return true;
  }

  return false;
}

function restoredPlanContext(ctx: ExtensionContext): string | undefined {
  if (!planFullText || planVisibleInCurrentBranch(ctx)) return undefined;
  return truncatePlanForRestore(planFullText);
}

function findLatestPlanInMessages(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isAssistantMessage(message)) continue;

    const text = getTextContent(message);
    if (isCompletePlan(text)) return extractPlanText(text);
    if (hasExecuteMarker(text) || hasPlanStructure(text)) return extractPlanText(text);
  }
  return undefined;
}

function latestWorkflowState(ctx: ExtensionContext): Partial<WorkflowState> | undefined {
  const entry = (ctx.sessionManager.getBranch() as any[])
    .filter((candidate: any) => candidate?.type === "custom" && candidate.customType === STATE_TYPE)
    .pop() as { data?: Partial<WorkflowState> } | undefined;
  return entry?.data;
}

function canRecoverInactivePlan(ctx: ExtensionContext): boolean {
  const state = latestWorkflowState(ctx);
  return state === undefined || state.activePlan === true;
}

function recoverPlanFromSession(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager.getBranch();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry.type !== "message" || !("message" in entry) || !isAssistantMessage(entry.message)) continue;

    const text = getTextContent(entry.message);
    if (!hasExecuteMarker(text)) continue;

    planFullText = extractPlanText(text);
    todoItems = extractPlanItems(text);
    activePlan = true;
    executed = false;
    return true;
  }

  return false;
}

function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  if (turnMode === "discuss") {
    ctx.ui.setStatus(STATE_TYPE, ctx.ui.theme.fg("muted", "◇ discuss"));
  } else if (turnMode === "plan") {
    ctx.ui.setStatus(STATE_TYPE, ctx.ui.theme.fg("warning", "◇ plan"));
  } else if (turnMode === "revise") {
    ctx.ui.setStatus(STATE_TYPE, ctx.ui.theme.fg("warning", "◇ revise"));
  } else if (turnMode === "execute" && todoItems.length > 0) {
    const completed = todoItems.filter((item) => item.completed).length;
    ctx.ui.setStatus(STATE_TYPE, ctx.ui.theme.fg("accent", `◇ exec ${completed}/${todoItems.length}`));
  } else if (activePlan) {
    ctx.ui.setStatus(STATE_TYPE, ctx.ui.theme.fg("muted", "◇ plan ready"));
  } else {
    ctx.ui.setStatus(STATE_TYPE, undefined);
  }

  if (turnMode === "execute" && todoItems.length > 0) {
    const lines = todoItems.map((item) => {
      if (item.completed) {
        return ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text));
      }
      return `${ctx.ui.theme.fg("dim", "☐ ")}${item.text}`;
    });
    ctx.ui.setWidget(`${STATE_TYPE}-todos`, lines);
  } else {
    ctx.ui.setWidget(`${STATE_TYPE}-todos`, undefined);
  }
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
  } else {
    console.log(text);
  }
}

function missingArgument(ctx: ExtensionContext, prefix: string): { action: "handled" } {
  notify(ctx, `Please provide text after ${prefix}.`, "info");
  return { action: "handled" };
}

function parseWorkflowInput(text: string): { mode: WorkflowMode; prompt: string } | null {
  if (text.startsWith("?!") || text.startsWith("?！") || text.startsWith("？！") || text.startsWith("？!")) {
    return { mode: "revise", prompt: text.slice(2).trim() };
  }
  if (text.startsWith("??") || text.startsWith("?？") || text.startsWith("？？") || text.startsWith("？?")) {
    return { mode: "plan", prompt: text.slice(2).trim() };
  }
  if (text.startsWith("?") || text.startsWith("？")) return { mode: "discuss", prompt: text.slice(1).trim() };
  if (text.startsWith("$") || text.startsWith("￥")) return { mode: "execute", prompt: text.slice(1).trim() };
  return null;
}

function isReadOnlyMode(mode: TurnMode): boolean {
  return mode === "discuss" || mode === "plan" || mode === "revise";
}

function isWorkflowContextMessage(message: any): boolean {
  return (message?.role === "custom" || message?.type === "custom_message") && message.customType === WORKFLOW_CONTEXT_TYPE;
}

function contextText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

function hasRecentDiscussion(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch() as any[];
  let latestWorkflowContextIndex = -1;
  let latestWorkflowContextText = "";

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    const message = entry?.type === "custom_message" ? entry : entry?.type === "message" ? entry.message : undefined;
    if (!isWorkflowContextMessage(message)) continue;

    latestWorkflowContextIndex = i;
    latestWorkflowContextText = contextText(message);
    break;
  }

  if (latestWorkflowContextIndex < 0 || !latestWorkflowContextText.includes("[HUMAN-LED CODING WORKFLOW: DISCUSS]")) {
    return false;
  }

  return branch.slice(latestWorkflowContextIndex + 1).some((entry: any) =>
    entry?.type === "message" && isAssistantMessage(entry.message)
  );
}

export default function humanLedCodingWorkflowExtension(pi: ExtensionAPI): void {
  // input — detect ? / ?? / ?! / $ prefixes. Normal input stays untouched.
  pi.on("input", async (event, ctx) => {
    const parsed = parseWorkflowInput(event.text);
    if (!parsed) {
      if (typeof ctx.isIdle !== "function" || ctx.isIdle()) {
        turnMode = null;
      }
      updateStatus(ctx);
      return { action: "continue" };
    }

    if (parsed.mode !== "execute" && !parsed.prompt) {
      if (parsed.mode !== "plan" || !hasRecentDiscussion(ctx)) {
        turnMode = null;
        updateStatus(ctx);
        return missingArgument(ctx, parsed.mode === "revise" ? "?!" : parsed.mode === "plan" ? "??" : "?");
      }
    }

    if (parsed.mode === "plan") {
      activePlan = false;
      planFullText = "";
      todoItems = [];
      executed = false;
      persistState(pi);
    }

    planFromPreviousDiscussion = parsed.mode === "plan" && parsed.prompt.length === 0;

    if (parsed.mode === "revise" && !activePlan && (!canRecoverInactivePlan(ctx) || !recoverPlanFromSession(ctx))) {
      notify(ctx, "No active plan to revise. Use ?? to create a plan first.", "info");
      turnMode = null;
      updateStatus(ctx);
      return { action: "handled" };
    }

    if (parsed.mode === "execute") {
      if (!activePlan && (!canRecoverInactivePlan(ctx) || !recoverPlanFromSession(ctx))) {
        notify(ctx, "No active plan to execute. Use ?? to create a plan first.", "info");
        turnMode = null;
        updateStatus(ctx);
        return { action: "handled" };
      }
      hasExecutionAdjustment = parsed.prompt.length > 0;
    }

    turnMode = parsed.mode;
    updateStatus(ctx);
    return { action: "transform", text: parsed.prompt };
  });

  // before_agent_start — inject mode context without changing the system prompt.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (turnMode === "discuss") {
      return {
        message: {
          customType: WORKFLOW_CONTEXT_TYPE,
          content: buildDiscussPrompt(),
          display: false,
        },
      };
    }

    if (turnMode === "plan") {
      return {
        message: {
          customType: WORKFLOW_CONTEXT_TYPE,
          content: buildPlanPrompt({ fromPreviousDiscussion: planFromPreviousDiscussion }),
          display: false,
        },
      };
    }

    if (turnMode === "revise") {
      return {
        message: {
          customType: WORKFLOW_CONTEXT_TYPE,
          content: buildRevisePrompt(restoredPlanContext(ctx)),
          display: false,
        },
      };
    }

    if (turnMode === "execute") {
      const adjustment = hasExecutionAdjustment
        ? "\n\nThe user's current message contains additional execution constraints; apply them while staying aligned with the active plan."
        : "";
      return {
        message: {
          customType: WORKFLOW_CONTEXT_TYPE,
          content: `${buildExecutePrompt(todoItems, restoredPlanContext(ctx))}${adjustment}`,
          display: false,
        },
      };
    }
  });

  // context — keep only the current workflow instruction in provider context.
  // Persisted workflow context messages stay in the session for auditability, but
  // stale mode instructions are removed from LLM context to protect prefix cache.
  pi.on("context", async (event) => {
    let keepIndex = -1;

    if (turnMode !== null) {
      for (let i = event.messages.length - 1; i >= 0; i--) {
        if (isWorkflowContextMessage(event.messages[i])) {
          keepIndex = i;
          break;
        }
      }
    }

    let changed = false;
    const messages = event.messages.filter((message, index) => {
      if (!isWorkflowContextMessage(message)) return true;
      const keep = index === keepIndex;
      if (!keep) changed = true;
      return keep;
    });

    if (changed) return { messages };
  });

  // tool_call — read-only gates for discuss/plan/revise. Active tool schemas remain stable.
  pi.on("tool_call", async (event) => {
    if (!isReadOnlyMode(turnMode)) return;

    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        block: true,
        reason: `Human-led workflow: ${event.toolName} is disabled in ${turnMode} mode. Use $ to execute an approved plan.`,
      };
    }

    if (!READ_ONLY_ALLOWED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Human-led workflow: ${event.toolName} is not allowed in ${turnMode} mode. Allowed tools: read, grep, find, ls, bash(read-only), webfetch.`,
      };
    }

    if (event.toolName === "bash") {
      const command = String((event.input as any).command ?? "");
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Human-led workflow: command blocked in ${turnMode} mode. Only allowlisted read-only commands are permitted.\nBlocked command: ${command}`,
        };
      }
    }
  });

  // turn_end — track [DONE:n] progress during execution.
  pi.on("turn_end", async (event, ctx) => {
    if (turnMode !== "execute" || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (markCompletedSteps(text, todoItems) > 0) {
      updateStatus(ctx);
      persistState(pi);
    }
  });

  // agent_end — capture plans and clear transient mode state.
  pi.on("agent_end", async (event, ctx) => {
    if (turnMode === "plan" || turnMode === "revise") {
      const latestPlan = findLatestPlanInMessages(event.messages);
      if (latestPlan && hasExecuteMarker(latestPlan)) {
        activePlan = true;
        planFullText = latestPlan;
        todoItems = extractPlanItems(latestPlan);
        executed = false;
      } else if (turnMode === "plan") {
        activePlan = false;
        planFullText = "";
        todoItems = [];
        executed = false;
      }
      persistState(pi);
    }

    if (turnMode === "execute") {
      executed = true;
      const allExtractedStepsCompleted = todoItems.length === 0 || todoItems.every((item) => item.completed);
      if (allExtractedStepsCompleted) {
        activePlan = false;
        planFullText = "";
        todoItems = [];
      } else {
        activePlan = true;
      }
      persistState(pi);
    }

    turnMode = null;
    hasExecutionAdjustment = false;
    planFromPreviousDiscussion = false;
    updateStatus(ctx);
  });

  // session_start — restore state and install editor.
  pi.on("session_start", async (_event, ctx) => {
    resetState();

    restoreState(latestWorkflowState(ctx));

    if (activePlan && !planFullText) {
      recoverPlanFromSession(ctx);
    }

    updateStatus(ctx);

    ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
      return new HumanLedWorkflowEditor(tui, theme, keybindings);
    });
  });

  pi.on("session_shutdown", async () => {
    turnMode = null;
    hasExecutionAdjustment = false;
    planFromPreviousDiscussion = false;
  });
}
