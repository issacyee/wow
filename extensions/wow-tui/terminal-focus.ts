/**
 * TUI owner for terminal focus reporting used by Working notifications.
 *
 * This module owns the persistent terminal escape mode and raw-input listener,
 * keeping terminal protocol manipulation inside wow-tui's visual shell.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
  consumeFocusInput,
  DISABLE_FOCUS_REPORTING,
  ENABLE_FOCUS_REPORTING,
  getTerminalFocusState,
  markWorkingCancellation,
  resetTerminalFocusState,
  setTerminalFocusState,
} from "../notifications/focus.ts";

let ctx: ExtensionContext | undefined;
let unsubscribe: (() => void) | undefined;
let working = false;

export function setTerminalFocusWorking(active: boolean): void {
  working = active;
}

export function installTerminalFocusReporting(sessionCtx: ExtensionContext): void {
  uninstallTerminalFocusReporting();
  ctx = sessionCtx;
  working = false;
  resetTerminalFocusState();

  if (sessionCtx.mode !== "tui") return;

  process.stdout.write(ENABLE_FOCUS_REPORTING);
  unsubscribe = sessionCtx.ui.onTerminalInput((data) => {
    const result = consumeFocusInput(data, getTerminalFocusState());
    setTerminalFocusState(result.state);

    // A direct Escape while Working is the user's cancellation gesture. This
    // also covers cancelling retry backoff or auto-compaction, which may not
    // produce a final assistant message with stopReason "aborted".
    if (working && matchesKey(result.data, Key.escape)) markWorkingCancellation();

    if (!result.handled) return undefined;
    if (result.data.length === 0) return { consume: true };
    return { data: result.data };
  });
}

export function uninstallTerminalFocusReporting(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  if (ctx?.mode === "tui") process.stdout.write(DISABLE_FOCUS_REPORTING);
  ctx = undefined;
  working = false;
  resetTerminalFocusState();
}
