/**
 * Working completion notifications.
 *
 * Tracks the full agent run through agent_settled so automatic retries,
 * compaction recovery, and queued continuations produce at most one notice.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DesktopNotificationProvider } from "./desktop.ts";
import { buildWorkingNotification, collectNotificationContext } from "./context.ts";
import {
  getTerminalFocusState,
  getWorkingCancellationGeneration,
  type TerminalFocusState,
} from "./focus.ts";
import type { NotificationProvider } from "./provider.ts";
import { readNotificationSettings } from "./settings.ts";

export type WorkingOutcome = "completed" | "failed" | "cancelled";

interface WorkingCycle {
  startedAt: number;
  latestAssistant?: AssistantMessage;
  cancellationGeneration: number;
}

export interface NotificationDecisionInput {
  durationMs: number;
  minimumWorkingDurationMs: number;
  enabled: boolean;
  focus: TerminalFocusState;
  outcome: WorkingOutcome;
}

export function classifyWorkingOutcome(
  message: AssistantMessage | undefined,
  userCancelled = false,
): WorkingOutcome {
  if (userCancelled || message?.stopReason === "aborted") return "cancelled";
  if (!message || message.stopReason === "error") return "failed";
  return "completed";
}

export function shouldNotifyWorkingCompletion(input: NotificationDecisionInput): boolean {
  if (!input.enabled) return false;
  if (input.outcome === "cancelled") return false;
  if (input.durationMs < input.minimumWorkingDurationMs) return false;
  return input.focus !== "focused";
}

function notifyCommandResult(
  ctx: ExtensionCommandContext,
  message: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else console.log(message);
}

export default function notificationsExtension(pi: ExtensionAPI): void {
  const providers: NotificationProvider[] = [new DesktopNotificationProvider()];
  let workingCycle: WorkingCycle | undefined;

  function resetSessionState(): void {
    workingCycle = undefined;
  }

  pi.registerCommand("notify:test", {
    description: "Test the desktop notification backend and show diagnostics",
    handler: async (_args, ctx) => {
      const provider = providers[0];
      if (!provider) {
        notifyCommandResult(ctx, "Notification test failed: no notification provider is configured.", "error");
        return;
      }

      const context = collectNotificationContext(ctx.cwd, ctx.sessionManager.getSessionId());
      const result = await provider.send(buildWorkingNotification(context, "test"));
      const availability = result.available ? "available" : "unavailable";
      const diagnostics = result.diagnostics?.length ? ` · ${result.diagnostics.join(" · ")}` : "";
      if (result.ok) {
        notifyCommandResult(ctx, `Notification test succeeded · provider=${provider.id} · backend=${result.backend} · ${availability}${diagnostics}`);
        return;
      }

      notifyCommandResult(
        ctx,
        `Notification test failed · provider=${provider.id} · backend=${result.backend} · ${availability}${diagnostics} · ${result.error ?? "unknown error"}`,
        "error",
      );
    },
  });

  pi.on("session_start", async () => {
    resetSessionState();
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    workingCycle ??= {
      startedAt: Date.now(),
      cancellationGeneration: getWorkingCancellationGeneration(),
    };
  });

  pi.on("message_end", async (event, ctx) => {
    if (ctx.mode !== "tui" || event.message.role !== "assistant" || !workingCycle) return;
    // Retryable/overflow errors can be removed from the active agent state before
    // continuation. A later assistant message overwrites them with the final
    // outcome; if recovery settles without another message, keep failure.
    workingCycle.latestAssistant = event.message;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const cycle = workingCycle;
    workingCycle = undefined;
    if (ctx.mode !== "tui" || !cycle) return;

    const settings = readNotificationSettings(ctx.cwd);
    const durationMs = Math.max(0, Date.now() - cycle.startedAt);
    const userCancelled = getWorkingCancellationGeneration() !== cycle.cancellationGeneration;
    const outcome = classifyWorkingOutcome(cycle.latestAssistant, userCancelled);
    if (!shouldNotifyWorkingCompletion({
      durationMs,
      minimumWorkingDurationMs: settings.minimumWorkingDurationMs,
      enabled: settings.enabled,
      focus: getTerminalFocusState(),
      outcome,
    })) return;

    const context = collectNotificationContext(ctx.cwd, ctx.sessionManager.getSessionId());
    const notification = buildWorkingNotification(
      context,
      outcome === "failed" ? "failed" : "completed",
    );

    // Notification delivery must never delay the agent becoming idle. Runtime
    // failures are intentionally silent; /notify:test exposes diagnostics.
    for (const provider of providers) {
      void provider.send(notification).catch(() => undefined);
    }
  });

  pi.on("session_shutdown", async () => {
    resetSessionState();
  });
}
