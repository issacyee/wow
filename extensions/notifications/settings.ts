/** Shared notification settings with project-over-global resolution. */

import { readWowSetting } from "../wow/settings.ts";

export const DEFAULT_NOTIFICATIONS_ENABLED = true;
export const DEFAULT_MINIMUM_WORKING_DURATION_MS = 10_000;
export const MAX_MINIMUM_WORKING_DURATION_MS = 24 * 60 * 60 * 1000;

export interface NotificationSettings {
  enabled: boolean;
  minimumWorkingDurationMs: number;
}

export function normalizeMinimumWorkingDurationMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MINIMUM_WORKING_DURATION_MS;
  }
  return Math.max(0, Math.min(MAX_MINIMUM_WORKING_DURATION_MS, Math.round(value)));
}

export function readNotificationSettings(cwd = process.cwd()): NotificationSettings {
  const enabled = readWowSetting(["wow", "notifications", "enabled"], { cwd });
  const minimumWorkingDurationMs = readWowSetting(
    ["wow", "notifications", "minimumWorkingDurationMs"],
    { cwd },
  );

  return {
    enabled: typeof enabled === "boolean" ? enabled : DEFAULT_NOTIFICATIONS_ENABLED,
    minimumWorkingDurationMs: normalizeMinimumWorkingDurationMs(minimumWorkingDurationMs),
  };
}
