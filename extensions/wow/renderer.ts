/**
 * Focus-style renderer utilities
 *
 * Shared dim-style rendering functions for custom tools.
 * Provides minimal, unobtrusive visual style — single dim-text line per tool call.
 *
 * Usage in a custom tool:
 *   import { createFocusRenderCall, focusRenderResult } from "../wow/renderer.ts";
 *   // inside defineTool:
 *   renderShell: "self",
 *   renderCall: createFocusRenderCall("my_tool"),
 *   renderResult: focusRenderResult,
 */

import { Text, Container, hyperlink } from "@earendil-works/pi-tui";

/** Truncate a string to a reasonable display length */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/**
 * Create a focus-style renderCall for a named tool.
 * Shows `toolName key1=val1 key2=val2` in dim text.
 *
 * @param name - tool name to display (e.g. "webfetch")
 */
export function createFocusRenderCall(name: string) {
  return function focusRenderCall(
    args: Record<string, any>,
    theme: any,
    _context?: any,
  ): Text {
    const parts: string[] = [];
    for (const [key, val] of Object.entries(args)) {
      if (val === undefined || val === null) continue;

      let display: string;
      if (typeof val === "string") {
        const truncated = truncate(val, 80);
        // Wrap URLs with OSC 8 hyperlink for consistent underline style
        display = /^https?:\/\//.test(val)
          ? hyperlink(truncated, val)
          : truncated;
      } else {
        display = truncate(JSON.stringify(val), 80);
      }
      parts.push(`${key}=${display}`);
    }

    const paramsText = parts.join(" ");
    const line = paramsText ? `${name} ${paramsText}` : name;
    return new Text(theme.fg("dim", line), 1, 0);
  };
}

/**
 * Generic focus-style renderCall for any tool.
 * Shows `key1=val1 key2=val2` in dim text (no tool name prefix).
 */
export function focusRenderCall(
  args: Record<string, any>,
  theme: any,
  _context?: any,
): Text {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(args)) {
    if (val === undefined || val === null) continue;

    let display: string;
    if (typeof val === "string") {
      display = truncate(val, 80);
    } else {
      display = truncate(JSON.stringify(val), 80);
    }
    parts.push(display);
  }

  const line = parts.join(" ");
  return new Text(theme.fg("dim", line), 1, 0);
}

/**
 * Generic focus-style renderResult.
 * Returns an empty container — tool output is sent to the LLM,
 * no need to display full results in TUI.
 */
export function focusRenderResult(
  _result: any,
  _options: any,
  _theme: any,
  _context: any,
): Container {
  return new Container();
}
