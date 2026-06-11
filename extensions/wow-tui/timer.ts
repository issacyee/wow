/**
 * Shared Wow TUI timer helpers.
 */

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const TIMER_INTERVAL_MS = 100;

export function formatDuration(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));

  if (ms < 1000) {
    return `${ms}ms`;
  }

  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  if (ms < 3_600_000) {
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}
