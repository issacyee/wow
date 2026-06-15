/**
 * Wow TUI working/thinking timers.
 *
 * Owns the visual streaming timers for the built-in Working loader and hidden
 * Thinking labels. The logic is intentionally UI-only: it observes agent and
 * assistant streaming lifecycle events, then updates TUI labels.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { getWowTips, type WowTip } from "../wow/tips.ts";
import { WOW_TUI_CONFIG } from "./config.ts";
import { openThinkingMetadataStore, type ThinkingMetadataStore } from "./thinking-metadata.ts";
import {
  installThinkingRendererPatch,
  refreshThinkingMessage,
  setThinkingLabel,
  setThinkingLabelColor,
} from "./thinking-renderer.ts";
import { formatDuration, SPINNER_FRAMES, TIMER_INTERVAL_MS } from "./timer.ts";

export { formatDuration } from "./timer.ts";

const WORKING_INDICATOR: WorkingIndicatorOptions = {
  frames: SPINNER_FRAMES,
  intervalMs: TIMER_INTERVAL_MS,
};

const TIP_INITIAL_DELAY_MS = 0;
const TIP_ROTATE_INTERVAL_MS = 30_000;
const DEFAULT_TIP_PRIORITY = 50;
const RECENT_TIP_HISTORY_LIMIT = 2;

interface ActiveThinkingState {
  contentIndex: number;
  startedAt: number;
}

interface CompletedThinkingDuration {
  contentIndex: number;
  durationMs: number;
  label: string;
}

interface PendingDuration {
  message: AssistantMessage;
  contentIndex: number;
  durationMs: number;
  label: string;
}

interface WorkingTipsDeck {
  activePool: WowTip[];
  usedPool: WowTip[];
  recentTipIds: string[];
  registrySignature: string;
}

interface WorkingTipsState {
  startedAt: number;
  currentTip?: WowTip;
  lastTipChangedAt: number;
}

function nowMs(): number {
  return Date.now();
}

export interface WorkingTimerController {
  startSession(ctx: ExtensionContext): void;
  shutdownSession(): void;
}

function isAssistantMessageEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> & {
  message: AssistantMessage;
} {
  return entry.type === "message" && entry.message.role === "assistant";
}

export function createWorkingTimerController(pi: ExtensionAPI): WorkingTimerController {
  installThinkingRendererPatch();

  let ctx: ExtensionContext | undefined;
  let metadataStore: ThinkingMetadataStore | undefined;
  let workingStartedAt: number | undefined;
  let latestAssistantMessage: AssistantMessage | undefined;
  let activeThinking: ActiveThinkingState | undefined;
  let completedThinkingDurations: CompletedThinkingDuration[] = [];
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let workingTipsDeck: WorkingTipsDeck | undefined;
  let workingTipsState: WorkingTipsState | undefined;
  const entryIdsByMessage = new WeakMap<AssistantMessage, string>();
  const pendingDurations: PendingDuration[] = [];

  function indexAssistantMessagesFromBranch(): void {
    if (!ctx) return;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (isAssistantMessageEntry(entry)) {
        entryIdsByMessage.set(entry.message, entry.id);
      }
    }
  }

  function applyPersistedThinkingDurations(): void {
    if (!ctx || !metadataStore) return;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (!isAssistantMessageEntry(entry)) continue;

      entryIdsByMessage.set(entry.message, entry.id);
      for (let contentIndex = 0; contentIndex < entry.message.content.length; contentIndex++) {
        const content = entry.message.content[contentIndex];
        if (content.type !== "thinking" || !content.thinking.trim()) continue;

        const record = metadataStore.get(entry.id, contentIndex);
        if (!record) continue;

        setThinkingLabel(entry.message, contentIndex, record.label ?? `Thought ${formatDuration(record.durationMs)}`);
      }
    }
  }

  function persistDuration(duration: PendingDuration): boolean {
    if (!metadataStore) return false;

    const entryId = entryIdsByMessage.get(duration.message);
    if (!entryId) return false;

    metadataStore.set({
      assistantMessageId: entryId,
      contentIndex: duration.contentIndex,
      durationMs: duration.durationMs,
      label: duration.label,
    });
    return true;
  }

  function reconcilePendingDurations(): void {
    if (!ctx || pendingDurations.length === 0) return;

    indexAssistantMessagesFromBranch();
    for (let i = pendingDurations.length - 1; i >= 0; i--) {
      if (persistDuration(pendingDurations[i])) {
        pendingDurations.splice(i, 1);
      }
    }
  }

  function queueFinalThinkingDuration(message: AssistantMessage, duration: CompletedThinkingDuration): void {
    const pending: PendingDuration = {
      message,
      contentIndex: duration.contentIndex,
      durationMs: duration.durationMs,
      label: duration.label,
    };

    if (!persistDuration(pending)) {
      pendingDurations.push(pending);
      setTimeout(reconcilePendingDurations, 0);
    }
  }

  function syncThinkingLabelsToMessage(message: AssistantMessage): void {
    for (const duration of completedThinkingDurations) {
      setThinkingLabel(message, duration.contentIndex, duration.label);
    }
  }

  function setLatestAssistantMessage(message: AssistantMessage): void {
    latestAssistantMessage = message;
    syncThinkingLabelsToMessage(message);
  }

  function refreshLatestAssistantMessage(): void {
    if (!latestAssistantMessage) return;

    refreshThinkingMessage(latestAssistantMessage);
  }

  function persistCompletedDurationsForLatestMessage(): void {
    if (!latestAssistantMessage) return;

    for (const duration of completedThinkingDurations) {
      queueFinalThinkingDuration(latestAssistantMessage, duration);
    }
  }

  function tipRegistrySignature(tips: WowTip[]): string {
    return JSON.stringify(tips.map((tip) => [tip.feature, tip.id, tip.priority ?? "", tip.short]));
  }

  function tipPriority(tip: WowTip): number {
    return Math.max(1, tip.priority ?? DEFAULT_TIP_PRIORITY);
  }

  function priorityBiasedShuffle(tips: WowTip[]): WowTip[] {
    const remaining = [...tips];
    const shuffled: WowTip[] = [];

    // Priority affects how early a tip appears in each shuffled round. It does
    // not increase long-term frequency: every tip appears once per round.
    while (remaining.length > 0) {
      const total = remaining.reduce((sum, tip) => sum + tipPriority(tip), 0);
      let roll = Math.random() * total;
      let selectedIndex = remaining.length - 1;

      for (let i = 0; i < remaining.length; i++) {
        roll -= tipPriority(remaining[i]);
        if (roll <= 0) {
          selectedIndex = i;
          break;
        }
      }

      const [selected] = remaining.splice(selectedIndex, 1);
      shuffled.push(selected);
    }

    return shuffled;
  }

  function syncWorkingTipsDeck(): void {
    if (!WOW_TUI_CONFIG.workingTips) {
      workingTipsDeck = undefined;
      return;
    }

    const tips = getWowTips();
    if (tips.length === 0) {
      workingTipsDeck = undefined;
      return;
    }

    const signature = tipRegistrySignature(tips);
    if (workingTipsDeck?.registrySignature === signature) return;

    workingTipsDeck = {
      activePool: priorityBiasedShuffle(tips),
      usedPool: [],
      recentTipIds: [],
      registrySignature: signature,
    };
  }

  function refillWorkingTipPool(deck: WorkingTipsDeck): void {
    if (deck.activePool.length > 0 || deck.usedPool.length === 0) return;

    deck.activePool = priorityBiasedShuffle(deck.usedPool);
    deck.usedPool = [];
  }

  function recentWindowSize(deck: WorkingTipsDeck): number {
    const uniqueTipCount = new Set([...deck.activePool, ...deck.usedPool].map((tip) => tip.id)).size;
    return Math.min(RECENT_TIP_HISTORY_LIMIT, Math.max(0, uniqueTipCount - 1));
  }

  function takeTipFromPool(deck: WorkingTipsDeck, poolIndex: number): WowTip | undefined {
    const [tip] = deck.activePool.splice(poolIndex, 1);
    if (!tip) return undefined;

    deck.usedPool.push(tip);
    const historySize = recentWindowSize(deck);
    deck.recentTipIds = historySize > 0
      ? [...deck.recentTipIds, tip.id].slice(-historySize)
      : [];
    return tip;
  }

  function findNextTipIndex(deck: WorkingTipsDeck): number {
    refillWorkingTipPool(deck);
    if (deck.activePool.length <= 1) return 0;

    const recentIds = new Set(deck.recentTipIds.slice(-recentWindowSize(deck)));
    const preferredIndex = deck.activePool.findIndex((tip) => !recentIds.has(tip.id));
    return preferredIndex >= 0 ? preferredIndex : 0;
  }

  function drawWorkingTip(): WowTip | undefined {
    const deck = workingTipsDeck;
    if (!deck) return undefined;

    const tipIndex = findNextTipIndex(deck);
    return takeTipFromPool(deck, tipIndex);
  }

  function clearWorkingTips(): void {
    workingTipsState = undefined;
  }

  function currentWorkingTip(timestamp: number): string | undefined {
    const state = workingTipsState;
    if (!state) return undefined;

    const elapsed = timestamp - state.startedAt;
    if (elapsed < TIP_INITIAL_DELAY_MS) return undefined;

    if (!state.currentTip || timestamp - state.lastTipChangedAt >= TIP_ROTATE_INTERVAL_MS) {
      state.currentTip = drawWorkingTip();
      state.lastTipChangedAt = timestamp;
    }

    return state.currentTip?.short;
  }

  function formatWorkingMessage(timestamp: number): string | undefined {
    if (workingStartedAt === undefined) return undefined;

    const base = `Working ${formatDuration(timestamp - workingStartedAt)}`;
    const tip = currentWorkingTip(timestamp);
    return tip ? `${base} • Tip: ${tip}` : base;
  }

  function refresh(): void {
    if (!ctx?.hasUI) return;

    const timestamp = nowMs();

    const workingMessage = formatWorkingMessage(timestamp);
    if (workingMessage !== undefined) {
      ctx.ui.setWorkingMessage(workingMessage);
    }
  }

  function startRefreshLoop(): void {
    if (intervalId !== undefined) return;

    refresh();
    intervalId = setInterval(refresh, TIMER_INTERVAL_MS);
  }

  function stopRefreshLoop(): void {
    if (intervalId === undefined) return;

    clearInterval(intervalId);
    intervalId = undefined;
  }

  function stopRefreshLoopIfIdle(): void {
    if (workingStartedAt !== undefined || activeThinking !== undefined) return;

    stopRefreshLoop();
  }

  function restoreWorkingMessageSoon(currentGeneration: number): void {
    setTimeout(() => {
      if (!ctx?.hasUI || generation !== currentGeneration || workingStartedAt !== undefined) return;

      ctx.ui.setWorkingMessage(undefined);
    }, 0);
  }

  function startThinking(message: AssistantMessage, contentIndex: number, timestamp = nowMs()): void {
    setLatestAssistantMessage(message);
    activeThinking = {
      contentIndex,
      startedAt: timestamp,
    };
    startRefreshLoop();
  }

  function finishThinking(timestamp = nowMs(), finalMessage?: AssistantMessage): void {
    if (finalMessage) {
      setLatestAssistantMessage(finalMessage);
    }
    if (!activeThinking || !latestAssistantMessage) return;

    const durationMs = timestamp - activeThinking.startedAt;
    const duration: CompletedThinkingDuration = {
      contentIndex: activeThinking.contentIndex,
      durationMs,
      label: `Thought ${formatDuration(durationMs)}`,
    };

    activeThinking = undefined;
    completedThinkingDurations = completedThinkingDurations
      .filter((candidate) => candidate.contentIndex !== duration.contentIndex)
      .concat(duration);
    setThinkingLabel(latestAssistantMessage, duration.contentIndex, duration.label);
    refreshLatestAssistantMessage();
    stopRefreshLoopIfIdle();
  }

  function resetAssistantStreamState(message?: AssistantMessage): void {
    latestAssistantMessage = message;
    activeThinking = undefined;
    completedThinkingDurations = [];
  }

  function startWorkingTips(timestamp = nowMs()): void {
    syncWorkingTipsDeck();
    workingTipsState = {
      startedAt: timestamp,
      currentTip: drawWorkingTip(),
      lastTipChangedAt: timestamp,
    };
  }

  pi.on("agent_start", async () => {
    if (!ctx?.hasUI) return;

    generation++;
    const timestamp = nowMs();
    workingStartedAt = timestamp;
    startWorkingTips(timestamp);
    resetAssistantStreamState();
    startRefreshLoop();
  });

  pi.on("message_start", async (event) => {
    if (!ctx?.hasUI || event.message.role !== "assistant") return;

    resetAssistantStreamState(event.message);
  });

  pi.on("message_update", async (event) => {
    if (!ctx?.hasUI || event.message.role !== "assistant") return;

    const assistantEvent = event.assistantMessageEvent;
    const timestamp = nowMs();
    setLatestAssistantMessage(event.message);

    if (assistantEvent.type === "thinking_start") {
      startThinking(event.message, assistantEvent.contentIndex, timestamp);
      return;
    }

    if (assistantEvent.type === "thinking_delta" && !activeThinking) {
      startThinking(event.message, assistantEvent.contentIndex, timestamp);
      return;
    }

    if (assistantEvent.type === "thinking_end") {
      finishThinking(timestamp, event.message);
    }
  });

  pi.on("message_end", async (event) => {
    if (!ctx?.hasUI || event.message.role !== "assistant") return;

    setLatestAssistantMessage(event.message);
    finishThinking(nowMs(), event.message);
    syncThinkingLabelsToMessage(event.message);
    refreshThinkingMessage(event.message);
    persistCompletedDurationsForLatestMessage();
    setTimeout(reconcilePendingDurations, 0);
  });

  pi.on("agent_end", async () => {
    if (!ctx?.hasUI) return;

    const currentGeneration = generation;
    finishThinking();
    persistCompletedDurationsForLatestMessage();
    workingStartedAt = undefined;
    clearWorkingTips();
    stopRefreshLoopIfIdle();
    restoreWorkingMessageSoon(currentGeneration);
    setTimeout(reconcilePendingDurations, 0);
  });

  return {
    startSession(sessionCtx: ExtensionContext): void {
      if (!sessionCtx.hasUI) return;

      ctx = sessionCtx;
      metadataStore = openThinkingMetadataStore(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
      workingStartedAt = undefined;
      clearWorkingTips();
      resetAssistantStreamState();
      pendingDurations.length = 0;
      stopRefreshLoop();
      setThinkingLabelColor((text) => ctx?.ui.theme.fg("thinkingText", text) ?? text);
      indexAssistantMessagesFromBranch();
      applyPersistedThinkingDurations();
      ctx.ui.setWorkingIndicator(WORKING_INDICATOR);
      ctx.ui.setWorkingMessage(undefined);
      ctx.ui.setHiddenThinkingLabel(undefined);
    },

    shutdownSession(): void {
      workingStartedAt = undefined;
      clearWorkingTips();
      resetAssistantStreamState();
      pendingDurations.length = 0;
      stopRefreshLoop();

      if (ctx?.hasUI) {
        ctx.ui.setWorkingMessage(undefined);
        ctx.ui.setWorkingIndicator(undefined);
        ctx.ui.setHiddenThinkingLabel(undefined);
      }

      ctx = undefined;
      metadataStore = undefined;
    },
  };
}
