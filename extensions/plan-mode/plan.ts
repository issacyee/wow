/**
 * Plan utility functions
 * - Extract numbered plan items from AI responses
 * - Track [DONE:n] completion markers
 * - Clean step text for widget display
 */

import { detectPrimaryLocale } from "../wow/locale.ts";

export { detectPrimaryLocale };

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

/** Locale-specific prefix patterns to strip from step text */
const LOCALE_PREFIX_PATTERNS: Record<string, RegExp[]> = {
  zh: [/^让我们/, /^我们先/, /^需要/],
};

/** Fixed conversational marker — a single line before the actionable step list */
export const ACTION_MARKER = "Ready to go?";

/** Regex matching the marker line followed by the numbered step list */
const ACTION_MARKER_RE = /^Ready to go\?\n([\s\S]*)/im;

/** Check whether a message contains the "Ready to go?" plan completion marker */
export function hasReadyMarker(text: string): boolean {
  return /^Ready to go\?/im.test(text);
}

/** Clean step text: remove Markdown formatting, truncate long text */
export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      "",
    );

  // Apply locale-specific prefix patterns
  const locale = detectPrimaryLocale();
  const patterns = LOCALE_PREFIX_PATTERNS[locale] ?? [];
  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, "");
  }

  // Strip leading em-dash/en-dash (from "**Action** — description" format)
  cleaned = cleaned.replace(/^[—–]\s*/, "");

  cleaned = cleaned
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (cleaned.length > 80) {
    cleaned = cleaned.slice(0, 77) + "...";
  }
  return cleaned;
}

/**
 * Extract plan items following the natural action marker line.
 * Returns items if found and non-empty, otherwise undefined (signal to fall back).
 */
function extractMarkedPlanItems(message: string): TodoItem[] | undefined {
  const match = message.match(ACTION_MARKER_RE);
  if (!match) return undefined;

  const items = extractNumberedList(match[1]);
  return items.length > 0 ? items : undefined;
}

/**
 * Extract numbered steps from a plan section.
 * Priority:
 *   1. Natural action marker line ("Ready to go?") — most reliable
 *   2. Text-based \`## <word>:\` header parsing (fallback)
 * Locale-agnostic: matches any \`## <word>:\` header (Plan:, 计划:, プラン:, etc.).
 */
export function extractPlanItems(message: string): TodoItem[] {
  // 1. Try natural action marker first
  const marked = extractMarkedPlanItems(message);
  if (marked) return marked;

  // 2. Fall back to text-based plan header parsing
  const planMatch = message.match(/^##\s+[^:]+:\s*[^\n]*\n([\s\S]*?)(?=\n---\s*\n|$)/m);
  if (!planMatch) return [];

  // Extract numbered items from everything after the plan header
  return extractNumberedList(planMatch[1]);
}

/** Extract numbered items ("1. ...", "2) ...") from a text section */
function extractNumberedList(section: string): TodoItem[] {
  const items: TodoItem[] = [];
  const numberedPattern = /^\s*(\d+)[.)]\s+(.+)$/gm;

  for (const match of section.matchAll(numberedPattern)) {
    const text = match[2].trim();
    if (text.length > 2 && !text.startsWith("/")) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 2) {
        items.push({ step: items.length + 1, text: cleaned, completed: false });
      }
    }
  }
  return items;
}

/** Extract step numbers from [DONE:n] markers */
export function extractDoneSteps(text: string): number[] {
  const steps: number[] = [];
  for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

/** Mark completed steps, returns count of newly completed */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
  const doneSteps = extractDoneSteps(text);
  let count = 0;
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item && !item.completed) {
      item.completed = true;
      count++;
    }
  }
  return count;
}
