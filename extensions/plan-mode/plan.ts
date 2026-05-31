/**
 * Plan utility functions
 * - Extract numbered plan items from AI responses
 * - Track [DONE:n] completion markers
 * - Clean step text for widget display
 */

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

/** Locale-specific prefix patterns to strip from step text */
const LOCALE_PREFIX_PATTERNS: Record<string, RegExp[]> = {
  zh: [/^让我们/, /^我们先/, /^需要/],
};

/** Detect primary language subtag from OS locale */
function detectPrimaryLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.split("-")[0];
  } catch {
    return "en";
  }
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

  cleaned = cleaned
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (cleaned.length > 55) {
    cleaned = cleaned.slice(0, 52) + "...";
  }
  return cleaned;
}

/** Extract numbered list from Plan: section in message */
export function extractPlanItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];

  // Match Plan: header (supports **Plan:**, Plan:, etc.)
  const headerMatch = message.match(/\*{0,2}Plan:?\*{0,2}\s*\n/i);
  if (!headerMatch) return items;

  const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
  const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

  for (const match of planSection.matchAll(numberedPattern)) {
    const text = match[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3) {
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
