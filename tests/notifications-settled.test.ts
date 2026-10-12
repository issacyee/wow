// Regression: settled.aborted, not raw Escape/assistant inference, owns cancellation.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import notificationsExtension, { classifyWorkingOutcome, shouldNotifyWorkingCompletion } from "../extensions/notifications/index.ts";
import { DesktopNotificationProvider } from "../extensions/notifications/desktop.ts";
import { consumeFocusInput, getTerminalFocusState, resetTerminalFocusState, setTerminalFocusState } from "../extensions/notifications/focus.ts";
import { installTerminalFocusReporting, uninstallTerminalFocusReporting } from "../extensions/wow-tui/terminal-focus.ts";
import type { Notification } from "../extensions/notifications/provider.ts";

const message = (stopReason: string): any => ({ role: "assistant", content: [], stopReason });
for (const stopReason of ["stop", "error", "aborted", "toolUse"]) {
  assert.equal(classifyWorkingOutcome(message(stopReason), true), "cancelled");
}
assert.equal(classifyWorkingOutcome(undefined, true), "cancelled");
assert.equal(classifyWorkingOutcome(message("stop"), false), "completed");
for (const value of [undefined, message("error"), message("aborted")]) {
  assert.equal(classifyWorkingOutcome(value, false), "failed");
}
for (const outcome of ["completed", "failed", "cancelled"] as const) {
  assert.equal(shouldNotifyWorkingCompletion({ enabled: true, durationMs: 10000, minimumWorkingDurationMs: 10000, outcome }), outcome !== "cancelled");
  assert.equal(shouldNotifyWorkingCompletion({ enabled: true, durationMs: 9999, minimumWorkingDurationMs: 10000, outcome }), false);
  assert.equal(shouldNotifyWorkingCompletion({ enabled: false, durationMs: 20000, minimumWorkingDurationMs: 10000, outcome }), false);
}
assert.deepEqual(consumeFocusInput("a\x1b[I中\x1b[Ob", "unknown"), { state: "blurred", data: "a中b", handled: true });
assert.deepEqual(consumeFocusInput("\x1b", "focused"), { state: "focused", data: "\x1b", handled: false });
resetTerminalFocusState();
assert.equal(getTerminalFocusState(), "unknown");
setTerminalFocusState("blurred");
assert.equal(getTerminalFocusState(), "blurred");

const root = mkdtempSync(join(tmpdir(), "wow-notifications-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldSend = DesktopNotificationProvider.prototype.send;
const notices: Notification[] = [];
process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(join(root, "settings.json"), JSON.stringify({ wow: { notifications: { minimumWorkingDurationMs: 0 } } }));
DesktopNotificationProvider.prototype.send = async (notice) => {
  notices.push(notice);
  return { ok: true, available: true, backend: "fake" };
};
const handlers = new Map<string, any>();
notificationsExtension({ on: (name: string, fn: any) => handlers.set(name, fn), registerCommand() {} } as any);
const ctx: any = { cwd: root, mode: "tui", sessionManager: { getSessionId: () => "test-session" } };
const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
try {
  await emit("session_start");
  await emit("agent_start");
  await emit("message_end", { message: message("stop") });
  await emit("agent_settled", { aborted: true });
  assert.equal(notices.length, 0, "cancel after successful assistant output still suppresses notification");
  await emit("agent_start");
  await emit("message_end", { message: message("error") });
  await emit("agent_start"); // automatic retry continues the same cycle
  await emit("message_end", { message: message("stop") });
  await emit("agent_settled", { aborted: false });
  assert.equal(notices.length, 1);
  await emit("agent_settled", { aborted: false });
  assert.equal(notices.length, 1, "settled clears the cycle");
  await emit("agent_start");
  await emit("message_end", { message: message("aborted") });
  await emit("agent_settled", { aborted: false });
  assert.equal(notices.length, 2, "assistant aborted without native cancellation is a failure");
  await emit("session_shutdown");

  let input!: (data: string) => any;
  let disposed = 0;
  const oldWrite = process.stdout.write;
  const protocol: string[] = [];
  process.stdout.write = ((chunk: any) => { protocol.push(String(chunk)); return true; }) as any;
  try {
    installTerminalFocusReporting({ mode: "tui", ui: { onTerminalInput: (fn: any) => { input = fn; return () => disposed++; } } } as any);
    assert.equal(input("\x1b"), undefined, "raw Escape is not intercepted");
    assert.deepEqual(input("\x1b[I"), { consume: true });
    assert.equal(getTerminalFocusState(), "focused");
    assert.deepEqual(input("\x1b[Otyped"), { data: "typed" });
    uninstallTerminalFocusReporting();
    assert.equal(disposed, 1);
    assert.equal(getTerminalFocusState(), "unknown");
    assert.deepEqual(protocol, ["\x1b[?1004h", "\x1b[?1004l"]);
  } finally {
    process.stdout.write = oldWrite;
  }
  console.log("OK: authoritative settled cancellation, retry lifecycle, and retained focus reporting");
} finally {
  DesktopNotificationProvider.prototype.send = oldSend;
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  rmSync(root, { recursive: true, force: true });
}
