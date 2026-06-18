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

import { Container, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { fitEnd, linkUrlAdaptive } from "./paths.ts";

const DEFAULT_PADDING_X = 1;

export type AdaptiveLineBuilder = (availableWidth: number) => string;
export type AdaptiveLinesBuilder = (availableWidth: number) => string[];
export type AdaptiveLineStyler = (text: string, index: number) => string;

export interface AdaptiveLinesOptions {
  paddingX?: number;
  normalizeWhitespace?: boolean;
  truncate?: boolean;
  style?: AdaptiveLineStyler;
}

/** Multi-line component that fits content at render-time using the current TUI width. */
export class AdaptiveLines implements Component {
  constructor(
    private readonly buildLines: AdaptiveLinesBuilder,
    private readonly options: AdaptiveLinesOptions = {},
  ) {}

  invalidate(): void {
    // Stateless component.
  }

  render(width: number): string[] {
    if (width <= 0) return [""];

    const requestedPaddingX = this.options.paddingX ?? DEFAULT_PADDING_X;
    const paddingX = width >= requestedPaddingX * 2 + 1 ? requestedPaddingX : 0;
    const availableWidth = Math.max(1, width - paddingX * 2);
    const lines = this.buildLines(availableWidth);

    return lines.map((line, index) => this.renderLine(line, index, width, availableWidth, paddingX));
  }

  private renderLine(line: string, index: number, width: number, availableWidth: number, paddingX: number): string {
    const normalizedLine = this.options.normalizeWhitespace === false
      ? line
      : line.replace(/\s*\n\s*/g, " ");
    const fittedLine = this.options.truncate === false
      ? normalizedLine
      : truncateToWidth(normalizedLine, availableWidth);
    const styledLine = this.options.style ? this.options.style(fittedLine, index) : fittedLine;
    const paddedLine = `${" ".repeat(paddingX)}${styledLine}${" ".repeat(paddingX)}`;
    const padding = " ".repeat(Math.max(0, width - visibleWidth(paddedLine)));

    return paddedLine + padding;
  }
}

/** Single-line component that fits content at render-time using the current TUI width. */
export class AdaptiveLine extends AdaptiveLines {
  constructor(
    buildLine: AdaptiveLineBuilder,
    style: (text: string) => string = (text) => text,
    paddingX = DEFAULT_PADDING_X,
  ) {
    super((availableWidth) => [buildLine(availableWidth)], {
      paddingX,
      style: (text) => style(text),
    });
  }
}

/** Backward-compatible focus-style tool line component. */
export class AdaptiveToolLine extends AdaptiveLine {}

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

function extractTextResult(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n")
    .trimEnd();
}

/**
 * Generic focus-style renderResult.
 * Keeps successful results hidden by default, but restores details when the
 * tool row is expanded (Ctrl+O) or when the tool result is an error.
 */
export function focusRenderResult(
  result: any,
  options: any,
  theme: any,
  context: any,
): Component {
  if (!options?.expanded && !context?.isError) return new Container();

  const output = extractTextResult(result);
  if (!output) return new Container();

  const text = context?.lastComponent instanceof Text
    ? context.lastComponent
    : new Text("", 0, 0);
  const styledOutput = output
    .split("\n")
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");
  text.setText(`\n${styledOutput}`);
  return text;
}
