/**
 * Shared Wow TUI color palette.
 */

export type ColorFn = (s: string) => string;
export type WowColorValue = string | number;

export const DEFAULT_WOW_COLOR_VALUES = {
  "workflow.discussBorder": "#7a5ea0",
  "workflow.planBorder": "#f5a742",
  "workflow.reviseBorder": "#c9a84c",
  "workflow.executeBorder": "#5c9cf5",
  "footer.cwd": "#c9a84c",
  "footer.branch": "#7a5ea0",
  "footer.model": "#1faf7a",
  "footer.tokens": "#17dae7",
  "footer.cache": "#1faf7a",
  "footer.cost": "#c9a84c",
  "footer.status": "#666666",
  "footer.contextOk": "#1faf7a",
  "footer.contextWarn": "#c9a84c",
  "footer.contextDanger": "#e8634f",
} as const satisfies Record<string, WowColorValue>;

export type WowThemeToken = keyof typeof DEFAULT_WOW_COLOR_VALUES;

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

export const GREEN = colorValueToFn(DEFAULT_WOW_COLOR_VALUES["footer.model"]);
export const YELLOW = colorValueToFn(DEFAULT_WOW_COLOR_VALUES["footer.cost"]);
export const RED = colorValueToFn(DEFAULT_WOW_COLOR_VALUES["footer.contextDanger"]);
export const BLUE = colorValueToFn(DEFAULT_WOW_COLOR_VALUES["footer.tokens"]);
export const PURPLE = colorValueToFn(DEFAULT_WOW_COLOR_VALUES["workflow.discussBorder"]);
export const ORANGE = colorValueToFn(DEFAULT_WOW_COLOR_VALUES["workflow.planBorder"]);
export const EXECUTE_BLUE = colorValueToFn(DEFAULT_WOW_COLOR_VALUES["workflow.executeBorder"]);
export const DIM = colorValueToFn(DEFAULT_WOW_COLOR_VALUES["footer.status"]);
