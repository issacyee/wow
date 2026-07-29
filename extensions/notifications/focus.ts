/**
 * Terminal focus reporting state shared by notification logic and wow-tui.
 *
 * Pi loads package extensions through separate jiti module instances, so the
 * mutable state lives on globalThis. The parser and store are UI-independent;
 * wow-tui owns terminal protocol installation and raw-input interception.
 */

export type TerminalFocusState = "focused" | "blurred" | "unknown";

export const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
export const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";

type FocusStore = {
  state: TerminalFocusState;
  cancellationGeneration: number;
};

const FOCUS_STORE_KEY = Symbol.for("wow.notifications.focus");

function getStore(): FocusStore {
  const root = globalThis as any;
  return (root[FOCUS_STORE_KEY] ??= {
    state: "unknown",
    cancellationGeneration: 0,
  }) as FocusStore;
}

export interface FocusInputResult {
  state: TerminalFocusState;
  data: string;
  handled: boolean;
}

export function consumeFocusInput(data: string, current: TerminalFocusState): FocusInputResult {
  let state = current;
  let handled = false;
  const cleaned = data.replace(/\x1b\[[IO]/g, (sequence) => {
    handled = true;
    state = sequence === FOCUS_IN ? "focused" : "blurred";
    return "";
  });

  return { state, data: cleaned, handled };
}

export function getTerminalFocusState(): TerminalFocusState {
  return getStore().state;
}

export function setTerminalFocusState(state: TerminalFocusState): void {
  getStore().state = state;
}

export function resetTerminalFocusState(): void {
  getStore().state = "unknown";
}

export function markWorkingCancellation(): void {
  getStore().cancellationGeneration++;
}

export function getWorkingCancellationGeneration(): number {
  return getStore().cancellationGeneration;
}
