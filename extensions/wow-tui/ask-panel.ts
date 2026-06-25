/**
 * Discuss Ask panel for HLCW structured questions.
 *
 * Visual presentation only. The logic layer parses hidden `<!-- wow-ask:v1 ... -->`
 * metadata and injects this module's opener via setAskPanelTrigger(). This module
 * owns the non-overlay TUI widget and editor-input routing, but never sends
 * messages or mutates workflow state.
 *
 * Interaction model:
 *   ↑/↓             move option cursor; leave inline Other input while preserving text
 *   Space           select the highlighted option; toggles multiple-choice options
 *   Enter           confirm current question and advance
 *   Tab             switch question
 *   Ctrl+Enter      fill editor draft (resolved to logic layer; not auto-sent)
 *   Esc             close panel and return to editor
 *   Other           inline input row; focusing the row allows immediate typing
 *
 * TUI chrome stays English by design; AI-authored question/option text is
 * rendered exactly as received.
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
  type TUI,
} from "@earendil-works/pi-tui";
import {
  countAnsweredAskQuestions,
  formatAskAnswers,
  type AskAnswer,
  type AskAnswers,
  type AskBlock,
} from "../human-led-coding-workflow/ask.ts";
import { getLastAskBlocks } from "../human-led-coding-workflow/index.ts";

const ASK_WIDGET_KEY = "wow.discuss-ask";
const VISIBLE_ITEMS = 7;

interface QuestionState {
  block: AskBlock;
  selected: Set<string>;
  custom: string | undefined;
  skipped: boolean;
}

type PanelMode = "list" | "custom";
type ItemKind = "option" | "other" | "skip" | "submit" | "back";

interface AskItem {
  kind: ItemKind;
  value?: string;
  label: string;
  description?: string;
  inlineInput?: boolean;
}

interface AskSummary {
  blocks: AskBlock[];
  answers: AskAnswers | null;
  cancelled: boolean;
}

let activeController: AskPanelController | null = null;

function stripCursorMarker(text: string): string {
  return text.replaceAll(CURSOR_MARKER, "");
}

function padLine(text: string, width: number): string {
  const visible = visibleWidth(stripCursorMarker(text));
  return visible >= width ? text : `${text}${" ".repeat(width - visible)}`;
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

function boxedLine(theme: any, content: string, width: number): string {
  if (width <= 2) return truncateToWidth(content, Math.max(1, width), "", true);
  const innerWidth = Math.max(1, width - 2);
  return theme.fg("border", "│") + truncateToWidth(content, innerWidth, "…", true) + theme.fg("border", "│");
}

function pushWrappedBoxedLine(
  lines: string[],
  theme: any,
  content: string,
  width: number,
  maxLines = 2,
): void {
  const innerWidth = Math.max(1, width - 2);
  const wrapped = wrapTextWithAnsi(content, innerWidth);
  const visible = wrapped.slice(0, maxLines);
  for (let i = 0; i < visible.length; i++) {
    const suffix = i === maxLines - 1 && wrapped.length > maxLines ? " …" : "";
    lines.push(boxedLine(theme, `${visible[i]}${suffix}`, width));
  }
}

function windowStart(cursor: number, total: number, visible: number): number {
  if (total <= visible) return 0;
  const half = Math.floor(visible / 2);
  const maxStart = Math.max(0, total - visible);
  return Math.min(Math.max(0, cursor - half), maxStart);
}

function isCtrlEnter(data: string): boolean {
  return matchesKey(data, Key.ctrl("enter")) || matchesKey(data, Key.ctrl("return"));
}

function otherEnabled(block: AskBlock): boolean {
  return block.type === "text" || block.other?.enabled !== false;
}

function otherLabel(block: AskBlock): string {
  return block.other?.label?.trim() || "Other";
}

function isDefaultOption(block: AskBlock, optionId: string): boolean {
  return Array.isArray(block.default)
    ? block.default.includes(optionId)
    : block.default === optionId;
}

function answerFor(state: QuestionState): AskAnswer {
  if (state.custom !== undefined) return { kind: "custom", value: state.custom };
  if (state.skipped) return { kind: "skipped" };
  const ordered = state.block.options
    .filter((option) => state.selected.has(option.id))
    .map((option) => option.id);
  return ordered.length > 0 ? { kind: "selected", optionIds: ordered } : { kind: "skipped" };
}

function previewAnswer(state: QuestionState): string {
  if (state.custom !== undefined) return state.custom.trim() ? state.custom.trim() : "(empty custom)";
  if (state.skipped) return "(decide yourself)";
  const ordered = state.block.options
    .filter((option) => state.selected.has(option.id))
    .map((option) => option.label);
  return ordered.length > 0 ? ordered.join("; ") : "(unanswered)";
}

function buildAnswers(states: QuestionState[]): AskAnswers {
  const answers: AskAnswers = {};
  for (const state of states) {
    answers[state.block.id] = answerFor(state);
  }
  return answers;
}

class AskPanelController {
  private readonly states: QuestionState[];
  private readonly customInput = new Input();
  private pageIndex = 0;
  private cursor = 0;
  private mode: PanelMode = "list";
  private requestRender: (() => void) | undefined;
  private done = false;

  constructor(
    private readonly blocks: AskBlock[],
    private readonly finish: (answers: AskAnswers | null, cancelled: boolean) => void,
  ) {
    this.states = blocks.map((block) => {
      const selected = new Set<string>();
      if (Array.isArray(block.default)) {
        block.default.forEach((optionId) => selected.add(optionId));
      } else if (block.default) {
        selected.add(block.default);
      }
      return { block, selected, custom: undefined, skipped: false } satisfies QuestionState;
    });

    this.customInput.onEscape = () => {
      this.mode = "list";
      this.renderSoon();
    };
    this.customInput.onSubmit = (value) => {
      this.saveCustom(value);
      this.advance();
    };

    this.resetCursorForPage();
  }

  attach(tui: TUI): void {
    this.requestRender = () => tui.requestRender();
  }

  detach(): void {
    this.requestRender = undefined;
  }

  private renderSoon(): void {
    this.requestRender?.();
  }

  private get isSummaryPage(): boolean {
    return this.pageIndex >= this.blocks.length;
  }

  private currentState(): QuestionState | undefined {
    return this.isSummaryPage ? undefined : this.states[this.pageIndex];
  }

  private pageTitle(): string {
    if (this.isSummaryPage) return "Discuss Ask · Summary";
    return `Discuss Ask · ${this.pageIndex + 1}/${this.blocks.length}`;
  }

  private setCustomInputValue(value: string): void {
    this.customInput.setValue(value);
    (this.customInput as any).cursor = value.length;
  }

  private resetCursorForPage(): void {
    this.mode = "list";
    this.customInput.focused = false;
    if (this.isSummaryPage) {
      this.cursor = 0;
      return;
    }

    const block = this.blocks[this.pageIndex]!;
    if (block.type === "text") {
      this.mode = "custom";
      this.setCustomInputValue(this.states[this.pageIndex]?.custom ?? "");
      this.customInput.focused = true;
      this.cursor = 0;
      return;
    }
    if (block.type === "single" && typeof block.default === "string") {
      const defaultIndex = block.options.findIndex((option) => option.id === block.default);
      this.cursor = defaultIndex >= 0 ? defaultIndex : 0;
      this.prepareInlineOtherInput();
      return;
    }
    this.cursor = 0;
    this.prepareInlineOtherInput();
  }

  private gotoPage(index: number): void {
    this.persistInlineOtherInput();
    this.pageIndex = Math.max(0, Math.min(this.blocks.length, index));
    this.resetCursorForPage();
    this.renderSoon();
  }

  private advance(): void {
    this.persistInlineOtherInput();
    this.pageIndex = Math.min(this.blocks.length, this.pageIndex + 1);
    this.resetCursorForPage();
    this.renderSoon();
  }

  private submit(): void {
    if (this.done) return;
    this.done = true;
    this.finish(buildAnswers(this.states), false);
  }

  close(cancelled = true): void {
    if (this.done) return;
    this.done = true;
    this.finish(null, cancelled);
  }

  private saveCustom(value: string): void {
    const state = this.currentState();
    if (!state) return;
    state.custom = value;
    state.skipped = false;
    state.selected.clear();
    this.mode = "list";
  }

  private isInlineOtherActive(): boolean {
    if (this.isSummaryPage || this.mode !== "list") return false;
    const item = this.currentItems()[this.cursor];
    return item?.kind === "other";
  }

  private prepareInlineOtherInput(): void {
    if (this.isInlineOtherActive()) {
      const state = this.currentState();
      this.setCustomInputValue(state?.custom ?? "");
      this.customInput.focused = true;
      return;
    }
    if (this.mode !== "custom") this.customInput.focused = false;
  }

  private persistInlineOtherInput(forceCustom = false): void {
    if (!this.isInlineOtherActive()) return;
    const state = this.currentState();
    if (!state) return;

    const value = this.customInput.getValue();
    if (!forceCustom && value.length === 0 && state.custom === undefined) return;
    state.custom = value;
    state.skipped = false;
    state.selected.clear();
  }

  private buildQuestionItems(state: QuestionState): AskItem[] {
    const block = state.block;
    const items: AskItem[] = block.options.map((option) => {
      const selected = state.selected.has(option.id);
      const prefix = block.type === "multiple" ? (selected ? "✓ " : "☐ ") : (selected ? "● " : "○ ");
      return {
        kind: "option",
        value: option.id,
        label: `${prefix}${option.label}`,
        description: isDefaultOption(block, option.id) ? "recommended" : undefined,
      } satisfies AskItem;
    });

    if (otherEnabled(block)) {
      items.push({
        kind: "other",
        label: otherLabel(block),
        description: state.custom?.trim() ? `current: ${state.custom.trim()}` : undefined,
        inlineInput: true,
      });
    }

    items.push({
      kind: "skip",
      label: "Decide yourself",
      description: state.skipped ? "selected" : undefined,
    });
    return items;
  }

  private currentItems(): AskItem[] {
    if (this.isSummaryPage) {
      return [
        { kind: "submit", label: "Fill editor draft", description: "not auto-sent" },
        { kind: "back", label: "Back to questions" },
      ];
    }
    const state = this.currentState();
    return state ? this.buildQuestionItems(state) : [];
  }

  private onItemSelect(item: AskItem): void {
    if (this.isSummaryPage) {
      if (item.kind === "submit") this.submit();
      else if (item.kind === "back") this.gotoPage(0);
      return;
    }

    const state = this.currentState();
    if (!state) return;
    const block = state.block;

    if (item.kind === "other") {
      this.persistInlineOtherInput(true);
      this.advance();
      return;
    }

    if (item.kind === "skip") {
      state.skipped = true;
      state.custom = undefined;
      state.selected.clear();
      this.advance();
      return;
    }

    if (item.kind !== "option" || !item.value) return;

    state.skipped = false;
    state.custom = undefined;
    if (block.type === "multiple") {
      // Enter confirms the current multiple-choice state; Space toggles options.
      this.advance();
      return;
    }

    if (state.selected.size === 0) {
      state.selected.add(item.value);
    }
    this.advance();
  }

  private selectCurrentOption(): void {
    const state = this.currentState();
    if (!state) return;
    const item = this.currentItems()[this.cursor];
    if (!item || item.kind !== "option" || !item.value) return;

    state.skipped = false;
    state.custom = undefined;
    if (state.block.type === "multiple") {
      if (state.selected.has(item.value)) state.selected.delete(item.value);
      else state.selected.add(item.value);
    } else {
      state.selected.clear();
      state.selected.add(item.value);
    }
    this.customInput.focused = false;
    this.renderSoon();
  }

  private moveCursor(delta: number): void {
    const items = this.currentItems();
    const max = Math.max(0, items.length - 1);
    const next = Math.max(0, Math.min(max, this.cursor + delta));
    if (next === this.cursor) return;

    this.persistInlineOtherInput();
    this.cursor = next;
    this.prepareInlineOtherInput();
    this.renderSoon();
  }

  private jumpCursor(delta: number): void {
    const items = this.currentItems();
    const max = Math.max(0, items.length - 1);
    const next = Math.max(0, Math.min(max, this.cursor + delta));
    if (next === this.cursor) return;

    this.persistInlineOtherInput();
    this.cursor = next;
    this.prepareInlineOtherInput();
    this.renderSoon();
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, Key.alt("k"))) return false;

    if (isCtrlEnter(data)) {
      if (this.mode === "custom") this.saveCustom(this.customInput.getValue());
      else this.persistInlineOtherInput();
      this.submit();
      return true;
    }

    if (this.mode === "custom") {
      if (matchesKey(data, Key.escape)) {
        this.mode = "list";
        this.customInput.focused = false;
        this.renderSoon();
        return true;
      }
      const before = this.customInput.getValue();
      this.customInput.handleInput(data);
      if (this.customInput.getValue() !== before) this.renderSoon();
      return true;
    }

    if (matchesKey(data, Key.escape)) {
      this.close(true);
      return true;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.gotoPage(this.pageIndex - 1);
      return true;
    }
    if (matchesKey(data, Key.tab)) {
      this.gotoPage(this.pageIndex + 1);
      return true;
    }

    const items = this.currentItems();
    const inlineOtherActive = this.isInlineOtherActive();

    if (matchesKey(data, Key.up)) {
      this.moveCursor(-1);
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.moveCursor(1);
      return true;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.jumpCursor(-VISIBLE_ITEMS);
      return true;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.jumpCursor(VISIBLE_ITEMS);
      return true;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      const item = items[this.cursor];
      if (item) this.onItemSelect(item);
      return true;
    }

    if (inlineOtherActive) {
      const before = this.customInput.getValue();
      this.customInput.handleInput(data);
      if (this.customInput.getValue() !== before) {
        this.persistInlineOtherInput();
        this.renderSoon();
      }
      return true;
    }

    if (matchesKey(data, Key.left)) {
      this.gotoPage(this.pageIndex - 1);
      return true;
    }
    if (matchesKey(data, Key.right)) {
      this.gotoPage(this.pageIndex + 1);
      return true;
    }
    if (data === " ") {
      this.selectCurrentOption();
      return true;
    }
    if (data === "s") {
      const state = this.currentState();
      if (state) {
        state.skipped = true;
        state.custom = undefined;
        state.selected.clear();
        this.customInput.focused = false;
        this.advance();
      }
      return true;
    }

    // The active panel owns focus; consume unhandled printable keys so they do
    // not leak into the main editor while the human is answering.
    return true;
  }

  render(theme: any, width: number): string[] {
    const safeWidth = Math.max(30, width);
    const lines: string[] = [topBorder(theme, this.pageTitle(), safeWidth)];

    if (this.isSummaryPage) {
      this.renderSummary(theme, safeWidth, lines);
    } else if (this.mode === "custom") {
      this.renderCustom(theme, safeWidth, lines);
    } else {
      this.renderQuestion(theme, safeWidth, lines);
    }

    lines.push(bottomBorder(theme, safeWidth));
    return lines.map((line) => padLine(line, safeWidth));
  }

  private renderQuestion(theme: any, width: number, lines: string[]): void {
    const state = this.currentState();
    if (!state) return;
    const block = state.block;

    pushWrappedBoxedLine(lines, theme, theme.fg("text", block.question), width, 2);
    if (block.hint) pushWrappedBoxedLine(lines, theme, theme.fg("dim", `Hint: ${block.hint}`), width, 1);
    if (block.type === "multiple") {
      lines.push(boxedLine(theme, theme.fg("dim", "Multiple choice — Space toggles options; Enter confirms."), width));
    } else if (block.type === "single") {
      lines.push(boxedLine(theme, theme.fg("dim", "Single choice — Space selects; Enter confirms."), width));
    }
    lines.push(separator(theme, width));

    const items = this.currentItems();
    if (this.cursor >= items.length) this.cursor = Math.max(0, items.length - 1);
    this.renderItems(theme, width, lines, items);

    lines.push(separator(theme, width));
    lines.push(boxedLine(
      theme,
      theme.fg("dim", "↑/↓ select · Space choose/toggle · Enter confirm · Tab switch · Ctrl+Enter fill draft · Esc close"),
      width,
    ));
  }

  private renderCustom(theme: any, width: number, lines: string[]): void {
    const state = this.currentState();
    if (!state) return;
    const block = state.block;

    pushWrappedBoxedLine(lines, theme, theme.fg("text", block.question), width, 2);
    lines.push(boxedLine(theme, theme.fg("accent", otherLabel(block)), width));
    lines.push(separator(theme, width));

    this.customInput.focused = true;
    const placeholder = block.other?.placeholder?.trim();
    const rawInput = this.customInput.getValue();
    const inputLines = this.customInput.render(Math.max(1, width - 4));
    const renderedInput = rawInput || !placeholder
      ? inputLines[0] ?? ""
      : theme.fg("dim", placeholder);
    lines.push(boxedLine(theme, `  ${renderedInput}`, width));

    lines.push(separator(theme, width));
    lines.push(boxedLine(theme, theme.fg("dim", "Enter confirm · Ctrl+Enter fill draft · Esc back to options"), width));
  }

  private renderSummary(theme: any, width: number, lines: string[]): void {
    lines.push(boxedLine(theme, theme.fg("dim", "Unanswered questions will be left for the AI to decide."), width));
    lines.push(separator(theme, width));

    for (const state of this.states.slice(0, VISIBLE_ITEMS)) {
      const preview = previewAnswer(state);
      lines.push(boxedLine(theme, theme.fg("muted", "• ") + theme.fg("text", preview), width));
    }
    if (this.states.length > VISIBLE_ITEMS) {
      lines.push(boxedLine(theme, theme.fg("dim", `… ${this.states.length - VISIBLE_ITEMS} more`), width));
    }

    lines.push(separator(theme, width));
    const items = this.currentItems();
    if (this.cursor >= items.length) this.cursor = Math.max(0, items.length - 1);
    this.renderItems(theme, width, lines, items);
    lines.push(separator(theme, width));
    lines.push(boxedLine(theme, theme.fg("dim", "Enter select · Ctrl+Enter fill draft · Esc close"), width));
  }

  private renderItems(theme: any, width: number, lines: string[], items: AskItem[]): void {
    if (items.length === 0) {
      lines.push(boxedLine(theme, theme.fg("warning", "(no items)"), width));
      return;
    }

    const start = windowStart(this.cursor, items.length, VISIBLE_ITEMS);
    const visible = items.slice(start, start + VISIBLE_ITEMS);
    for (let i = 0; i < visible.length; i++) {
      const itemIndex = start + i;
      const item = visible[i]!;
      const selected = itemIndex === this.cursor;
      const marker = selected ? "›" : " ";
      let body: string;

      if (selected && item.kind === "other" && item.inlineInput) {
        this.customInput.focused = true;
        const label = `${marker} ${item.label}: `;
        const placeholder = this.currentState()?.block.other?.placeholder?.trim();
        const inputWidth = Math.max(8, width - visibleWidth(stripCursorMarker(label)) - 4);
        const inputLine = (this.customInput.render(inputWidth)[0] ?? "").trimEnd();
        const placeholderHint = !this.customInput.getValue().trim() && placeholder
          ? ` ${theme.fg("dim", placeholder)}`
          : "";
        body = `${label}${inputLine}${placeholderHint}`;
      } else {
        const desc = item.description ? ` ${theme.fg("dim", `(${item.description})`)}` : "";
        body = `${marker} ${item.label}${desc}`;
      }

      lines.push(boxedLine(theme, selected ? theme.fg("accent", body) : body, width));
    }

    if (items.length > VISIBLE_ITEMS) {
      const hiddenBefore = start;
      const hiddenAfter = Math.max(0, items.length - start - VISIBLE_ITEMS);
      lines.push(boxedLine(theme, theme.fg("dim", `↑ ${hiddenBefore} more · ↓ ${hiddenAfter} more`), width));
    }
  }
}

class AskPanelWidget implements Component {
  constructor(
    private readonly controller: AskPanelController,
    tui: TUI,
    private readonly theme: any,
  ) {
    controller.attach(tui);
  }

  invalidate(): void {}

  dispose(): void {
    this.controller.detach();
  }

  render(width: number): string[] {
    return this.controller.render(this.theme, Math.max(1, width));
  }
}

class AskSummaryWidget implements Component {
  constructor(private readonly summary: AskSummary, private readonly theme: any) {}

  invalidate(): void {}

  render(width: number): string[] {
    const total = this.summary.blocks.length;
    const answered = this.summary.answers
      ? countAnsweredAskQuestions(this.summary.blocks, this.summary.answers)
      : 0;
    const status = this.summary.cancelled
      ? `${total} questions · cancelled`
      : `${answered}/${total} questions answered`;
    return [
      truncateToWidth(
        this.theme.fg("accent", "Discuss Ask") +
          this.theme.fg("dim", ` · ${status} · Alt+K reopen`),
        Math.max(1, width),
        "…",
        true,
      ),
    ];
  }
}

function showSummaryWidget(ctx: ExtensionContext, blocks: AskBlock[], answers: AskAnswers | null, cancelled: boolean): void {
  const summary = { blocks, answers, cancelled } satisfies AskSummary;
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(
    ASK_WIDGET_KEY,
    (_tui: TUI, theme: any) => new AskSummaryWidget(summary, theme),
    { placement: "aboveEditor" },
  );
}

function clearActivePanel(): void {
  activeController = null;
}

/** Route prompt-editor input to the active ask widget. */
export function handleAskPanelInput(data: string): boolean {
  return activeController?.handleInput(data) ?? false;
}

export function clearAskPanelWidget(ctx: ExtensionContext): void {
  clearActivePanel();
  if (ctx.hasUI) ctx.ui.setWidget(ASK_WIDGET_KEY, undefined);
}

/** Fallback for non-TUI modes: linear select/input per question. */
async function fallbackSelect(ctx: ExtensionContext, blocks: AskBlock[]): Promise<AskAnswers | null> {
  const answers: AskAnswers = {};
  for (const block of blocks) {
    if (block.type === "text" || block.options.length === 0) {
      const value = await ctx.ui.input(block.question, block.other?.placeholder);
      answers[block.id] = value?.trim() ? { kind: "custom", value } : { kind: "skipped" };
      continue;
    }

    const other = otherEnabled(block) ? otherLabel(block) : undefined;
    const labels = [...block.options.map((option) => option.label), ...(other ? [other] : [])];
    const picked = await ctx.ui.select(block.question, labels);
    if (!picked) {
      answers[block.id] = { kind: "skipped" };
      continue;
    }

    if (other && picked === other) {
      const value = await ctx.ui.input(block.question, block.other?.placeholder);
      answers[block.id] = value?.trim() ? { kind: "custom", value } : { kind: "skipped" };
      continue;
    }

    const option = block.options.find((candidate) => candidate.label === picked);
    answers[block.id] = option ? { kind: "selected", optionIds: [option.id] } : { kind: "skipped" };
  }
  return answers;
}

/**
 * Open the non-overlay ask panel widget. Returns answers when the human fills the
 * editor draft, or null when the panel is cancelled/unavailable.
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

  activeController?.close(false);

  return await new Promise<AskAnswers | null>((resolve) => {
    const controller = new AskPanelController(blocks, (answers, cancelled) => {
      if (activeController === controller) clearActivePanel();
      showSummaryWidget(ctx, blocks, answers, cancelled);
      resolve(answers);
    });

    activeController = controller;
    ctx.ui.setWidget(
      ASK_WIDGET_KEY,
      (tui: TUI, theme: any) => new AskPanelWidget(controller, tui, theme),
      { placement: "aboveEditor" },
    );
  });
}

/**
 * Reopen the most recent assistant ask question batch (Alt+K in the editor).
 * Reopened panels start fresh; previous selections are not retained.
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

  const blocks = getLastAskBlocks(ctx);
  if (blocks.length === 0) {
    ctx.ui.notify("No recent discuss questions to reopen.", "info");
    return;
  }

  const answers = await openAskPanel(ctx, blocks);
  if (!answers) return;
  try {
    ctx.ui.setEditorText(`? ${formatAskAnswers(blocks, answers)}`);
  } catch {
    // UI may have been torn down; non-fatal.
  }
}
