/**
 * History Peek — prompt-side search over the current conversation branch.
 *
 * This is a UI-only helper for humans composing prompts. It does not write
 * messages, does not inject context, and does not affect provider requests.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

const HISTORY_PEEK_WIDGET_KEY = "wow.history-peek";
const MAX_SEARCH_RESULTS = 40;
const VISIBLE_RESULT_COUNT = 5;
const CONTEXT_RADIUS = 1;
const PREVIEW_CHARS = 220;
const OVERLAY_SELECTED_BODY_LINES = 6;
const OVERLAY_NEIGHBOR_BODY_LINES = 3;
const PINNED_SELECTED_BODY_LINES = 8;
const PINNED_NEIGHBOR_BODY_LINES = 3;
const PINNED_MAX_LINES = 16;

type HistoryRole = "user" | "assistant" | "custom" | "compaction" | "branch";

export interface HistorySearchItem {
  id: string;
  role: HistoryRole;
  timestamp: string;
  text: string;
  branchIndex: number;
}

interface HistorySearchResult {
  item: HistorySearchItem;
  score: number;
  snippet: string;
}

interface HistoryPeekSelection {
  query: string;
  selected: HistorySearchItem;
  context: HistorySearchItem[];
}

interface MatchRange {
  start: number;
  end: number;
}

type HistoryPeekOverlayResult =
  | { action: "pin"; selection: HistoryPeekSelection }
  | { action: "cancel" };

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: { text: string }) => block.text)
    .join("\n");
}

function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function compactText(text: string): string {
  return cleanText(text).replace(/\s+/g, " ").trim();
}

function roleLabel(role: HistoryRole): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "custom":
      return "Custom";
    case "compaction":
      return "Compaction";
    case "branch":
      return "Branch";
  }
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;

  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function itemMeta(item: HistorySearchItem): string {
  return `${roleLabel(item.role)} · ${formatTimestamp(item.timestamp)} · #${shortId(item.id)}`;
}

function textFromMessageEntry(entry: any): { role: HistoryRole; text: string } | undefined {
  const message = entry?.message;
  if (!message || typeof message !== "object") return undefined;

  if (message.role === "user") {
    return { role: "user", text: contentToText(message.content) };
  }

  if (message.role === "assistant") {
    return { role: "assistant", text: contentToText(message.content) };
  }

  if (message.role === "custom" && message.display === true) {
    return { role: "custom", text: contentToText(message.content) };
  }

  if (message.role === "compactionSummary" && typeof message.summary === "string") {
    return { role: "compaction", text: message.summary };
  }

  if (message.role === "branchSummary" && typeof message.summary === "string") {
    return { role: "branch", text: message.summary };
  }

  return undefined;
}

function textFromEntry(entry: any): { role: HistoryRole; text: string } | undefined {
  if (entry?.type === "message") return textFromMessageEntry(entry);

  if (entry?.type === "custom_message" && entry.display === true) {
    return { role: "custom", text: contentToText(entry.content) };
  }

  if (entry?.type === "compaction" && typeof entry.summary === "string") {
    return { role: "compaction", text: entry.summary };
  }

  if (entry?.type === "branch_summary" && typeof entry.summary === "string") {
    return { role: "branch", text: entry.summary };
  }

  return undefined;
}

export function collectHistorySearchItems(ctx: ExtensionContext): HistorySearchItem[] {
  return (ctx.sessionManager.getBranch() as any[])
    .map((entry, branchIndex) => {
      const extracted = textFromEntry(entry);
      if (!extracted) return undefined;

      const text = cleanText(extracted.text);
      if (!text) return undefined;

      return {
        id: String(entry.id ?? branchIndex),
        role: extracted.role,
        timestamp: String(entry.timestamp ?? ""),
        text,
        branchIndex,
      } satisfies HistorySearchItem;
    })
    .filter((item): item is HistorySearchItem => Boolean(item));
}

function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(query)) !== null) {
    const token = (match[1] ?? match[2] ?? match[3] ?? "").trim().toLowerCase();
    if (token) tokens.push(token);
  }

  return tokens;
}

function countOccurrences(text: string, token: string): number {
  if (!token) return 0;

  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(token, offset);
    if (index < 0) break;
    count++;
    offset = index + token.length;
  }
  return count;
}

function uniqueTokens(query: string): string[] {
  return Array.from(new Set(tokenizeQuery(query))).filter(Boolean);
}

function findMatchRanges(text: string, tokens: string[]): MatchRange[] {
  if (tokens.length === 0 || !text) return [];

  const lower = text.toLowerCase();
  const ranges: MatchRange[] = [];

  for (const token of tokens) {
    let offset = 0;
    while (true) {
      const index = lower.indexOf(token, offset);
      if (index < 0) break;
      ranges.push({ start: index, end: index + token.length });
      offset = index + token.length;
    }
  }

  return mergeMatchRanges(ranges);
}

function mergeMatchRanges(ranges: MatchRange[]): MatchRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: MatchRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

function highlightMatches(
  theme: any,
  text: string,
  query: string,
  baseStyle: (segment: string) => string = (segment) => segment,
): string {
  if (!text) return text;

  const ranges = findMatchRanges(text, uniqueTokens(query));
  if (ranges.length === 0) return baseStyle(text);

  const parts: string[] = [];
  let offset = 0;
  for (const range of ranges) {
    if (range.start > offset) {
      parts.push(baseStyle(text.slice(offset, range.start)));
    }
    parts.push(theme.fg("warning", text.slice(range.start, range.end)));
    offset = range.end;
  }

  if (offset < text.length) {
    parts.push(baseStyle(text.slice(offset)));
  }

  return parts.join("");
}

function renderBodyLines(
  theme: any,
  text: string,
  query: string,
  width: number,
  maxLines: number,
  baseStyle: (segment: string) => string = (segment) => segment,
): string[] {
  if (maxLines <= 0) return [];

  const body = cleanText(text);
  if (!body) return [];

  const rawLines = body.split("\n");
  const lines: string[] = [];
  let truncated = false;

  outer: for (let rawIndex = 0; rawIndex < rawLines.length; rawIndex++) {
    const rawLine = rawLines[rawIndex]!;

    if (rawLine.trim().length === 0) {
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      lines.push("");
      continue;
    }

    const highlighted = highlightMatches(theme, rawLine, query, baseStyle);
    const wrapped = wrapTextWithAnsi(highlighted, Math.max(1, width));
    for (let wrapIndex = 0; wrapIndex < wrapped.length; wrapIndex++) {
      if (lines.length >= maxLines) {
        truncated = true;
        break outer;
      }
      lines.push(wrapped[wrapIndex]!);
    }
  }

  if (truncated) {
    const last = lines[lines.length - 1];
    if (last !== undefined && visibleWidth(last) > 0) {
      lines[lines.length - 1] = truncateToWidth(`${last} …`, width, "…");
    } else if (lines.length > 0) {
      lines[lines.length - 1] = truncateToWidth("…", width, "");
    }
  }

  return lines;
}

function buildSnippet(text: string, tokens: string[]): string {
  const compact = compactText(text);
  if (compact.length <= PREVIEW_CHARS) return compact;

  const lower = compact.toLowerCase();
  const firstMatch = tokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;

  const start = Math.max(0, firstMatch - 70);
  const end = Math.min(compact.length, start + PREVIEW_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < compact.length ? "…" : "";

  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

export function searchHistoryItems(items: HistorySearchItem[], query: string): HistorySearchResult[] {
  const tokens = tokenizeQuery(query);

  if (tokens.length === 0) {
    return items
      .slice(-MAX_SEARCH_RESULTS)
      .reverse()
      .map((item) => ({ item, score: 0, snippet: buildSnippet(item.text, []) }));
  }

  return items
    .map((item) => {
      const normalized = item.text.toLowerCase();
      if (!tokens.every((token) => normalized.includes(token))) return undefined;

      const score = tokens.reduce((sum, token) => sum + countOccurrences(normalized, token) * 10, 0);
      return { item, score, snippet: buildSnippet(item.text, tokens) } satisfies HistorySearchResult;
    })
    .filter((result): result is HistorySearchResult => Boolean(result))
    .sort((a, b) => b.score - a.score || b.item.branchIndex - a.item.branchIndex)
    .slice(0, MAX_SEARCH_RESULTS);
}

function buildSelection(items: HistorySearchItem[], result: HistorySearchResult, query: string): HistoryPeekSelection {
  const index = items.findIndex((item) => item.id === result.item.id);
  const start = Math.max(0, index - CONTEXT_RADIUS);
  const end = Math.min(items.length, index + CONTEXT_RADIUS + 1);

  return {
    query,
    selected: result.item,
    context: items.slice(start, end),
  };
}

function selectedContextTitle(selection: HistoryPeekSelection): string {
  const query = selection.query.trim();
  return query ? `History Peek · ${query}` : "History Peek · recent";
}

function stripCursorMarker(text: string): string {
  return text.replaceAll(CURSOR_MARKER, "");
}

function padLine(text: string, width: number): string {
  const visible = visibleWidth(stripCursorMarker(text));
  return visible >= width ? text : `${text}${" ".repeat(width - visible)}`;
}

function boxedLine(theme: any, content: string, width: number): string {
  if (width <= 2) return truncateToWidth(content, Math.max(1, width), "", true);

  const innerWidth = width - 2;
  return theme.fg("border", "│") + truncateToWidth(content, innerWidth, "…", true) + theme.fg("border", "│");
}

function topBorder(theme: any, title: string, width: number): string {
  if (width <= 2) return theme.fg("border", "─".repeat(Math.max(1, width)));

  const innerWidth = width - 2;
  const renderedTitle = truncateToWidth(` ${title} `, innerWidth, "…");
  const titleWidth = visibleWidth(renderedTitle);
  const left = "─".repeat(Math.max(0, Math.floor((innerWidth - titleWidth) / 2)));
  const right = "─".repeat(Math.max(0, innerWidth - titleWidth - left.length));
  return theme.fg("border", `╭${left}`) + theme.fg("accent", renderedTitle) + theme.fg("border", `${right}╮`);
}

function separator(theme: any, width: number): string {
  if (width <= 2) return theme.fg("border", "─".repeat(Math.max(1, width)));
  return theme.fg("border", `├${"─".repeat(width - 2)}┤`);
}

function bottomBorder(theme: any, width: number): string {
  if (width <= 2) return theme.fg("border", "─".repeat(Math.max(1, width)));
  return theme.fg("border", `╰${"─".repeat(width - 2)}╯`);
}

class HistoryPeekOverlay implements Component, Focusable {
  private readonly input = new Input();
  private results: HistorySearchResult[] = [];
  private selectedIndex = 0;
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: any,
    private readonly items: HistorySearchItem[],
    private readonly clearPinned: () => void,
    private readonly done: (result: HistoryPeekOverlayResult) => void,
  ) {
    this.input.onSubmit = () => this.confirmSelection();
    this.input.onEscape = () => this.done({ action: "cancel" });
    this.updateResults();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  invalidate(): void {}

  private query(): string {
    return this.input.getValue();
  }

  private updateResults(): void {
    this.results = searchHistoryItems(this.items, this.query());
    if (this.selectedIndex >= this.results.length) {
      this.selectedIndex = Math.max(0, this.results.length - 1);
    }
  }

  private selectedResult(): HistorySearchResult | undefined {
    return this.results[this.selectedIndex];
  }

  private resultWindowStart(): number {
    if (this.results.length <= VISIBLE_RESULT_COUNT) return 0;

    const halfWindow = Math.floor(VISIBLE_RESULT_COUNT / 2);
    const maxStart = Math.max(0, this.results.length - VISIBLE_RESULT_COUNT);
    return Math.min(Math.max(0, this.selectedIndex - halfWindow), maxStart);
  }

  private confirmSelection(): void {
    const selected = this.selectedResult();
    if (!selected) return;

    this.done({
      action: "pin",
      selection: buildSelection(this.items, selected, this.query()),
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("r"))) {
      this.done({ action: "cancel" });
      return;
    }

    if (matchesKey(data, Key.ctrl("q"))) {
      this.clearPinned();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      this.confirmSelection();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(Math.max(0, this.results.length - 1), this.selectedIndex + 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - VISIBLE_RESULT_COUNT);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      this.selectedIndex = Math.min(Math.max(0, this.results.length - 1), this.selectedIndex + VISIBLE_RESULT_COUNT);
      this.tui.requestRender();
      return;
    }

    const before = this.query();
    this.input.handleInput(data);
    if (this.query() !== before) {
      this.updateResults();
    }
    this.tui.requestRender();
  }

  private renderInput(width: number): string {
    const innerWidth = Math.max(1, width - 2);
    const label = this.theme.fg("accent", "Search: ");
    const labelWidth = visibleWidth("Search: ");

    if (width <= labelWidth + 3) {
      return boxedLine(this.theme, this.theme.fg("accent", "Search"), width);
    }

    const inputWidth = Math.max(1, innerWidth - labelWidth);
    const inputLine = this.input.render(inputWidth)[0] ?? "";
    const inputVisibleWidth = visibleWidth(stripCursorMarker(inputLine));
    const paddedInput = inputVisibleWidth < inputWidth
      ? `${inputLine}${" ".repeat(inputWidth - inputVisibleWidth)}`
      : inputLine;

    return this.theme.fg("border", "│") + label + paddedInput + this.theme.fg("border", "│");
  }

  private renderResults(width: number): string[] {
    const lines: string[] = [];

    if (this.results.length === 0) {
      lines.push(boxedLine(this.theme, this.theme.fg("warning", "No matches"), width));
      return lines;
    }

    const windowStart = this.resultWindowStart();
    const visibleResults = this.results.slice(windowStart, windowStart + VISIBLE_RESULT_COUNT);
    for (let index = 0; index < VISIBLE_RESULT_COUNT; index++) {
      const result = visibleResults[index];
      if (!result) {
        lines.push(boxedLine(this.theme, "", width));
        continue;
      }

      const selected = windowStart + index === this.selectedIndex;
      const marker = selected ? "›" : " ";
      const meta = itemMeta(result.item);
      const label = `${marker} ${meta}`;
      const text = selected ? this.theme.fg("accent", label) : label;
      const snippet = highlightMatches(this.theme, result.snippet, this.query(), (segment) => this.theme.fg("dim", segment));
      lines.push(boxedLine(this.theme, `${text} ${snippet}`, width));
    }

    if (this.results.length > VISIBLE_RESULT_COUNT) {
      const hiddenBefore = windowStart;
      const hiddenAfter = Math.max(0, this.results.length - windowStart - VISIBLE_RESULT_COUNT);
      lines.push(boxedLine(this.theme, this.theme.fg("dim", `↑ ${hiddenBefore} more · ↓ ${hiddenAfter} more`), width));
    }

    return lines;
  }

  private renderContext(width: number): string[] {
    const selected = this.selectedResult();
    if (!selected) return [];

    const selection = buildSelection(this.items, selected, this.query());
    const lines = [separator(this.theme, width)];
    lines.push(boxedLine(this.theme, this.theme.fg("accent", "Nearby context"), width));

    for (const item of selection.context) {
      const isSelected = item.id === selection.selected.id;
      const prefix = isSelected ? this.theme.fg("accent", "▶ ") : this.theme.fg("dim", "  ");
      const meta = isSelected ? this.theme.fg("accent", itemMeta(item)) : this.theme.fg("muted", itemMeta(item));
      lines.push(boxedLine(this.theme, `${prefix}${meta}`, width));

      const bodyPrefix = isSelected ? this.theme.fg("accent", "  ") : "  ";
      const bodyWidth = Math.max(1, width - 6);
      const maxBodyLines = isSelected ? OVERLAY_SELECTED_BODY_LINES : OVERLAY_NEIGHBOR_BODY_LINES;
      const baseStyle = isSelected ? (segment: string) => segment : (segment: string) => this.theme.fg("dim", segment);
      const bodyLines = renderBodyLines(this.theme, item.text, this.query(), bodyWidth, maxBodyLines, baseStyle);
      for (const bodyLine of bodyLines) {
        lines.push(boxedLine(this.theme, `${bodyPrefix}${bodyLine}`, width));
      }
    }

    return lines;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const title = this.query().trim() ? `History Peek (${this.results.length})` : "History Peek";
    const lines = [
      topBorder(this.theme, title, safeWidth),
      this.renderInput(safeWidth),
      separator(this.theme, safeWidth),
      ...this.renderResults(safeWidth),
      ...this.renderContext(safeWidth),
      separator(this.theme, safeWidth),
      boxedLine(
        this.theme,
        this.theme.fg("dim", "Type to search · ↑↓ select · Enter pin context · Ctrl+Q clear pinned · Esc cancel"),
        safeWidth,
      ),
      bottomBorder(this.theme, safeWidth),
    ];

    return lines.map((line) => padLine(line, safeWidth));
  }
}

function pushPinnedMessageBlock(
  lines: string[],
  item: HistorySearchItem,
  selection: HistoryPeekSelection,
  theme: any,
  width: number,
  options: { selected?: boolean; marker: string; maxBodyLines: number },
): void {
  const selected = options.selected === true;
  const meta = `${options.marker} ${itemMeta(item)}`;
  lines.push(selected
    ? theme.fg("accent", truncateToWidth(meta, width, "…"))
    : theme.fg("muted", truncateToWidth(meta, width, "…")));

  const bodyWidth = Math.max(1, width - 2);
  const baseStyle = selected ? (segment: string) => segment : (segment: string) => theme.fg("dim", segment);
  const bodyLines = renderBodyLines(theme, item.text, selection.query, bodyWidth, options.maxBodyLines, baseStyle);
  for (const line of bodyLines) {
    lines.push(truncateToWidth(`  ${line}`, width, "…"));
  }
}

function renderPinnedLines(selection: HistoryPeekSelection, theme: any, width: number): string[] {
  const lines: string[] = [];
  const selectedIndex = selection.context.findIndex((item) => item.id === selection.selected.id);
  const before = selectedIndex > 0 ? selection.context[selectedIndex - 1] : undefined;
  const after = selectedIndex >= 0 ? selection.context[selectedIndex + 1] : undefined;

  const footer = theme.fg("dim", truncateToWidth("Ctrl+R search again · Ctrl+Q clears pinned peek", width, "…"));
  lines.push(theme.fg("accent", truncateToWidth(selectedContextTitle(selection), width, "…")));

  if (before) {
    pushPinnedMessageBlock(lines, before, selection, theme, width, {
      marker: "↑",
      maxBodyLines: PINNED_NEIGHBOR_BODY_LINES,
    });
  }

  pushPinnedMessageBlock(lines, selection.selected, selection, theme, width, {
    selected: true,
    marker: "▶",
    maxBodyLines: PINNED_SELECTED_BODY_LINES,
  });

  if (after) {
    pushPinnedMessageBlock(lines, after, selection, theme, width, {
      marker: "↓",
      maxBodyLines: PINNED_NEIGHBOR_BODY_LINES,
    });
  }

  if (lines.length >= PINNED_MAX_LINES) {
    return [...lines.slice(0, PINNED_MAX_LINES - 1), footer];
  }

  lines.push(footer);
  return lines;
}

class PinnedHistoryPeek implements Component {
  constructor(private readonly selection: HistoryPeekSelection, private readonly theme: any) {}

  invalidate(): void {}

  render(width: number): string[] {
    return renderPinnedLines(this.selection, this.theme, Math.max(1, width));
  }
}

export function clearPinnedHistoryPeek(ctx: ExtensionContext): void {
  ctx.ui.setWidget(HISTORY_PEEK_WIDGET_KEY, undefined);
}

function pinHistoryPeek(ctx: ExtensionContext, selection: HistoryPeekSelection): void {
  ctx.ui.setWidget(HISTORY_PEEK_WIDGET_KEY, (_tui: TUI, theme: any) => new PinnedHistoryPeek(selection, theme));
}

export async function openHistoryPeek(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("History Peek is available only in the TUI.", "info");
    return;
  }

  const items = collectHistorySearchItems(ctx);
  if (items.length === 0) {
    ctx.ui.notify("History Peek: no searchable messages in the current branch.", "info");
    return;
  }

  const result = await ctx.ui.custom<HistoryPeekOverlayResult>(
    (tui, theme, _keybindings, done) => new HistoryPeekOverlay(
      tui,
      theme,
      items,
      () => clearPinnedHistoryPeek(ctx),
      done,
    ),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "95%",
        minWidth: 60,
        maxHeight: "90%",
        margin: 1,
      },
    },
  );

  if (result.action === "pin") {
    pinHistoryPeek(ctx, result.selection);
  }
}
