/**
 * Path, URL, and command display utilities.
 *
 * These helpers keep full labels when space allows and only shorten labels for
 * the currently available TUI width. OSC 8 hyperlinks always point at the full
 * target; only the visible label is fitted.
 */

import { hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { resolve } from "node:path";

const ELLIPSIS = "...";
const UNBOUNDED_WIDTH = Number.MAX_SAFE_INTEGER;

function homeLabel(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function takeStart(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  let result = "";
  let width = 0;
  for (const char of Array.from(text)) {
    const charWidth = visibleWidth(char);
    if (width + charWidth > maxWidth) break;
    result += char;
    width += charWidth;
  }
  return result;
}

function takeEnd(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  let result = "";
  let width = 0;
  const chars = Array.from(text);
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i]!;
    const charWidth = visibleWidth(char);
    if (width + charWidth > maxWidth) break;
    result = char + result;
    width += charWidth;
  }
  return result;
}

/** Fit text by keeping the start and truncating the end. */
export function fitEnd(text: string, maxWidth: number, ellipsis = ELLIPSIS): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) return takeStart(ellipsis, maxWidth);

  return `${takeStart(text, maxWidth - ellipsisWidth)}${ellipsis}`;
}

/** Fit text by keeping both the start and the end. */
export function fitMiddle(text: string, maxWidth: number, headRatio = 0.4, ellipsis = ELLIPSIS): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) return takeStart(ellipsis, maxWidth);

  const budget = maxWidth - ellipsisWidth;
  const headBudget = Math.max(0, Math.floor(budget * headRatio));
  const tailBudget = Math.max(0, budget - headBudget);
  const result = `${takeStart(text, headBudget)}${ellipsis}${takeEnd(text, tailBudget)}`;
  return visibleWidth(result) <= maxWidth ? result : fitEnd(result, maxWidth, "");
}

/** Fit a path label, preserving the trailing filename/segment when possible. */
export function fitPath(path: string, maxWidth: number): string {
  const label = homeLabel(path);
  if (maxWidth >= UNBOUNDED_WIDTH || visibleWidth(label) <= maxWidth) return label;
  return fitMiddle(label, maxWidth, 0.35);
}

/** Fit a URL label, preserving scheme/host and the trailing path when possible. */
export function fitUrl(url: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(url) <= maxWidth) return url;

  try {
    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const remainder = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    const marker = "/...";
    const tailBudget = maxWidth - visibleWidth(origin) - visibleWidth(marker);

    if (tailBudget > 0 && visibleWidth(origin) + visibleWidth(marker) < maxWidth) {
      const tail = takeEnd(remainder || "/", tailBudget);
      const label = `${origin}${marker}${tail.startsWith("/") ? tail : `/${tail}`}`;
      if (visibleWidth(label) <= maxWidth) return label;
    }
  } catch {
    // Fall back to generic middle fitting below.
  }

  return fitMiddle(url, maxWidth, 0.55);
}

/** Collapse whitespace and fit a shell command label. */
export function fitCommand(cmd: string, maxWidth: number): string {
  return fitEnd(cmd.replace(/\s+/g, " ").trim(), maxWidth);
}

/** Shorten home directory paths to ~/... and truncate very long paths. */
export function shortenPath(path: string): string {
  return fitPath(path, 55);
}

/**
 * Resolve a path relative to cwd and wrap it in an OSC 8 file:// hyperlink.
 * Falls back to plain text if the path cannot be resolved.
 */
export function linkPath(path: string, cwd: string): string {
  return linkPathAdaptive(path, cwd, 55);
}

/**
 * Width-aware path hyperlink. The visible label is fitted to maxWidth while the
 * hyperlink target remains the full resolved path.
 */
export function linkPathAdaptive(path: string, cwd: string, maxWidth = UNBOUNDED_WIDTH): string {
  const label = fitPath(path, maxWidth);
  try {
    const abs = resolve(cwd, path);
    return hyperlink(label, `file://${abs}`);
  } catch {
    return label;
  }
}

/** Width-aware URL hyperlink. */
export function linkUrlAdaptive(url: string, maxWidth = UNBOUNDED_WIDTH): string {
  return hyperlink(fitUrl(url, maxWidth), url);
}

/** Truncate a command string to a reasonable display length. */
export function shortenCommand(cmd: string): string {
  return fitCommand(cmd, 60);
}
