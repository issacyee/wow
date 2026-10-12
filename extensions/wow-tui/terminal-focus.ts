/**
 * TUI owner for terminal focus reporting retained for terminal compatibility.
 *
 * This module owns the persistent terminal escape mode and raw-input listener,
 * keeping terminal protocol manipulation inside wow-tui's visual shell.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  consumeFocusInput,
  DISABLE_FOCUS_REPORTING,
  ENABLE_FOCUS_REPORTING,
  getTerminalFocusState,
  resetTerminalFocusState,
  setTerminalFocusState,
} from "../notifications/focus.ts";

let ctx: ExtensionContext | undefined;
let unsubscribe: (() => void) | undefined;
export function installTerminalFocusReporting(sessionCtx: ExtensionContext): void {
  uninstallTerminalFocusReporting();
  ctx = sessionCtx;
  resetTerminalFocusState();

  if (sessionCtx.mode !== "tui") return;

  process.stdout.write(ENABLE_FOCUS_REPORTING);
  unsubscribe = sessionCtx.ui.onTerminalInput((data) => {
    const result = consumeFocusInput(data, getTerminalFocusState());
    setTerminalFocusState(result.state);

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
  resetTerminalFocusState();
}
