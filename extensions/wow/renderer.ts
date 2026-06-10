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

import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitEnd, linkUrlAdaptive } from "./paths.ts";

const DEFAULT_PADDING_X = 1;

/** Single-line component that fits content at render-time using the current TUI width. */
export class AdaptiveToolLine {
  constructor(
    private readonly buildLine: (availableWidth: number) => string,
    private readonly style: (text: string) => string = (text) => text,
    private readonly paddingX = DEFAULT_PADDING_X,
  ) {}

  invalidate(): void {
    // Stateless component.
  }

  render(width: number): string[] {
    if (width <= 0) return [""];

    const paddingX = width >= this.paddingX * 2 + 1 ? this.paddingX : 0;
    const availableWidth = Math.max(1, width - paddingX * 2);
    const rawLine = this.buildLine(availableWidth).replace(/\s*\n\s*/g, " ");
    const fittedLine = truncateToWidth(rawLine, availableWidth);
    const styledLine = this.style(fittedLine);
    const paddedLine = `${" ".repeat(paddingX)}${styledLine}${" ".repeat(paddingX)}`;
    const padding = " ".repeat(Math.max(0, width - visibleWidth(paddedLine)));

    return [paddedLine + padding];
  }
}

function displayValue(value: any): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

function renderValue(value: any, maxWidth: number): string {
  const text = displayValue(value);
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    return linkUrlAdaptive(value, maxWidth);
  }
  return fitEnd(text, maxWidth);
}

function allocateValueWidths(values: string[], totalBudget: number): number[] {
  if (values.length === 0) return [];
  if (totalBudget <= 0) return values.map(() => 0);

  const fullWidths = values.map((value) => visibleWidth(value));
  if (fullWidths.reduce((sum, width) => sum + width, 0) <= totalBudget) return fullWidths;

  const widths = values.map(() => 0);
  let remaining = totalBudget;

  // Fully preserve short values such as format=markdown before spending width on long URLs.
  for (const index of fullWidths
    .map((width, index) => ({ width, index }))
    .filter((item) => item.width <= 16)
    .sort((a, b) => a.width - b.width)
    .map((item) => item.index)) {
    const fullWidth = fullWidths[index] ?? 0;
    if (fullWidth <= remaining) {
      widths[index] = fullWidth;
      remaining -= fullWidth;
    }
  }

  const flexible = widths
    .map((width, index) => ({ width, index }))
    .filter((item) => item.width < fullWidths[item.index]!);

  if (flexible.length === 0 || remaining <= 0) return widths;

  const minWidth = Math.max(4, Math.min(12, Math.floor(totalBudget / values.length)));
  for (const item of flexible) {
    if (remaining <= 0) break;
    const currentWidth = widths[item.index] ?? 0;
    const target = Math.min(fullWidths[item.index] ?? 0, minWidth);
    const delta = Math.min(target - currentWidth, remaining);
    if (delta > 0) {
      widths[item.index] = currentWidth + delta;
      remaining -= delta;
    }
  }

  while (remaining > 0) {
    const candidates = flexible.filter((item) => (widths[item.index] ?? 0) < (fullWidths[item.index] ?? 0));
    if (candidates.length === 0) break;

    for (const item of candidates) {
      if (remaining <= 0) break;
      widths[item.index] = (widths[item.index] ?? 0) + 1;
      remaining -= 1;
    }
  }

  return widths;
}

function buildFocusLine(name: string | undefined, args: Record<string, any>, availableWidth: number, includeKeys: boolean): string {
  const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== null);
  const prefix = name ? `${name}${entries.length > 0 ? " " : ""}` : "";
  if (entries.length === 0) return name ?? "";

  const fullParts = entries.map(([key, value]) => includeKeys ? `${key}=${renderValue(value, Number.MAX_SAFE_INTEGER)}` : renderValue(value, Number.MAX_SAFE_INTEGER));
  const fullLine = `${prefix}${fullParts.join(" ")}`;
  if (visibleWidth(fullLine) <= availableWidth) return fullLine;

  const staticWidth = visibleWidth(prefix) + Math.max(0, entries.length - 1);
  const valueStaticWidth = entries.reduce((sum, [key]) => sum + (includeKeys ? visibleWidth(`${key}=`) : 0), 0);
  const valueBudget = Math.max(0, availableWidth - staticWidth - valueStaticWidth);
  const values = entries.map(([, value]) => displayValue(value));
  const valueWidths = allocateValueWidths(values, valueBudget);

  const parts = entries.map(([key, value], index) => {
    const display = renderValue(value, valueWidths[index] ?? 0);
    return includeKeys ? `${key}=${display}` : display;
  });

  return `${prefix}${parts.join(" ")}`;
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
  ): AdaptiveToolLine {
    return new AdaptiveToolLine(
      (width) => buildFocusLine(name, args, width, true),
      (text) => theme.fg("dim", text),
    );
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
): AdaptiveToolLine {
  return new AdaptiveToolLine(
    (width) => buildFocusLine(undefined, args, width, false),
    (text) => theme.fg("dim", text),
  );
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
