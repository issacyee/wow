/**
 * Wow TUI working/thinking timers.
 *
 * Owns the visual streaming timers for the built-in Working loader and hidden
 * Thinking labels. The logic is intentionally UI-only: it observes agent and
 * assistant streaming lifecycle events, then updates TUI labels.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
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

interface ActiveThinkingState {
  contentIndex: number;
  startedAt: number;
  label?: string;
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
  let frameIndex = 0;
  let generation = 0;
  const entryIdsByMessage = new WeakMap<AssistantMessage, string>();
  const pendingDurations: PendingDuration[] = [];

  function getFrame(): string {
    return SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? "";
  }

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

    if (activeThinking?.label) {
      setThinkingLabel(message, activeThinking.contentIndex, activeThinking.label);
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

  function updateActiveThinking(timestamp = nowMs()): void {
    if (!activeThinking || !latestAssistantMessage) return;

    const label = `${getFrame()} Thinking ${formatDuration(timestamp - activeThinking.startedAt)}`;
    const labelChanged = label !== activeThinking.label;
    activeThinking.label = label;
    setThinkingLabel(latestAssistantMessage, activeThinking.contentIndex, label);

    if (labelChanged) {
      refreshLatestAssistantMessage();
    }
  }

  function refresh(): void {
    if (!ctx?.hasUI) return;

    const timestamp = nowMs();

    if (workingStartedAt !== undefined) {
      ctx.ui.setWorkingMessage(`Working ${formatDuration(timestamp - workingStartedAt)}`);
    }

    if (activeThinking) {
      updateActiveThinking(timestamp);
    }

    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
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
    frameIndex = 0;
    startRefreshLoop();
    updateActiveThinking(timestamp);
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
    frameIndex = 0;
  }

  pi.on("agent_start", async () => {
    if (!ctx?.hasUI) return;

    generation++;
    workingStartedAt = nowMs();
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
