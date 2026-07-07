/**
 * Structured ask metadata for discuss mode.
 *
 * The assistant writes natural, human-readable questions in its reply, then
 * appends one hidden HTML-comment metadata block:
 *
 *   <!-- wow-ask:v1
 *   { "version": 1, "questions": [...] }
 *   -->
 *
 * This module parses that metadata into typed data and formats the user's
 * answers back into a natural-language draft that is filled into the editor
 * (the human reviews and sends it). It intentionally does not support the old
 * `:::ask` protocol.
 *
 * Logic/visual boundary: this module is pure logic + a globalThis-backed trigger
 * singleton (mirrors wow/tips.ts). The visual layer (wow-tui/ask-panel.ts)
 * injects the panel opener via setAskPanelTrigger() at session_start; this logic
 * extension reads it via getAskPanelTrigger() in agent_end. No TUI runtime import
 * here.
 */

import { detectPrimaryLocale } from "../wow/locale.ts";

// ── Types ──

export type AskQuestionType = "single" | "multiple" | "text";

export interface AskOption {
  /** Stable machine value. Never shown in the editor draft. */
  id: string;
  /** Human-facing label exactly as the assistant wrote it. */
  label: string;
}

export interface AskOther {
  enabled: boolean;
  label?: string;
  placeholder?: string;
}

export interface AskQuestion {
  /** Stable id within one reply, used only as the internal answer key. */
  id: string;
  type: AskQuestionType;
  question: string;
  hint?: string;
  options: AskOption[];
  /** A string option id for single-choice, an array of option ids for multiple-choice. */
  default?: string | string[];
  /** Custom-answer configuration. Missing means custom answers are enabled. */
  other?: AskOther;
}

/** Backwards-compatible export name for existing HLCW call sites. */
export type AskBlock = AskQuestion;

export interface AskBatch {
  version: 1;
  questions: AskQuestion[];
}

export type AskAnswer =
  | { kind: "selected"; optionIds: string[] }
  | { kind: "custom"; value: string }
  | { kind: "skipped" };

/** Map of ask question id → user's answer. */
export type AskAnswers = Record<string, AskAnswer>;

// ── Parsing ──

const ASK_METADATA_RE = /<!--\s*wow-ask:v1\s*([\s\S]*?)-->/g;
const QUESTION_TYPES = new Set<AskQuestionType>(["single", "multiple", "text"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  return trimmed;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeOptions(value: unknown, questionId: string, required: boolean): AskOption[] {
  if (value === undefined) {
    if (required) throw new Error(`question ${questionId} options are required`);
    return [];
  }
  if (!Array.isArray(value)) throw new Error(`question ${questionId} options must be an array`);

  const seen = new Set<string>();
  const options = value.map((raw, index) => {
    const record = asRecord(raw);
    if (!record) throw new Error(`question ${questionId} option ${index + 1} must be an object`);
    const id = requiredString(record.id, `question ${questionId} option ${index + 1} id`);
    if (seen.has(id)) throw new Error(`question ${questionId} option id is duplicated: ${id}`);
    seen.add(id);
    return {
      id,
      label: requiredString(record.label, `question ${questionId} option ${id} label`),
    } satisfies AskOption;
  });

  if (required && options.length === 0) {
    throw new Error(`question ${questionId} options must not be empty`);
  }
  return options;
}

function normalizeOther(value: unknown, questionId: string, type: AskQuestionType): AskOther | undefined {
  if (value === undefined) {
    if (type === "text") return { enabled: true };
    return undefined;
  }

  const record = asRecord(value);
  if (!record) throw new Error(`question ${questionId} other must be an object`);

  const enabled = record.enabled !== false;
  if (type === "text" && !enabled) {
    throw new Error(`question ${questionId} text questions must allow custom input`);
  }

  return {
    enabled,
    label: optionalString(record.label, `question ${questionId} other.label`),
    placeholder: optionalString(record.placeholder, `question ${questionId} other.placeholder`),
  };
}

function normalizeDefault(
  value: unknown,
  questionId: string,
  type: AskQuestionType,
  optionIds: Set<string>,
): string | string[] | undefined {
  if (value === undefined) return undefined;

  if (type === "text") {
    throw new Error(`question ${questionId} text questions must not define default`);
  }

  if (type === "single") {
    const id = requiredString(value, `question ${questionId} default`);
    if (!optionIds.has(id)) throw new Error(`question ${questionId} default references unknown option: ${id}`);
    return id;
  }

  if (!Array.isArray(value)) throw new Error(`question ${questionId} default must be an array`);
  const seen = new Set<string>();
  const ids = value.map((entry, index) => {
    const id = requiredString(entry, `question ${questionId} default ${index + 1}`);
    if (!optionIds.has(id)) throw new Error(`question ${questionId} default references unknown option: ${id}`);
    if (seen.has(id)) throw new Error(`question ${questionId} default option is duplicated: ${id}`);
    seen.add(id);
    return id;
  });
  return ids;
}

function normalizeQuestion(value: unknown, seenQuestionIds: Set<string>, index: number): AskQuestion {
  const record = asRecord(value);
  if (!record) throw new Error(`question ${index + 1} must be an object`);

  const id = requiredString(record.id, `question ${index + 1} id`);
  if (seenQuestionIds.has(id)) throw new Error(`question id is duplicated: ${id}`);
  seenQuestionIds.add(id);

  const rawType = requiredString(record.type, `question ${id} type`);
  if (!QUESTION_TYPES.has(rawType as AskQuestionType)) {
    throw new Error(`question ${id} type is invalid: ${rawType}`);
  }
  const type = rawType as AskQuestionType;

  const options = normalizeOptions(record.options, id, type === "single" || type === "multiple");
  const optionIds = new Set(options.map((option) => option.id));

  return {
    id,
    type,
    question: requiredString(record.question, `question ${id} question`),
    hint: optionalString(record.hint, `question ${id} hint`),
    options,
    default: normalizeDefault(record.default, id, type, optionIds),
    other: normalizeOther(record.other, id, type),
  };
}

function normalizeBatch(value: unknown): AskBatch {
  const record = asRecord(value);
  if (!record) throw new Error("ask metadata must be an object");
  if (record.version !== 1) throw new Error("ask metadata version must be 1");
  if (!Array.isArray(record.questions)) throw new Error("ask metadata questions must be an array");
  if (record.questions.length === 0) throw new Error("ask metadata questions must not be empty");

  const seenQuestionIds = new Set<string>();
  return {
    version: 1,
    questions: record.questions.map((question, index) => normalizeQuestion(question, seenQuestionIds, index)),
  };
}

function normalizeFingerprintText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function defaultFingerprint(question: AskQuestion): string[] {
  if (question.default === undefined) return [];

  const defaultIds = new Set(Array.isArray(question.default) ? question.default : [question.default]);
  return question.options
    .filter((option) => defaultIds.has(option.id))
    .map((option) => normalizeFingerprintText(option.label));
}

function otherFingerprint(question: AskQuestion): { enabled: boolean; label: string; placeholder: string } {
  const enabled = question.type === "text" || question.other?.enabled !== false;
  return {
    enabled,
    label: enabled ? normalizeFingerprintText(question.other?.label ?? "Other") : "",
    placeholder: enabled ? normalizeFingerprintText(question.other?.placeholder) : "",
  };
}

function askQuestionFingerprintPayload(question: AskQuestion): Record<string, unknown> {
  return {
    type: question.type,
    question: normalizeFingerprintText(question.question),
    hint: normalizeFingerprintText(question.hint),
    options: question.options.map((option) => normalizeFingerprintText(option.label)),
    default: defaultFingerprint(question),
    other: otherFingerprint(question),
  };
}

function askQuestionFingerprint(question: AskQuestion): string {
  return JSON.stringify(askQuestionFingerprintPayload(question));
}

export function fingerprintAskBlocks(questions: AskQuestion[]): string {
  return JSON.stringify(questions.map((question) => askQuestionFingerprintPayload(question)));
}

export function hasAskMetadata(text: string): boolean {
  return /<!--\s*wow-ask:v1\b/.test(text);
}

/** Remove hidden ask metadata from visible assistant text. */
export function stripAskMetadata(text: string): string {
  if (!text) return text;
  return text
    .replace(ASK_METADATA_RE, "")
    .replace(/<!--\s*wow-ask:v1[\s\S]*$/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function collectAskBatches(text: string): AskBatch[] {
  if (!text) return [];

  const batches: AskBatch[] = [];
  const re = new RegExp(ASK_METADATA_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    try {
      batches.push(normalizeBatch(JSON.parse(match[1]!.trim())));
    } catch {
      // Invalid metadata falls back to the visible natural-language questions.
      // The caller may use hasAskMetadata(text) to surface a lightweight warning.
    }
  }
  return batches;
}

/** Collect all valid ask questions from `<!-- wow-ask:v1 ... -->` metadata. */
export function collectAskBlocks(text: string): AskBlock[] {
  const seen = new Set<string>();
  const blocks: AskBlock[] = [];

  for (const question of collectAskBatches(text).flatMap((batch) => batch.questions)) {
    const fingerprint = askQuestionFingerprint(question);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    blocks.push(question);
  }

  return blocks;
}

// ── Formatting ──

function optionLabel(question: AskQuestion, optionId: string): string | undefined {
  return question.options.find((option) => option.id === optionId)?.label;
}

function selectedAnswerText(question: AskQuestion, optionIds: string[]): string | undefined {
  const labels = optionIds
    .map((optionId) => optionLabel(question, optionId))
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join("；") : undefined;
}

function answerText(question: AskQuestion, answer: AskAnswer | undefined): string | undefined {
  if (!answer || answer.kind === "skipped") return undefined;
  if (answer.kind === "custom") {
    const value = answer.value.trim();
    return value || undefined;
  }
  return selectedAnswerText(question, answer.optionIds);
}

export function countAnsweredAskQuestions(questions: AskQuestion[], answers: AskAnswers): number {
  return questions.filter((question) => answerText(question, answers[question.id]) !== undefined).length;
}

/**
 * Format answers into a natural-language draft filled into the editor (without
 * the `?` prefix; the caller prepends `? ` so normal HLCW routing applies).
 *
 * The draft intentionally contains no question ids or option ids.
 */
export function formatAskAnswers(questions: AskQuestion[], answers: AskAnswers): string {
  const useChinese = detectPrimaryLocale() === "zh";
  const lines = [useChinese ? "关于上面的问题，我的选择是：" : "For the questions above, my choices are:", ""];
  let visibleIndex = 1;
  let skipped = 0;

  for (const question of questions) {
    const text = answerText(question, answers[question.id]);
    if (!text) {
      skipped++;
      continue;
    }
    lines.push(useChinese
      ? `${visibleIndex}. ${question.question}：${text}`
      : `${visibleIndex}. ${question.question}: ${text}`);
    visibleIndex++;
  }

  if (skipped > 0) {
    lines.push(useChinese
      ? `${visibleIndex}. ${skipped === questions.length ? "这些问题请你自行判断。" : "其余未回答的问题请你自行判断。"}`
      : `${visibleIndex}. ${skipped === questions.length ? "Please decide these questions yourself." : "Please decide the remaining unanswered questions yourself."}`);
  }

  return lines.join("\n");
}

// ── Trigger singleton (logic ↔ visual bridge) ──

/** Opens the ask panel for the given questions. Returns answers, or null if cancelled. */
export type AskPanelTrigger = (
  ctx: { hasUI: boolean; mode: string; ui: any },
  questions: AskQuestion[],
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
