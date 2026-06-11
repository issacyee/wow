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
 *
 * UI rule:
 * - This logic extension owns workflow behavior/state only. TUI presentation is
 *   handled by the separate wow-tui visual shell.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  buildDiscussPrompt,
  buildExecutePrompt,
  buildPlanPrompt,
  buildRevisePrompt,
  WORKFLOW_CONTEXT_TYPE,
  type WorkflowMode,
} from "./prompts.ts";
import {
  extractDoneSteps,
  extractPlanItems,
  extractPlanText,
  hasExecuteMarker,
  hasPlanStructure,
  isCompletePlan,
  markCompletedSteps,
} from "./plan.ts";
import {
  clearCompletedExecutionDisplay,
  clearPlan,
  clearTurnMode,
  continueExecution,
  currentWorkflowState,
  finishExecution,
  getPlanFullText,
  getTodoItems,
  getTurnMode,
  hasActivePlan,
  mutateTodoItems,
  replacePlan,
  resetWorkflowState,
  restoreWorkflowState,
  setExecutionActive,
  setTurnMode,
  WORKFLOW_STATE_TYPE,
  type TurnMode,
  type WorkflowState,
} from "./state.ts";
import { isSafeCommand } from "../wow/safe.ts";

const MAX_RESTORED_PLAN_CHARS = 12_000;
const READ_ONLY_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "webfetch"]);

let hasExecutionAdjustment = false;
let planFromPreviousDiscussion = false;
let executionProgressDirty = false;

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry(WORKFLOW_STATE_TYPE, currentWorkflowState());
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

function markCompletedTodosFromText(text: string): number {
  if (!text.trim()) return 0;

  const doneSteps = extractDoneSteps(text);
  if (doneSteps.length === 0) return 0;

  const todoItems = getTodoItems();
  const hasNewCompletion = doneSteps.some((step) =>
    todoItems.some((item) => item.step === step && !item.completed)
  );
  if (!hasNewCompletion) return 0;

  let changed = 0;
  mutateTodoItems((items) => {
    changed = markCompletedSteps(text, items);
  });
  return changed;
}

function markCompletedTodosFromMessages(messages: AgentMessage[]): number {
  const text = messages
    .filter(isAssistantMessage)
    .map(getTextContent)
    .join("\n");
  return markCompletedTodosFromText(text);
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
  const planFullText = getPlanFullText();
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
    .filter((candidate: any) => candidate?.type === "custom" && candidate.customType === WORKFLOW_STATE_TYPE)
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

    const planText = extractPlanText(text);
    replacePlan(planText, extractPlanItems(planText), false);
    return true;
  }

  return false;
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

  const isDiscussContext =
    latestWorkflowContextText.includes("[HLCW:DISCUSS]") ||
    latestWorkflowContextText.includes("[HUMAN-LED CODING WORKFLOW: DISCUSS]");

  if (latestWorkflowContextIndex < 0 || !isDiscussContext) {
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
        if (clearCompletedExecutionDisplay()) persistState(pi);
        clearTurnMode();
      }
      return { action: "continue" };
    }

    if (parsed.mode !== "execute" && !parsed.prompt) {
      if (parsed.mode !== "plan" || !hasRecentDiscussion(ctx)) {
        clearTurnMode();
        return missingArgument(ctx, parsed.mode === "revise" ? "?!" : parsed.mode === "plan" ? "??" : "?");
      }
    }

    if (parsed.mode === "plan") {
      clearPlan(false);
      persistState(pi);
    } else if (clearCompletedExecutionDisplay()) {
      persistState(pi);
    }

    planFromPreviousDiscussion = parsed.mode === "plan" && parsed.prompt.length === 0;

    if (parsed.mode === "revise" && !hasActivePlan() && (!canRecoverInactivePlan(ctx) || !recoverPlanFromSession(ctx))) {
      notify(ctx, "No active plan to revise. Use ?? to create a plan first.", "info");
      clearTurnMode();
      return { action: "handled" };
    }

    if (parsed.mode === "execute") {
      if (!hasActivePlan() && (!canRecoverInactivePlan(ctx) || !recoverPlanFromSession(ctx))) {
        notify(ctx, "No active plan to execute. Use ?? to create a plan first.", "info");
        clearTurnMode();
        return { action: "handled" };
      }
      setExecutionActive(true);
      persistState(pi);
      hasExecutionAdjustment = parsed.prompt.length > 0;
    }

    executionProgressDirty = false;
    setTurnMode(parsed.mode);
    return { action: "transform", text: parsed.prompt };
  });

  // before_agent_start — inject mode context without changing the system prompt.
  pi.on("before_agent_start", async (_event, ctx) => {
    const turnMode = getTurnMode();

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
          content: `${buildExecutePrompt(getTodoItems(), restoredPlanContext(ctx))}${adjustment}`,
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

    if (getTurnMode() !== null) {
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
    const turnMode = getTurnMode();
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

  // message_update — update todo progress as soon as visible [DONE:n] text streams in.
  pi.on("message_update", async (event) => {
    if (getTurnMode() !== "execute" || !isAssistantMessage(event.message)) return;

    const changed = markCompletedTodosFromText(getTextContent(event.message));
    if (changed > 0) {
      executionProgressDirty = true;
    }
  });

  // turn_end — track [DONE:n] progress during execution and persist streaming updates.
  pi.on("turn_end", async (event) => {
    if (getTurnMode() !== "execute" || !isAssistantMessage(event.message)) return;

    const changed = markCompletedTodosFromText(getTextContent(event.message));
    if (changed > 0 || executionProgressDirty) {
      persistState(pi);
      executionProgressDirty = false;
    }
  });

  // agent_end — capture plans and clear transient mode state.
  pi.on("agent_end", async (event) => {
    const turnMode = getTurnMode();

    if (turnMode === "plan" || turnMode === "revise") {
      const latestPlan = findLatestPlanInMessages(event.messages);
      if (latestPlan && hasExecuteMarker(latestPlan)) {
        replacePlan(latestPlan, extractPlanItems(latestPlan), false);
      } else if (turnMode === "plan") {
        clearPlan(false);
      }
      persistState(pi);
    }

    if (turnMode === "execute") {
      markCompletedTodosFromMessages(event.messages);
      const todoItems = getTodoItems();
      const allExtractedStepsCompleted = todoItems.length === 0 || todoItems.every((item) => item.completed);
      if (allExtractedStepsCompleted) {
        finishExecution();
      } else {
        continueExecution();
      }
      persistState(pi);
      executionProgressDirty = false;
    }

    clearTurnMode();
    hasExecutionAdjustment = false;
    planFromPreviousDiscussion = false;
  });

  // session_start — restore workflow state only. Visuals are owned by wow-tui.
  pi.on("session_start", async (_event, ctx) => {
    resetWorkflowState();
    restoreWorkflowState(latestWorkflowState(ctx));

    if (hasActivePlan() && !getPlanFullText()) {
      recoverPlanFromSession(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    clearTurnMode();
    hasExecutionAdjustment = false;
    planFromPreviousDiscussion = false;
    executionProgressDirty = false;
  });
}
