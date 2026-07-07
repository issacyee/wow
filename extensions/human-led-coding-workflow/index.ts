/**
 * Human-Led Coding Workflow — ? / ?? / ?! / ?$ / $ workflow extension.
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
  buildAutoExecutePrompt,
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
  type TodoItem,
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
  setPlanFullText,
  setTurnMode,
  WORKFLOW_STATE_TYPE,
  type TurnMode,
  type WorkflowState,
} from "./state.ts";
import {
  collectAskBlocks,
  fingerprintAskBlocks,
  formatAskAnswers,
  getAskPanelTrigger,
  hasAskMetadata,
  type AskBlock,
} from "./ask.ts";
import { isSafeCommand } from "../wow/safe.ts";
import { registerHumanLedWorkflowTips } from "./tips.ts";
import {
  WORKFLOW_EXECUTION_SUMMARY_TYPE,
  type WorkflowExecutionSummaryDetails,
} from "./types.ts";

const MAX_RESTORED_PLAN_CHARS = 12_000;
const READ_ONLY_ALLOWED_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "webfetch",
  "codegraph_explore",
  "codegraph_node",
  "codegraph_search",
  "codegraph_callers",
  "codegraph_status",
]);

type ExecutionMode = Extract<WorkflowMode, "execute" | "autoExecute">;

let hasExecutionAdjustment = false;
let planFromPreviousDiscussion = false;
let executionProgressDirty = false;
let compactionRecoveryMode: ExecutionMode | null = null;
let lastExecutionModeBeforeCompaction: ExecutionMode | null = null;

/** Most recent assistant ask blocks, for Alt+K reopen. */
let lastAskBlocks: AskBlock[] = [];
const queuedAskFingerprints = new Set<string>();

function findLastAskBlocksInBranch(ctx: ExtensionContext): AskBlock[] {
  let branch: any[];
  try {
    branch = ctx.sessionManager.getBranch() as any[];
  } catch {
    return [];
  }

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "message" || !isAssistantMessage(entry.message)) continue;

    const blocks = collectAskBlocks(getTextContent(entry.message));
    if (blocks.length > 0) {
      lastAskBlocks = blocks;
      return blocks;
    }
  }

  return [];
}

/** Return the most recent assistant ask blocks (for the Alt+K reopen trigger). */
export function getLastAskBlocks(ctx?: ExtensionContext): AskBlock[] {
  if (ctx) {
    const branchBlocks = findLastAskBlocksInBranch(ctx);
    if (branchBlocks.length > 0) return branchBlocks;
  }
  return lastAskBlocks;
}

function cloneTodoItems(items: TodoItem[]): TodoItem[] {
  return items.map((item) => ({ ...item }));
}

function queueExecutionSummaryMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  todoItems: TodoItem[],
  attempt = 0,
): void {
  if (todoItems.length === 0) return;

  setTimeout(() => {
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      if (attempt < 40) queueExecutionSummaryMessage(pi, ctx, todoItems, attempt + 1);
      return;
    }

    const details: WorkflowExecutionSummaryDetails = {
      version: 1,
      todoItems: cloneTodoItems(todoItems),
    };

    try {
      pi.sendMessage({
        customType: WORKFLOW_EXECUTION_SUMMARY_TYPE,
        content: "Execution completed",
        display: true,
        details,
      }, { triggerTurn: false });
    } catch {
      // The session may have been reloaded or shut down before the idle callback.
    }
  }, attempt === 0 ? 0 : 50);
}

/**
 * After a discuss turn, if the assistant emitted valid ask metadata, open the
 * ask panel (once the agent is idle) and fill the chosen answers into the editor
 * so the human can append notes and send. Cancelled panels leave the editor as-is.
 */
function queueDiscussAskPanel(ctx: ExtensionContext, blocks: AskBlock[], attempt = 0, fingerprint = fingerprintAskBlocks(blocks)): void {
  if (blocks.length === 0) return;

  if (attempt === 0) {
    if (queuedAskFingerprints.has(fingerprint)) return;
    queuedAskFingerprints.add(fingerprint);
  }

  setTimeout(() => {
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      if (attempt < 40) {
        queueDiscussAskPanel(ctx, blocks, attempt + 1, fingerprint);
      } else {
        queuedAskFingerprints.delete(fingerprint);
      }
      return;
    }

    const trigger = getAskPanelTrigger();
    if (!trigger) {
      queuedAskFingerprints.delete(fingerprint);
      return; // visual layer not loaded / no UI
    }

    trigger(ctx, blocks)
      .then((answers) => {
        if (!answers) return; // user cancelled — leave editor untouched
        try {
          ctx.ui.setEditorText(`? ${formatAskAnswers(blocks, answers)}`);
        } catch {
          // UI may have been torn down; non-fatal.
        }
      })
      .catch(() => {
        // Panel errors must never break the session.
      })
      .finally(() => {
        queuedAskFingerprints.delete(fingerprint);
      });
  }, attempt === 0 ? 0 : 50);
}

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

function getLatestAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isAssistantMessage(message)) return getTextContent(message);
  }
  return "";
}

function looksLikeCompletedExecutionSummary(text: string): boolean {
  if (!/(^|\n)\s*#{1,3}\s*(Execution Summary|执行总结|执行摘要|执行结果|实施总结|完成总结)\s*($|\n)/iu.test(text)) {
    return false;
  }

  return !/\b(blocked|failed|failure|partial|partially|incomplete|unable to complete|could not complete|cannot complete|not completed|not complete|stopped|aborted|deferred|skipped)\b|阻塞|失败|未完成|没有完成|无法完成|不能完成|部分完成|只完成|跳过|停止|中止|待处理|剩余(?:步骤|任务|工作)?/iu.test(text);
}

function truncatePlanForRestore(text: string): string | undefined {
  if (!text) return undefined;
  if (text.length <= MAX_RESTORED_PLAN_CHARS) return text;
  return `${text.slice(0, MAX_RESTORED_PLAN_CHARS)}\n\n[Plan context truncated for prefix-cache safety.]`;
}

function planVisibleInCurrentBranch(ctx: ExtensionContext): boolean {
  const branch = getBranchEntries(ctx);
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

function getBranchEntries(ctx: ExtensionContext): any[] {
  try {
    return ctx.sessionManager.getBranch() as any[];
  } catch {
    return [];
  }
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

function findLatestPlanInEntries(entries: any[]): { index: number; planText: string } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    let text = "";

    if (entry?.type === "message" && isAssistantMessage(entry.message)) {
      text = getTextContent(entry.message);
    } else if (typeof entry?.summary === "string") {
      text = entry.summary;
    } else if (entry?.type === "custom_message") {
      text = contextText(entry);
    }

    if (!text || (!hasExecuteMarker(text) && !hasPlanStructure(text))) continue;

    const planText = extractPlanText(text);
    if (hasExecuteMarker(planText) || hasPlanStructure(planText)) return { index: i, planText };
  }
  return undefined;
}

function captureAutoPlanFromText(pi: ExtensionAPI, text: string): boolean {
  if (hasActivePlan() || !hasExecuteMarker(text) || !hasPlanStructure(text)) return false;

  const planText = extractPlanText(text);
  if (!hasExecuteMarker(planText) || !hasPlanStructure(planText)) return false;

  replacePlan(planText, extractPlanItems(planText), false);
  setExecutionActive(true);
  persistState(pi);
  return true;
}

function captureAutoPlanFromMessages(pi: ExtensionAPI, messages: AgentMessage[]): boolean {
  if (hasActivePlan()) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isAssistantMessage(message) && captureAutoPlanFromText(pi, getTextContent(message))) return true;
  }
  return false;
}

function captureAutoPlanFromSession(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  if (hasActivePlan()) return false;

  const branch = getBranchEntries(ctx);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "message" && isAssistantMessage(entry.message) && captureAutoPlanFromText(pi, getTextContent(entry.message))) {
      return true;
    }
  }
  return false;
}

function latestWorkflowStateEntry(ctx: ExtensionContext): { index: number; data?: Partial<WorkflowState> } | undefined {
  const branch = getBranchEntries(ctx);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry.customType === WORKFLOW_STATE_TYPE) {
      return { index: i, data: entry.data as Partial<WorkflowState> | undefined };
    }
  }
  return undefined;
}

function latestWorkflowState(ctx: ExtensionContext): Partial<WorkflowState> | undefined {
  return latestWorkflowStateEntry(ctx)?.data;
}

function canRecoverInactivePlan(ctx: ExtensionContext): boolean {
  const state = latestWorkflowState(ctx);
  return state === undefined || state.activePlan === true;
}

function restoreLatestWorkflowStateIfMissing(ctx: ExtensionContext): boolean {
  const data = latestWorkflowState(ctx);
  if (!data) return false;

  const current = currentWorkflowState();
  const restoredItems = Array.isArray(data.todoItems) ? data.todoItems : [];
  const hasRestorableExecution = data.activePlan === true || data.executionActive === true;
  const shouldRestore =
    (!current.activePlan && data.activePlan === true) ||
    (!current.executionActive && data.executionActive === true) ||
    (current.todoItems.length === 0 && restoredItems.length > 0 && hasRestorableExecution) ||
    (!current.planFullText && typeof data.planFullText === "string" && data.planFullText.length > 0 && hasRestorableExecution);

  if (!shouldRestore) return false;
  restoreWorkflowState(data);
  return true;
}

function recoverPlanFromSession(ctx: ExtensionContext, preserveTodos = false): boolean {
  const found = findLatestPlanInEntries(getBranchEntries(ctx));
  if (!found) return false;

  if (preserveTodos && hasActivePlan() && getTodoItems().length > 0) {
    setPlanFullText(found.planText);
  } else {
    replacePlan(found.planText, extractPlanItems(found.planText), false);
  }
  return true;
}

function markCompletedTodosFromSession(ctx: ExtensionContext): number {
  const entries = getBranchEntries(ctx);
  const latestPlan = findLatestPlanInEntries(entries);
  const latestState = latestWorkflowStateEntry(ctx);
  const scanStart = Math.max(latestPlan?.index ?? 0, latestState?.index ?? 0);
  const messages = entries
    .slice(scanStart)
    .filter((entry: any) => entry?.type === "message")
    .map((entry: any) => entry.message as AgentMessage);

  return markCompletedTodosFromMessages(messages);
}

function recoverExecutionState(pi: ExtensionAPI, ctx: ExtensionContext, mode: ExecutionMode): boolean {
  let changed = restoreLatestWorkflowStateIfMissing(ctx);

  if (mode === "autoExecute") {
    changed = captureAutoPlanFromSession(pi, ctx) || changed;
  }

  if (!hasActivePlan() && getTodoItems().length === 0) {
    changed = recoverPlanFromSession(ctx) || changed;
  } else if (hasActivePlan() && !getPlanFullText()) {
    changed = recoverPlanFromSession(ctx, true) || changed;
  }

  if (hasActivePlan() && !currentWorkflowState().executionActive) {
    setExecutionActive(true);
    changed = true;
  }

  const completed = markCompletedTodosFromSession(ctx);
  return changed || completed > 0;
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
  if (text.startsWith("?$") || text.startsWith("?￥") || text.startsWith("？$") || text.startsWith("？￥")) {
    return { mode: "autoExecute", prompt: text.slice(2).trim() };
  }
  if (text.startsWith("?") || text.startsWith("？")) return { mode: "discuss", prompt: text.slice(1).trim() };
  if (text.startsWith("$") || text.startsWith("￥")) return { mode: "execute", prompt: text.slice(1).trim() };
  return null;
}

function isReadOnlyMode(mode: TurnMode): boolean {
  return mode === "discuss" || mode === "plan" || mode === "revise";
}

function isExecutionMode(mode: TurnMode): mode is ExecutionMode {
  return mode === "execute" || mode === "autoExecute";
}

function toExecutionMode(mode: TurnMode): ExecutionMode | null {
  return isExecutionMode(mode) ? mode : null;
}

function progressExecutionMode(): ExecutionMode | null {
  const turnMode = toExecutionMode(getTurnMode());
  if (turnMode) return turnMode;
  if (compactionRecoveryMode === "autoExecute") return "autoExecute";
  return compactionRecoveryMode && hasRecoverableExecutionState() ? compactionRecoveryMode : null;
}

function hasRecoverableExecutionState(): boolean {
  const state = currentWorkflowState();
  return state.executionActive || state.activePlan;
}

function isRecoveryMode(mode: ExecutionMode): boolean {
  return compactionRecoveryMode === mode && !isExecutionMode(getTurnMode());
}

function clearExecutionRecovery(): void {
  compactionRecoveryMode = null;
  lastExecutionModeBeforeCompaction = null;
}

function isWorkflowContextMessage(message: any): boolean {
  return (message?.role === "custom" || message?.type === "custom_message") && message.customType === WORKFLOW_CONTEXT_TYPE;
}

function isWorkflowExecutionSummaryMessage(message: any): boolean {
  return (message?.role === "custom" || message?.type === "custom_message") &&
    message.customType === WORKFLOW_EXECUTION_SUMMARY_TYPE;
}

function filterExecutionSummaryMessages<T>(messages: T[]): T[] {
  return messages.filter((message) => !isWorkflowExecutionSummaryMessage(message));
}

function isWorkflowExecutionSummaryEntry(entry: any): boolean {
  return entry?.type === "custom_message" && entry.customType === WORKFLOW_EXECUTION_SUMMARY_TYPE;
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
  const unregisterTips = registerHumanLedWorkflowTips();

  // input — detect ? / ?? / ?! / ?$ / $ prefixes. Normal input stays untouched.
  pi.on("input", async (event, ctx) => {
    const parsed = parseWorkflowInput(event.text);
    if (!parsed) {
      if (typeof ctx.isIdle !== "function" || ctx.isIdle()) {
        if (clearCompletedExecutionDisplay()) persistState(pi);
        clearTurnMode();
        clearExecutionRecovery();
      }
      return { action: "continue" };
    }

    if (parsed.mode !== "execute" && !parsed.prompt) {
      const canUseRecentDiscussion = (parsed.mode === "plan" || parsed.mode === "autoExecute") && hasRecentDiscussion(ctx);
      if (!canUseRecentDiscussion) {
        clearTurnMode();
        return missingArgument(ctx, parsed.mode === "revise" ? "?!" : parsed.mode === "plan" ? "??" : parsed.mode === "autoExecute" ? "?$" : "?");
      }
    }

    if (parsed.mode === "plan" || parsed.mode === "autoExecute") {
      clearPlan(false);
      persistState(pi);
    } else if (clearCompletedExecutionDisplay()) {
      persistState(pi);
    }

    planFromPreviousDiscussion = (parsed.mode === "plan" || parsed.mode === "autoExecute") && parsed.prompt.length === 0;
    if (isExecutionMode(parsed.mode)) {
      lastExecutionModeBeforeCompaction = parsed.mode;
    } else {
      clearExecutionRecovery();
    }

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

    if (turnMode === "autoExecute") {
      return {
        message: {
          customType: WORKFLOW_CONTEXT_TYPE,
          content: buildAutoExecutePrompt({ fromPreviousDiscussion: planFromPreviousDiscussion }),
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
      if (isWorkflowExecutionSummaryMessage(message)) {
        changed = true;
        return false;
      }

      if (!isWorkflowContextMessage(message)) return true;
      const keep = index === keepIndex;
      if (!keep) changed = true;
      return keep;
    });

    if (changed) return { messages };
  });

  pi.on("session_before_compact", async (event) => {
    const turnExecutionMode = toExecutionMode(getTurnMode());
    lastExecutionModeBeforeCompaction = turnExecutionMode ?? compactionRecoveryMode ?? lastExecutionModeBeforeCompaction;
    if (lastExecutionModeBeforeCompaction && (hasRecoverableExecutionState() || lastExecutionModeBeforeCompaction === "autoExecute")) {
      if (hasRecoverableExecutionState()) {
        continueExecution();
        persistState(pi);
      }
    } else {
      lastExecutionModeBeforeCompaction = null;
    }

    event.preparation.messagesToSummarize = filterExecutionSummaryMessages(event.preparation.messagesToSummarize);
    event.preparation.turnPrefixMessages = filterExecutionSummaryMessages(event.preparation.turnPrefixMessages);
  });

  pi.on("session_compact", async (event, ctx) => {
    if (!lastExecutionModeBeforeCompaction || (!event.willRetry && event.reason !== "threshold")) {
      lastExecutionModeBeforeCompaction = null;
      return;
    }

    compactionRecoveryMode = lastExecutionModeBeforeCompaction;
    lastExecutionModeBeforeCompaction = null;

    if (recoverExecutionState(pi, ctx, compactionRecoveryMode)) {
      persistState(pi);
    }
  });

  pi.on("session_before_tree", async (event) => {
    event.preparation.entriesToSummarize = event.preparation.entriesToSummarize
      .filter((entry) => !isWorkflowExecutionSummaryEntry(entry));
  });

  // tool_call — read-only gates for discuss/plan/revise. Active tool schemas remain stable.
  pi.on("tool_call", async (event, ctx) => {
    const turnMode = getTurnMode();
    if (turnMode === "autoExecute") captureAutoPlanFromSession(pi, ctx);
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
        reason: `Human-led workflow: ${event.toolName} is not allowed in ${turnMode} mode. Allowed tools: read, grep, find, ls, bash(read-only), webfetch, codegraph_*.`,
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
  pi.on("message_update", async (event, ctx) => {
    const executionMode = progressExecutionMode();
    if (!executionMode || !isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (executionMode === "autoExecute") captureAutoPlanFromText(pi, text);
    const recovered = isRecoveryMode(executionMode) && recoverExecutionState(pi, ctx, executionMode);

    const changed = markCompletedTodosFromText(text);
    if (changed > 0 || recovered) {
      executionProgressDirty = true;
    }
  });

  // turn_end — track [DONE:n] progress during execution and persist streaming updates.
  pi.on("turn_end", async (event, ctx) => {
    const executionMode = progressExecutionMode();
    if (!executionMode || !isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (executionMode === "autoExecute") captureAutoPlanFromText(pi, text);
    const recovered = isRecoveryMode(executionMode) && recoverExecutionState(pi, ctx, executionMode);

    const changed = markCompletedTodosFromText(text);
    if (changed > 0 || recovered || executionProgressDirty) {
      persistState(pi);
      executionProgressDirty = false;
    }
  });

  // agent_end — capture plans and clear transient mode state.
  pi.on("agent_end", async (event, ctx) => {
    const turnMode = getTurnMode();
    const executionMode = progressExecutionMode();

    if (turnMode === "discuss") {
      const latestText = getLatestAssistantText(event.messages);
      const askBlocks = collectAskBlocks(latestText);
      lastAskBlocks = askBlocks; // cache for Alt+K reopen, even if panel was cancelled
      if (askBlocks.length > 0) {
        queueDiscussAskPanel(ctx, askBlocks);
      } else if (hasAskMetadata(latestText)) {
        notify(ctx, "Ask metadata invalid", "warning");
      }
    }

    if (turnMode === "plan" || turnMode === "revise") {
      const latestPlan = findLatestPlanInMessages(event.messages);
      if (latestPlan && hasExecuteMarker(latestPlan)) {
        replacePlan(latestPlan, extractPlanItems(latestPlan), false);
      } else if (turnMode === "plan") {
        clearPlan(false);
      }
      persistState(pi);
    }

    if (executionMode) {
      lastExecutionModeBeforeCompaction = executionMode;
      if (executionMode === "autoExecute") captureAutoPlanFromMessages(pi, event.messages);
      if (isRecoveryMode(executionMode)) recoverExecutionState(pi, ctx, executionMode);
      markCompletedTodosFromMessages(event.messages);
      const todoItems = getTodoItems();
      const hasExecutionPlan = hasActivePlan() || todoItems.length > 0;
      const allExtractedStepsCompleted = todoItems.length === 0 || todoItems.every((item) => item.completed);
      if (hasExecutionPlan && (allExtractedStepsCompleted || looksLikeCompletedExecutionSummary(getLatestAssistantText(event.messages)))) {
        finishExecution();
        clearExecutionRecovery();
        queueExecutionSummaryMessage(pi, ctx, getTodoItems());
      } else if (hasExecutionPlan) {
        continueExecution();
      } else {
        clearExecutionRecovery();
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
      recoverPlanFromSession(ctx, true);
    }
  });

  pi.on("session_shutdown", async () => {
    clearTurnMode();
    clearExecutionRecovery();
    hasExecutionAdjustment = false;
    planFromPreviousDiscussion = false;
    executionProgressDirty = false;
    queuedAskFingerprints.clear();
    unregisterTips();
  });
}
