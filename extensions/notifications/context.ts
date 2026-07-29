/**
 * Deterministic notification identity and display context.
 *
 * Session labels are stable across resume/fork semantics because they derive
 * from pi's session id. Instance labels identify one running pi process and are
 * intentionally regenerated after restart.
 */

import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { runGit } from "../wow/git.ts";
import { detectPrimaryLocale } from "../wow/locale.ts";
import { shortenPlainPath } from "../wow/path-text.ts";
import type { Notification } from "./provider.ts";

const INSTANCE_ID_KEY = Symbol.for("wow.notifications.instance-id");
const SHORT_ID_LENGTH = 4;

export type NotificationOutcome = "completed" | "failed" | "test";

export interface NotificationContext {
  project: string;
  path: string;
  branch?: string;
  sessionLabel: string;
  instanceLabel: string;
}

function shortHash(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, SHORT_ID_LENGTH)
    .toUpperCase();
}

export function sessionLabel(sessionId: string): string {
  return `S-${shortHash(sessionId || "unknown-session")}`;
}

export function instanceLabel(): string {
  const root = globalThis as any;
  const value = root[INSTANCE_ID_KEY];
  if (typeof value === "string" && /^I-[0-9A-F]{4}$/.test(value)) return value;

  const next = `I-${randomBytes(2).toString("hex").toUpperCase()}`;
  root[INSTANCE_ID_KEY] = next;
  return next;
}

export function projectName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  return basename(normalized) || normalized || cwd;
}

export function currentGitBranch(cwd: string): string | undefined {
  const result = runGit(cwd, ["branch", "--show-current"]);
  const branch = result.exitCode === 0 ? result.stdout.trim() : "";
  return branch || undefined;
}

export function collectNotificationContext(cwd: string, sessionId: string): NotificationContext {
  return {
    project: projectName(cwd),
    path: shortenPlainPath(cwd),
    branch: currentGitBranch(cwd),
    sessionLabel: sessionLabel(sessionId),
    instanceLabel: instanceLabel(),
  };
}

export function notificationIdentityLine(context: NotificationContext): string {
  return `${context.project} · ${context.sessionLabel} · ${context.instanceLabel}`;
}

export function terminalTitle(context: NotificationContext): string {
  return `π ${context.project} [${context.sessionLabel} · ${context.instanceLabel}]`;
}

export function buildWorkingNotification(
  context: NotificationContext,
  outcome: NotificationOutcome,
  language = detectPrimaryLocale(),
): Notification {
  const chinese = language.toLowerCase() === "zh";
  const status = chinese
    ? outcome === "failed"
      ? "Working 失败 · 请返回该实例查看错误"
      : outcome === "test"
        ? "测试通知 · 桌面通知已就绪"
        : "Working 已完成 · 等待你的下一步操作"
    : outcome === "failed"
      ? "Working failed · Return to this instance to view the error"
      : outcome === "test"
        ? "Test notification · Desktop notifications are ready"
        : "Working completed · Waiting for your next action";
  const location = context.branch ? `${context.path} · ${context.branch}` : context.path;

  return {
    title: "Pi",
    lines: [
      notificationIdentityLine(context),
      status,
      location,
    ],
  };
}
