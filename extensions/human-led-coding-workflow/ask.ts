/**
 * Structured ask blocks for discuss mode.
 *
 * AI emits `:::ask ... :::` fenced blocks in its discuss reply. This module
 * parses them into typed data, and formats the user's answers back into a
 * prompt-friendly text that is filled into the editor (the human sends it).
 *
 * Logic/visual boundary: this module is pure logic + a globalThis-backed trigger
 * singleton (mirrors wow/tips.ts). The visual layer (wow-tui/ask-panel.ts) injects
 * the panel opener via setAskPanelTrigger() at session_start; this logic extension
 * reads it via getAskPanelTrigger() in agent_end. No TUI runtime import here.
 */

// ── Types ──

export interface AskOption {
  /** Stable label text exactly as the AI wrote it (after the checkbox). */
  label: string;
  /** Whether this option is the AI's recommended default. */
  default: boolean;
}

export interface AskBlock {
  /** Stable id within one reply, used as the answer key. */
  id: string;
  question?: string;
  hint?: string;
  /** Allow multiple selections. Defaults to false. */
  multiple: boolean;
  /** Allow free-text custom answer. Defaults to true. */
  allowCustom: boolean;
  options: AskOption[];
}

export type AskAnswer =
  | { kind: "selected"; values: string[] }
  | { kind: "custom"; value: string }
  | { kind: "skipped" };

/** Map of ask block id → user's answer. */
export type AskAnswers = Record<string, AskAnswer>;

// ── Parsing ──

const HEADER_TOKEN_RE = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;

const ASK_OPEN_RE = /^\s*:::ask\b(.*)$/;
const FENCE_RE = /^\s*```/;
const CLOSE_RE = /^\s*:::\s*$/;

/**
 * Parse the header line of an `:::ask` block.
 * Recognized keys: id (required), multiple, allowCustom.
 * Returns null when `id` is missing.
 */
function parseHeader(header: string): { id?: string; multiple?: boolean; allowCustom?: boolean } {
  const result: { id?: string; multiple?: boolean; allowCustom?: boolean } = {};
  let match: RegExpExecArray | null;
  HEADER_TOKEN_RE.lastIndex = 0;
  while ((match = HEADER_TOKEN_RE.exec(header)) !== null) {
    const key = match[1]!.toLowerCase();
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    if (key === "id") {
      const trimmed = raw.trim();
      if (trimmed) result.id = trimmed;
    } else if (key === "multiple") {
      result.multiple = raw.toLowerCase() === "true";
    } else if (key === "allowcustom") {
      result.allowCustom = raw.toLowerCase() === "true";
    }
  }
  return result;
}

function parseBodyLine(line: string): AskOption | null {
  // Match "- [x] label" or "- [ ] label", case-insensitive on x.
  const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/.exec(line);
  if (!m) return null;
  const checked = m[1]!.toLowerCase() === "x";
  const label = m[2]!.trim();
  if (!label) return null;
  return { label, default: checked };
}

/**
 * Collect valid `:::ask` blocks from assistant text.
 *
 * Tolerant of common AI format drift: a block may be closed by any of
 *   (a) a line containing only `:::` (canonical),
 *   (b) a markdown code-fence line (when the AI wrapped the block in a fence),
 *   (c) the start of the next `:::ask` block,
 *   (d) end of text (catches blocks that never got an explicit closer).
 * Leading whitespace on every line is tolerated (the AI often indents the block).
 * Invalid/malformed blocks are silently skipped so they fall back to plain text.
 */
export function collectAskBlocks(text: string): AskBlock[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const blocks: AskBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const openMatch = ASK_OPEN_RE.exec(lines[i]!);
    if (!openMatch) { i++; continue; }

    const headerLine = openMatch[1] ?? "";
    const header = parseHeader(headerLine);
    if (!header.id) { i++; continue; }

    const body: string[] = [];
    i++;
    while (i < lines.length) {
      const raw = lines[i]!;
      // (a) canonical `:::` closer
      if (CLOSE_RE.test(raw)) { i++; break; }
      // (b) markdown code-fence closer (AI wrapped the block in a fence)
      if (FENCE_RE.test(raw)) { i++; break; }
      // (c) next ask block starts → close current, stay on this line for outer loop
      if (ASK_OPEN_RE.test(raw)) { break; }
      body.push(raw);
      i++;
    }
    // (d) implicit close at end of text — body is whatever we gathered.

    const block: AskBlock = {
      id: header.id,
      multiple: header.multiple ?? false,
      allowCustom: header.allowCustom ?? true,
      options: [],
    };

    let sawMeaningful = false;
    for (const line of body) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const q = /^question:\s*(.+?)\s*$/i.exec(trimmed);
      if (q) { block.question = q[1]!.trim(); sawMeaningful = true; continue; }
      const h = /^hint:\s*(.+?)\s*$/i.exec(trimmed);
      if (h) { block.hint = h[1]!.trim(); sawMeaningful = true; continue; }
      const opt = parseBodyLine(trimmed);
      if (opt) { block.options.push(opt); sawMeaningful = true; continue; }
      // Unknown line — ignore (tolerant).
    }

    // Drop a block only if it has neither options nor question/hint (pure noise).
    if (sawMeaningful) blocks.push(block);
  }
  return blocks;
}

// ── Formatting ──

/**
 * Format answers into the text filled into the editor (without the `?` prefix;
 * the caller prepends `? ` so the message routes through the normal input flow).
 *
 * Skipped items are surfaced explicitly so the AI knows it should decide itself.
 */
export function formatAskAnswers(answers: AskAnswers): string {
  const lines = ["[Discuss answers]"];
  for (const [id, answer] of Object.entries(answers)) {
    let value: string;
    if (answer.kind === "selected") {
      value = answer.values.length > 0 ? answer.values.join("; ") : "(none selected)";
    } else if (answer.kind === "custom") {
      value = answer.value.trim() ? answer.value.trim() : "(empty custom)";
    } else {
      value = "(skipped — 你自行判断决定)";
    }
    lines.push(`- ${id}: ${value}`);
  }
  return lines.join("\n");
}

// ── Trigger singleton (logic ↔ visual bridge) ──

/** Opens the ask panel for the given blocks. Returns answers, or null if cancelled. */
export type AskPanelTrigger = (
  ctx: { hasUI: boolean; mode: string; ui: any },
  blocks: AskBlock[],
) => Promise<AskAnswers | null>;

const ASK_TRIGGER_KEY = Symbol.for("wow.hlcw.askTrigger");
let injectedTrigger: AskPanelTrigger | null = null;

export function setAskPanelTrigger(fn: AskPanelTrigger | null): void {
  injectedTrigger = fn;
  (globalThis as any)[ASK_TRIGGER_KEY] = fn;
}

export function getAskPanelTrigger(): AskPanelTrigger | null {
  if (injectedTrigger) return injectedTrigger;
  const fromGlobal = (globalThis as any)[ASK_TRIGGER_KEY];
  if (typeof fromGlobal === "function") {
    injectedTrigger = fromGlobal as AskPanelTrigger;
    return injectedTrigger;
  }
  return null;
}

export function clearAskPanelTrigger(): void {
  injectedTrigger = null;
  delete (globalThis as any)[ASK_TRIGGER_KEY];
}
