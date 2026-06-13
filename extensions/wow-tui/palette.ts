/**
 * Shared Wow TUI color palette.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export type ColorFn = (s: string) => string;
export type WowColorValue = string | number;

export interface WowThemeFallback {
  pi: ThemeColor;
}

export const DEFAULT_WOW_THEME_FALLBACKS = {
  "workflow.discussBorder": { pi: "muted" },
  "workflow.planBorder": { pi: "warning" },
  "workflow.reviseBorder": { pi: "warning" },
  "workflow.executeBorder": { pi: "accent" },
  "workflow.statusDiscuss": { pi: "muted" },
  "workflow.statusPlan": { pi: "warning" },
  "workflow.statusRevise": { pi: "warning" },
  "workflow.statusExec": { pi: "accent" },
  "workflow.statusDone": { pi: "success" },
  "workflow.statusReady": { pi: "muted" },
  "footer.cwd": { pi: "muted" },
  "footer.branch": { pi: "muted" },
  "footer.model": { pi: "success" },
  "footer.tokens": { pi: "muted" },
  "footer.cost": { pi: "muted" },
  "footer.status": { pi: "dim" },
  "footer.contextOk": { pi: "success" },
  "footer.contextWarn": { pi: "warning" },
  "footer.contextDanger": { pi: "error" },
} as const satisfies Record<string, WowThemeFallback>;

export type WowThemeToken = keyof typeof DEFAULT_WOW_THEME_FALLBACKS;

function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
  const match = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!match) return undefined;

  const value = match[1]!;
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

export function rgb(r: number, g: number, b: number): ColorFn {
  return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

export function colorValueToFn(value: WowColorValue): ColorFn {
  if (value === "") return (s: string) => `\x1b[39m${s}\x1b[39m`;

  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 255) return (s: string) => s;
    return (s: string) => `\x1b[38;5;${value}m${s}\x1b[39m`;
  }

  const rgbValue = hexToRgb(value);
  if (!rgbValue) return (s: string) => s;
  return rgb(rgbValue.r, rgbValue.g, rgbValue.b);
}
