/**
 * BTW message renderers and visual progress presenters.
 *
 * Visual presentation for BTW side-channel messages lives in wow-tui so the
 * BTW logic extension can remain UI-independent.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";
import { getBtwAskProgress, hasActiveBtwAskProgress, subscribeBtwState } from "../btw/state.ts";
import {
  BTW_DISPLAY_TYPE,
  BTW_PROGRESS_TYPE,
  BTW_PROMOTED_TYPE,
  type BtwDisplayDetails,
  type BtwProgressDetails,
  type BtwPromotedDetails,
} from "../btw/types.ts";
import { formatDuration, TIMER_INTERVAL_MS } from "./timer.ts";

const BTW_RENDER_TICK_STATUS_KEY = "__btw-progress-render-tick";

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

function renderProgressLine(details: BtwProgressDetails | undefined): string {
  const topicId = details?.topicId ?? "?";
  const progress = getBtwAskProgress(details?.progressId);

  if (!progress) {
    return `BTW #${topicId}: Asked`;
  }

  const durationMs = progress.durationMs ?? Date.now() - progress.startedAt;
  const duration = formatDuration(durationMs);

  switch (progress.phase) {
    case "asking":
      return `BTW #${progress.topicId}: Asking ${duration}`;
    case "asked":
      return `BTW #${progress.topicId}: Asked ${duration}`;
    case "cancelled":
      return `BTW #${progress.topicId}: Cancelled ${duration}`;
    case "failed":
      return `BTW #${progress.topicId}: Failed ${duration}`;
  }
}

function createBtwProgressComponent(details: BtwProgressDetails | undefined, theme: any): Component {
  return {
    invalidate() { },
    render(width: number): string[] {
      return new Text(theme.fg("thinkingText", renderProgressLine(details)), 1, 0).render(width);
    },
  };
}

export function installBtwAskTimer(ctx: ExtensionContext): () => void {
  if (!ctx.hasUI) return () => { };

  let intervalId: ReturnType<typeof setInterval> | undefined;

  const requestRender = () => {
    // Intentionally invisible. setStatus() requests a TUI render even when the
    // key is absent/undefined; the footer receives no visible BTW progress text.
    ctx.ui.setStatus(BTW_RENDER_TICK_STATUS_KEY, undefined);
  };

  const stopInterval = () => {
    if (intervalId === undefined) return;

    clearInterval(intervalId);
    intervalId = undefined;
  };

  const ensureInterval = () => {
    if (intervalId !== undefined) return;

    requestRender();
    intervalId = setInterval(requestRender, TIMER_INTERVAL_MS);
  };

  const refresh = () => {
    if (hasActiveBtwAskProgress()) {
      ensureInterval();
    } else {
      stopInterval();
    }
    requestRender();
  };

  const unsubscribe = subscribeBtwState(refresh);
  refresh();

  return () => {
    unsubscribe();
    stopInterval();
    ctx.ui.setStatus(BTW_RENDER_TICK_STATUS_KEY, undefined);
  };
}

export function registerBtwRendering(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<BtwProgressDetails>(BTW_PROGRESS_TYPE, (message, _options, theme) => {
    return createBtwProgressComponent(message.details, theme);
  });

  pi.registerMessageRenderer<BtwDisplayDetails>(BTW_DISPLAY_TYPE, (message, { expanded }, theme) => {
    const details = message.details;
    const header = theme.fg("accent", theme.bold(`BTW #${details?.topicId ?? "?"}`)) +
      (details?.title ? theme.fg("muted", ` — ${details.title}`) : "");
    const content = typeof message.content === "string" ? message.content : "";
    const display = expanded ? content : truncateText(content, 4_000);

    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${header}\n${theme.fg("dim", "side-channel; hidden from main context")}\n\n${display}`, 0, 0));
    return box;
  });

  pi.registerMessageRenderer<BtwPromotedDetails>(BTW_PROMOTED_TYPE, (message, _options, theme) => {
    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    const content = typeof message.content === "string" ? message.content : "";
    box.addChild(new Text(`${theme.fg("success", theme.bold("BTW promoted"))}\n${content}`, 0, 0));
    return box;
  });
}
