/**
 * Plan parsing helpers for Human-Led Coding Workflow.
 */

import removeMarkdown from "remove-markdown";

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

export const EXECUTE_MARKER = "Ready to execute?";

const MARKER_RE = /^\s*Ready to execute\?\s*$/im;
const PLAN_HEADER_RE = /^##\s+[^:：\n]+[:：]/m;
const IMPLEMENTATION_STEPS_HEADER_RE = /^###\s+(?:Implementation Steps|方案步骤|实施步骤|执行步骤)\s*$/im;

export function hasExecuteMarker(text: string): boolean {
  return MARKER_RE.test(text);
}

export function hasPlanStructure(text: string): boolean {
  return PLAN_HEADER_RE.test(text) && /###\s+/m.test(text);
}

export function isCompletePlan(text: string): boolean {
  return hasExecuteMarker(text) && hasPlanStructure(text);
}

export function extractPlanText(text: string): string {
  const match = text.match(/(##\s+[^:：\n]+[:：][\s\S]*)/m);
  return (match ? match[1] : text).trim();
}

function sectionAfterImplementationSteps(text: string): string | undefined {
  const header = text.match(IMPLEMENTATION_STEPS_HEADER_RE);
  if (!header || header.index === undefined) return undefined;

  const start = header.index + header[0].length;
  const rest = text.slice(start);
  const nextHeader = rest.search(/^###\s+/m);
  return nextHeader >= 0 ? rest.slice(0, nextHeader) : rest;
}

export function cleanStepText(text: string): string {
  let cleaned = removeMarkdown(text, {
    stripListLeaders: false,
    gfm: true,
    useImgAltText: true,
  });

  cleaned = cleaned
    .replace(/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i, "")
    .replace(/^[—–-]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (cleaned.length > 100) {
    cleaned = cleaned.slice(0, 97) + "...";
  }
  return cleaned;
}

function extractNumberedList(section: string): TodoItem[] {
  const items: TodoItem[] = [];
  const numberedPattern = /^\s*(\d+)[.)]\s+(.+)$/gm;

  for (const match of section.matchAll(numberedPattern)) {
    const text = match[2].trim();
    if (text.length <= 2 || text.startsWith("/")) continue;

    const cleaned = cleanStepText(text);
    if (cleaned.length > 2) {
      items.push({ step: items.length + 1, text: cleaned, completed: false });
    }
  }

  return items;
}

export function extractPlanItems(text: string): TodoItem[] {
  const planText = extractPlanText(text);
  const stepsSection = sectionAfterImplementationSteps(planText);
  if (stepsSection) {
    const items = extractNumberedList(stepsSection);
    if (items.length > 0) return items;
  }

  return extractNumberedList(planText);
}

export function extractDoneSteps(text: string): number[] {
  const steps: number[] = [];
  for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
  const doneSteps = extractDoneSteps(text);
  let count = 0;

  for (const step of doneSteps) {
    const item = items.find((candidate) => candidate.step === step);
    if (item && !item.completed) {
      item.completed = true;
      count++;
    }
  }

  return count;
}
