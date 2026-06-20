/**
 * Ask panel overlay for discuss-mode structured questions.
 *
 * Visual presentation only. The logic layer (human-led-coding-workflow/ask.ts)
 * parses `:::ask` blocks, calls the injected trigger (this module's openAskPanel),
 * and fills the returned answers into the editor. This module never sends
 * messages or mutates workflow state.
 *
 * Visual style mirrors history-peek.ts: hand-drawn rounded borders (╭─╮ ├─┤ ╰─╯),
 * accent-colored title embedded in the top border, border-color frame, dim/accent
 * inner text. The option list is self-drawn (cursor marker ›, accent highlight,
 * boxedLine per row) rather than SelectList, because SelectList relies on the
 * TUI focus stack which breaks when embedded in an overlay; self-drawing keeps
 * ↑/↓ working and every row safely within the borders. All visible text is
 * English to match the history-peek baseline.
 *
 * Interaction model (N questions → N+1 screens):
 *   Screen 1..N  one question per screen
 *   Screen N+1   summary + "Submit all answers" item
 *   ↑/↓          move cursor (defaults pre-positioned; Enter adopts)
 *   Enter        confirm current item (single-choice) / submit current state
 *   Space        multiple-choice: toggle option (defaults pre-checked)
 *   ←/→          switch screens (answers persist across switches)
 *   c            open custom free-text input (when allowCustom)
 *   s            skip current question
 *   Esc          cancel the whole panel (returns null)
 *
 * The summary screen is the ONLY place submission happens. Unanswered questions
 * are treated as skipped and may still be submitted.
 *
 * Reopen: Alt+K in the editor reopens the most recent discuss question batch
 * (see reopenAskPanel). Reopened panels start fresh; previous selections are
 * not retained.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AskAnswer, AskAnswers, AskBlock } from "../human-led-coding-workflow/ask.ts";
import { getLastAskBlocks } from "../human-led-coding-workflow/index.ts";

interface PanelResult {
  answers: AskAnswers | null;
}

interface QuestionState {
  block: AskBlock;
  /** Multiple-choice: set of checked labels. */
  checked: Set<string>;
  /** Cursor (selected) label for single-choice. */
  singleChoice: string | undefined;
  custom: string | undefined;
  skipped: boolean;
}

type SubMode = "list" | "custom";

/** A self-drawn selectable row. */
interface AskItem {
  value: string;
  label: string;
  description?: string;
}

const CUSTOM_ITEM_VALUE = "__custom__";
const SKIP_ITEM_VALUE = "__skip__";
const SUBMIT_ITEM_VALUE = "__submit__";
const BACK_ITEM_VALUE = "__back__";

/** Max option rows rendered before showing ↑ N more · ↓ N more. */
const VISIBLE_ITEMS = 8;

// ── Hand-drawn borders, mirroring history-peek.ts ──

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

function boxedLine(theme: any, content: string, width: number): string {
  if (width <= 2) return truncateToWidth(content, Math.max(1, width), "", true);
  const innerWidth = width - 2;
  return theme.fg("border", "│") + truncateToWidth(content, innerWidth, "…", true) + theme.fg("border", "│");
}

function padLine(text: string, width: number): string {
  const visible = visibleWidth(text);
  return visible >= width ? text : `${text}${" ".repeat(width - visible)}`;
}

/** Compute the scrolling window start so the cursor stays centered-ish. */
function windowStart(cursor: number, total: number, visible: number): number {
  if (total <= visible) return 0;
  const half = Math.floor(visible / 2);
  const maxStart = Math.max(0, total - visible);
  return Math.min(Math.max(0, cursor - half), maxStart);
}

// ── Answer helpers ──

function answerFor(state: QuestionState): AskAnswer {
  if (state.custom !== undefined) return { kind: "custom", value: state.custom };
  if (state.skipped) return { kind: "skipped" };
  const block = state.block;
  if (block.multiple) {
    const values = block.options
      .filter((opt) => state.checked.has(opt.label))
      .map((opt) => opt.label);
    return { kind: "selected", values };
  }
  if (state.singleChoice !== undefined) {
    return { kind: "selected", values: [state.singleChoice] };
  }
  return { kind: "skipped" };
}

function previewAnswer(state: QuestionState): string {
  if (state.custom !== undefined) return state.custom.trim() ? state.custom.trim() : "(empty custom)";
  if (state.skipped) return "(skipped)";
  const block = state.block;
  if (block.multiple) {
    const values = block.options.filter((opt) => state.checked.has(opt.label)).map((opt) => opt.label);
    return values.length > 0 ? values.join("; ") : "(unanswered)";
  }
  if (state.singleChoice !== undefined) return state.singleChoice;
  return "(unanswered)";
}

class AskPagedPanel implements Component, Focusable {
  private readonly blocks: AskBlock[];
  private readonly states: QuestionState[];
  private readonly done: (result: PanelResult) => void;
  private readonly tui: TUI;
  private readonly theme: any;

  private pageIndex = 0;
  private subMode: SubMode = "list";
  /** Cursor index within the current page's items list. */
  private cursor = 0;
  /** Items rendered on the current page; set during render, read by handleInput. */
  private currentItems: AskItem[] = [];

  private customInput = new Input();

  constructor(
    tui: TUI,
    theme: any,
    blocks: AskBlock[],
    done: (result: PanelResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.blocks = blocks;
    this.done = done;

    this.states = blocks.map((block) => {
      const checked = new Set<string>();
      let singleChoice: string | undefined;
      block.options.forEach((opt) => {
        if (opt.default) {
          if (block.multiple) checked.add(opt.label);
          else singleChoice = opt.label;
        }
      });
      if (!block.multiple && singleChoice === undefined && block.options.length > 0) {
        singleChoice = block.options[0]!.label;
      }
      return { block, checked, singleChoice, custom: undefined, skipped: false };
    });

    this.customInput.onEscape = () => { this.subMode = "list"; this.tui.requestRender(); };
    // Position cursor on the default option of the first question.
    this.resetCursorForPage();
  }

  get focused(): boolean {
    return true;
  }
  set focused(_value: boolean) {
    // Overlay owns focus while shown.
  }

  invalidate(): void {}

  private get isSummaryPage(): boolean {
    return this.pageIndex >= this.blocks.length;
  }

  private finish(answers: AskAnswers | null): void {
    this.done({ answers });
  }

  private pageTitle(): string {
    const total = this.blocks.length;
    if (this.isSummaryPage) return `Discuss Ask · Summary`;
    return `Discuss Question ${this.pageIndex + 1}/${total}`;
  }

  /** Position the cursor on the recommended option (single-choice) or 0 otherwise. */
  private resetCursorForPage(): void {
    if (this.isSummaryPage) {
      this.cursor = 0;
      return;
    }
    const block = this.blocks[this.pageIndex]!;
    const defaultIdx = block.multiple ? -1 : block.options.findIndex((opt) => opt.default);
    // Account for items layout: [options..., (custom?), skip]. Default sits among options.
    this.cursor = defaultIdx >= 0 ? defaultIdx : 0;
  }

  /** Render the full panel as lines, wrapped in hand-drawn borders. */
  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const lines: string[] = [topBorder(this.theme, this.pageTitle(), safeWidth)];

    if (this.isSummaryPage) {
      lines.push(...this.renderSummaryBody(safeWidth));
    } else {
      lines.push(...this.renderQuestionBody(safeWidth));
    }

    lines.push(bottomBorder(this.theme, safeWidth));
    return lines.map((line) => padLine(line, safeWidth));
  }

  /** Build the items list for the current question page. */
  private buildQuestionItems(state: QuestionState): AskItem[] {
    const block = state.block;
    const items: AskItem[] = block.options.map((opt) => {
      const prefix = block.multiple ? (state.checked.has(opt.label) ? "✓ " : "☐ ") : "";
      const desc = opt.default ? "recommended" : undefined;
      return { value: opt.label, label: `${prefix}${opt.label}`, description: desc };
    });
    if (block.allowCustom) {
      items.push({
        value: CUSTOM_ITEM_VALUE,
        label: "+ Custom answer...",
        description: state.custom !== undefined ? `current: ${state.custom}` : undefined,
      });
    }
    items.push({
      value: SKIP_ITEM_VALUE,
      label: "→ Skip this question",
      description: state.skipped ? "skipped" : undefined,
    });
    return items;
  }

  private renderQuestionBody(width: number): string[] {
    const state = this.states[this.pageIndex]!;
    const block = state.block;
    const lines: string[] = [];

    if (block.question) {
      lines.push(boxedLine(this.theme, this.theme.fg("text", block.question), width));
    }

    if (this.subMode === "custom") {
      return [...lines, ...this.renderCustomBody(width, state)];
    }

    if (block.hint) {
      lines.push(boxedLine(this.theme, this.theme.fg("dim", `Hint: ${block.hint}`), width));
    }
    if (block.multiple) {
      lines.push(boxedLine(this.theme, this.theme.fg("dim", "(multiple choice — Space toggles, Enter confirms)"), width));
    }
    lines.push(separator(this.theme, width));

    const items = this.buildQuestionItems(state);
    this.currentItems = items;
    // Clamp cursor into range (handles option count changes from toggles).
    if (this.cursor >= items.length) this.cursor = Math.max(0, items.length - 1);
    lines.push(...this.renderItems(width, items));

    lines.push(separator(this.theme, width));
    lines.push(boxedLine(this.theme, this.theme.fg("dim", this.questionFooter(block)), width));
    return lines;
  }

  private renderCustomBody(width: number, state: QuestionState): string[] {
    this.customInput.setValue(state.custom ?? "");
    const lines: string[] = [
      boxedLine(this.theme, this.theme.fg("accent", "Custom answer:"), width),
      separator(this.theme, width),
    ];
    const inputLines = this.customInput.render(Math.max(1, width - 2));
    for (const l of inputLines) {
      lines.push(this.theme.fg("border", "│") + l + this.theme.fg("border", "│"));
    }
    lines.push(separator(this.theme, width));
    lines.push(boxedLine(this.theme, this.theme.fg("dim", "Enter submit · Esc back to options"), width));
    this.customInput.onSubmit = (value) => {
      state.custom = value;
      state.skipped = false;
      state.checked.clear();
      state.singleChoice = undefined;
      this.subMode = "list";
      this.advance();
    };
    return lines;
  }

  private renderSummaryBody(width: number): string[] {
    const lines: string[] = [
      boxedLine(this.theme, this.theme.fg("dim", "Unanswered questions are submitted as skipped; the AI decides itself."), width),
      separator(this.theme, width),
    ];

    for (const state of this.states) {
      const preview = previewAnswer(state);
      lines.push(boxedLine(this.theme, this.theme.fg("muted", `${state.block.id}: `) + this.theme.fg("text", preview), width));
    }

    lines.push(separator(this.theme, width));
    const items: AskItem[] = [
      { value: SUBMIT_ITEM_VALUE, label: "✓ Submit all answers", description: "Fill editor (not auto-sent)" },
      { value: BACK_ITEM_VALUE, label: "← Back to edit", description: "Return to first question" },
    ];
    this.currentItems = items;
    if (this.cursor >= items.length) this.cursor = 0;
    lines.push(...this.renderItems(width, items));

    lines.push(separator(this.theme, width));
    lines.push(boxedLine(this.theme, this.theme.fg("dim", "↑/↓ navigate · Enter confirm · Esc cancel all"), width));
    return lines;
  }

  /**
   * Render a scrollable, self-drawn item list with a cursor marker (›) and
   * accent highlight on the selected row. Each row is boxed so content never
   * overflows the borders.
   */
  private renderItems(width: number, items: AskItem[]): string[] {
    const lines: string[] = [];
    if (items.length === 0) {
      lines.push(boxedLine(this.theme, this.theme.fg("warning", "(no items)"), width));
      return lines;
    }

    const start = windowStart(this.cursor, items.length, VISIBLE_ITEMS);
    const visible = items.slice(start, start + VISIBLE_ITEMS);
    for (let i = 0; i < visible.length; i++) {
      const itemIndex = start + i;
      const item = visible[i]!;
      const selected = itemIndex === this.cursor;
      const marker = selected ? "›" : " ";
      const descSuffix = item.description ? ` ${this.theme.fg("dim", `(${item.description})`)}` : "";
      const body = `${marker} ${item.label}${descSuffix}`;
      const content = selected ? this.theme.fg("accent", body) : body;
      lines.push(boxedLine(this.theme, content, width));
    }

    if (items.length > VISIBLE_ITEMS) {
      const hiddenBefore = start;
      const hiddenAfter = Math.max(0, items.length - start - VISIBLE_ITEMS);
      lines.push(boxedLine(this.theme, this.theme.fg("dim", `↑ ${hiddenBefore} more · ↓ ${hiddenAfter} more`), width));
    }

    return lines;
  }

  private questionFooter(block: AskBlock): string {
    const parts = ["↑/↓ navigate", "←/→ switch question"];
    if (block.multiple) parts.push("Space toggle");
    if (block.allowCustom) parts.push("c custom");
    parts.push("s skip", "Esc cancel all");
    return parts.join(" · ");
  }

  private advance(): void {
    this.pageIndex = Math.min(this.pageIndex + 1, this.blocks.length);
    this.resetCursorForPage();
    this.tui.requestRender();
  }

  private gotoPage(index: number): void {
    this.pageIndex = Math.max(0, Math.min(this.blocks.length, index));
    this.resetCursorForPage();
    this.tui.requestRender();
  }

  private onItemSelect(item: AskItem): void {
    if (this.subMode === "custom") return;
    if (this.isSummaryPage) {
      if (item.value === SUBMIT_ITEM_VALUE) {
        const answers: AskAnswers = {};
        this.states.forEach((state) => { answers[state.block.id] = answerFor(state); });
        this.finish(answers);
      } else if (item.value === BACK_ITEM_VALUE) {
        this.gotoPage(0);
      }
      return;
    }

    const state = this.states[this.pageIndex]!;
    const block = state.block;

    if (item.value === CUSTOM_ITEM_VALUE) {
      this.subMode = "custom";
      this.tui.requestRender();
      return;
    }
    if (item.value === SKIP_ITEM_VALUE) {
      state.skipped = true;
      state.custom = undefined;
      state.checked.clear();
      state.singleChoice = undefined;
      this.advance();
      return;
    }

    state.skipped = false;
    state.custom = undefined;
    if (block.multiple) {
      if (state.checked.has(item.value)) state.checked.delete(item.value);
      else state.checked.add(item.value);
      this.tui.requestRender();
      return;
    }
    state.singleChoice = item.value;
    this.advance();
  }

  handleInput(data: string): void {
    if (this.subMode === "custom") {
      if (matchesKey(data, Key.escape)) {
        this.subMode = "list";
        this.tui.requestRender();
        return;
      }
      const before = this.customInput.getValue();
      this.customInput.handleInput(data);
      if (this.customInput.getValue() !== before) this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.finish(null);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.gotoPage(this.pageIndex - 1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.gotoPage(this.pageIndex + 1);
      return;
    }

    const items = this.currentItems;
    const max = Math.max(0, items.length - 1);

    if (matchesKey(data, Key.up)) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.cursor = Math.min(max, this.cursor + 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.cursor = Math.max(0, this.cursor - VISIBLE_ITEMS);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.cursor = Math.min(max, this.cursor + VISIBLE_ITEMS);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      const item = items[this.cursor];
      if (item) this.onItemSelect(item);
      return;
    }

    if (!this.isSummaryPage) {
      const state = this.states[this.pageIndex]!;
      const block = state.block;
      if (data === " " && block.multiple) {
        // Toggle the option under the cursor (skip the skip/custom meta items).
        const item = items[this.cursor];
        if (item && item.value !== CUSTOM_ITEM_VALUE && item.value !== SKIP_ITEM_VALUE) {
          if (state.checked.has(item.value)) state.checked.delete(item.value);
          else state.checked.add(item.value);
          this.tui.requestRender();
        }
        return;
      }
      if (data === "s") {
        state.skipped = true;
        state.custom = undefined;
        state.checked.clear();
        state.singleChoice = undefined;
        this.advance();
        return;
      }
      if (data === "c" && block.allowCustom) {
        this.subMode = "custom";
        this.tui.requestRender();
        return;
      }
    }
  }
}

/** Fallback for non-TUI modes: linear select per question. */
async function fallbackSelect(ctx: ExtensionContext, blocks: AskBlock[]): Promise<AskAnswers | null> {
  const answers: AskAnswers = {};
  for (const block of blocks) {
    const labels = block.options.map((o) => o.label);
    const picked = await ctx.ui.select(block.question ?? block.id, labels);
    answers[block.id] = picked === undefined
      ? { kind: "skipped" }
      : { kind: "selected", values: [picked] };
  }
  return answers;
}

/**
 * Open the ask panel overlay for the given blocks. Returns answers, or null if
 * cancelled or unavailable.
 */
export async function openAskPanel(
  ctx: ExtensionContext,
  blocks: AskBlock[],
): Promise<AskAnswers | null> {
  if (blocks.length === 0) return null;

  if (ctx.mode !== "tui" || !ctx.hasUI) {
    if (!ctx.hasUI) return null;
    return fallbackSelect(ctx, blocks);
  }

  const result = await ctx.ui.custom<PanelResult>(
    (tui, theme, _kb, done) => new AskPagedPanel(tui, theme, blocks, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        minWidth: 50,
        maxHeight: "80%",
        margin: 1,
      },
    },
  );

  return result?.answers ?? null;
}

/**
 * Reopen the most recent discuss question batch (Alt+K in the editor).
 * Reads cached blocks from the logic layer. Reopened panels start fresh.
 */
export async function reopenAskPanel(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("Discuss Ask is available only in the TUI.", "info");
    return;
  }
  if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
    ctx.ui.notify("Discuss Ask: wait for the agent to finish first.", "info");
    return;
  }

  const blocks = getLastAskBlocks();
  if (blocks.length === 0) {
    ctx.ui.notify("No recent discuss questions to reopen.", "info");
    return;
  }

  ctx.ui.notify("Reopened — previous selections were not kept.", "info");
  const answers = await openAskPanel(ctx, blocks);
  if (!answers) return;
  try {
    ctx.ui.setEditorText(`? ${formatAnswersFromBlocks(blocks, answers)}`);
  } catch {
    // UI may have been torn down; non-fatal.
  }
}

// Local formatter mirror (avoids importing formatAskAnswers to keep this module
// decoupled from the logic layer's answer formatter; identical output shape).
function formatAnswersFromBlocks(blocks: AskBlock[], answers: AskAnswers): string {
  const lines = ["[Discuss answers]"];
  for (const block of blocks) {
    const answer = answers[block.id];
    let value: string;
    if (!answer) {
      value = "(skipped — 你自行判断决定)";
    } else if (answer.kind === "selected") {
      value = answer.values.length > 0 ? answer.values.join("; ") : "(none selected)";
    } else if (answer.kind === "custom") {
      value = answer.value.trim() ? answer.value.trim() : "(empty custom)";
    } else {
      value = "(skipped — 你自行判断决定)";
    }
    lines.push(`- ${block.id}: ${value}`);
  }
  return lines.join("\n");
}
