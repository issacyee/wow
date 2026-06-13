/**
 * Wow TUI theme adapter.
 *
 * Pi theme JSON does not allow extension-specific keys in `colors`, but `vars`
 * intentionally accepts arbitrary reusable color names. Wow reads optional
 * `vars["wow.<token>"]` values from the active theme JSON and falls back to
 * pi's own semantic theme colors when absent or invalid.
 */

import { readFileSync, statSync } from "node:fs";
import {
  colorValueToFn,
  DEFAULT_WOW_THEME_FALLBACKS,
  type ColorFn,
  type WowColorValue,
  type WowThemeToken,
} from "./palette.ts";

const WOW_VAR_PREFIX = "wow.";
const MAX_VAR_DEPTH = 16;

interface CachedWowThemeVars {
  cacheKey: string;
  vars: Record<string, WowColorValue>;
}

let cachedVars: CachedWowThemeVars | undefined;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isColorValue(value: unknown): value is WowColorValue {
  return value === "" ||
    (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255);
}

function resolveVarValue(vars: Record<string, unknown>, value: unknown, seen = new Set<string>()): WowColorValue | undefined {
  if (isColorValue(value)) return value;
  if (typeof value !== "string" || value.startsWith("#")) return undefined;
  if (seen.size >= MAX_VAR_DEPTH || seen.has(value)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(vars, value)) return undefined;

  seen.add(value);
  return resolveVarValue(vars, vars[value], seen);
}

function cacheKeyForTheme(theme: any): string | undefined {
  const sourcePath = typeof theme?.sourcePath === "string" ? theme.sourcePath : undefined;
  if (!sourcePath) return undefined;

  try {
    const stat = statSync(sourcePath);
    return `${sourcePath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return sourcePath;
  }
}

function loadWowVars(theme: any): Record<string, WowColorValue> {
  const sourcePath = typeof theme?.sourcePath === "string" ? theme.sourcePath : undefined;
  const cacheKey = cacheKeyForTheme(theme);
  if (!sourcePath || !cacheKey) return {};
  if (cachedVars?.cacheKey === cacheKey) return cachedVars.vars;

  const result: Record<string, WowColorValue> = {};

  try {
    const json = JSON.parse(readFileSync(sourcePath, "utf8"));
    const vars = isJsonObject(json?.vars) ? json.vars : {};

    for (const [key, value] of Object.entries(vars)) {
      if (!key.startsWith(WOW_VAR_PREFIX)) continue;
      const token = key.slice(WOW_VAR_PREFIX.length);
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_WOW_THEME_FALLBACKS, token)) continue;

      const resolved = resolveVarValue(vars, value);
      if (resolved !== undefined) result[token] = resolved;
    }
  } catch {
    // Invalid or temporarily unavailable theme files should never break the UI.
  }

  cachedVars = { cacheKey, vars: result };
  return result;
}

export function wowColorValue(theme: any, token: WowThemeToken): WowColorValue | undefined {
  return loadWowVars(theme)[token];
}

export function wowColor(theme: any, token: WowThemeToken): ColorFn {
  const value = wowColorValue(theme, token);
  if (value !== undefined) return colorValueToFn(value);

  const fallback = DEFAULT_WOW_THEME_FALLBACKS[token];
  return (text: string) => theme?.fg ? theme.fg(fallback.pi, text) : text;
}

export function wowFg(theme: any, token: WowThemeToken, text: string): string {
  return wowColor(theme, token)(text);
}

export { DEFAULT_WOW_THEME_FALLBACKS, type WowThemeToken } from "./palette.ts";
