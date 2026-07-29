/** Terminal window/tab title for locating the instance named by a notification. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectNotificationContext, terminalTitle } from "../notifications/context.ts";

const TITLE_REAPPLY_DELAYS_MS = [0, 750, 2_500];
let generation = 0;

export function setInstanceTerminalTitle(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const title = terminalTitle(collectNotificationContext(ctx.cwd, ctx.sessionManager.getSessionId()));
  const currentGeneration = ++generation;

  // Pi restores its built-in title after session rebinding and may do so again
  // after the asynchronous package update check on Windows. Reapply after those
  // framework-owned updates without keeping a long-lived timer.
  for (const delay of TITLE_REAPPLY_DELAYS_MS) {
    setTimeout(() => {
      if (currentGeneration !== generation) return;
      try {
        ctx.ui.setTitle(title);
      } catch {
        // The TUI may have shut down between scheduling and reapplying.
      }
    }, delay);
  }
}

export function clearInstanceTerminalTitle(): void {
  generation++;
}
