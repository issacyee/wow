import type { WorktreeSnapshot } from "../wow/git.ts";
import type { ReviewHandoffContent, WorkflowReviewHandoffDetails } from "./types.ts";
import type { TodoItem } from "./plan.ts";

const SECTION_KEYS: Array<{ key: keyof ReviewHandoffContent; names: string[] }> = [
  { key: "intent", names: ["Intent", "实现意图", "意图"] },
  { key: "behavioralChanges", names: ["Behavioral Changes", "行为变化", "行为变更"] },
  { key: "executionDelta", names: ["Execution Delta", "本次执行增量", "执行增量"] },
  { key: "existingWorktreeInteractions", names: ["Existing Worktree Interactions", "既有工作区改动交互", "现有工作区交互"] },
  { key: "impactSurface", names: ["Impact Surface", "影响范围", "影响面"] },
  { key: "validationEvidence", names: ["Validation Evidence", "验证证据", "验证结果"] },
  { key: "risksAndUnknowns", names: ["Risks and Unknowns", "风险与未知事项", "风险和未知事项"] },
  { key: "suggestedReviewPath", names: ["Suggested Review Path", "建议审查路径", "推荐审查路径"] },
  { key: "modifiedFiles", names: ["Modified Files", "修改文件", "已修改文件"] },
  { key: "followUpSuggestions", names: ["Follow-up Suggestions", "后续建议", "后续事项"] },
];

function emptyContent(): ReviewHandoffContent {
  return {
    intent: "",
    behavioralChanges: "",
    executionDelta: "",
    existingWorktreeInteractions: "",
    impactSurface: "",
    validationEvidence: "",
    risksAndUnknowns: "",
    suggestedReviewPath: "",
    modifiedFiles: "",
    followUpSuggestions: "",
  };
}

function normalizeHeading(text: string): string {
  return text.trim().replace(/[:：]\s*$/, "").toLowerCase();
}

function sectionKey(heading: string): keyof ReviewHandoffContent | undefined {
  const normalized = normalizeHeading(heading);
  return SECTION_KEYS.find((candidate) => candidate.names.some((name) => normalizeHeading(name) === normalized))?.key;
}

export function parseReviewHandoff(text: string): ReviewHandoffContent {
  const content = emptyContent();
  const lines = text.split(/\r?\n/);
  let current: keyof ReviewHandoffContent | undefined;

  for (const line of lines) {
    const heading = /^\s*#{2,4}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = sectionKey(heading[1]!);
      continue;
    }
    if (current) content[current] += `${content[current] ? "\n" : ""}${line}`;
  }

  for (const key of Object.keys(content) as Array<keyof ReviewHandoffContent>) {
    content[key] = content[key].trim();
  }
  return content;
}

export function looksLikeCompletedReviewHandoff(text: string): boolean {
  if (!/(^|\n)\s*#{1,3}\s*(Review Handoff|审查交接|审查移交|审阅交接)\s*($|\n)/iu.test(text)) return false;
  const parsed = parseReviewHandoff(text);
  return !!parsed.intent && !!parsed.executionDelta && !!parsed.suggestedReviewPath;
}

function cloneTodoItems(items: TodoItem[]): TodoItem[] {
  return items.map((item) => ({ ...item }));
}

function filePaths(snapshot: WorktreeSnapshot | undefined): string[] {
  return snapshot?.files.map((file) => file.path) ?? [];
}

function mentionedPaths(content: ReviewHandoffContent): Set<string> {
  const mentioned = new Set<string>();
  const source = `${content.executionDelta}\n${content.modifiedFiles}\n${content.suggestedReviewPath}`;
  for (const match of source.matchAll(/`([^`]+)`/g)) {
    const path = match[1]?.trim().replace(/\\/g, "/");
    if (path && /[/.\\]/.test(path)) mentioned.add(path);
  }
  return mentioned;
}

export function buildReviewHandoffDetails(
  text: string,
  todoItems: TodoItem[],
  before: WorktreeSnapshot | undefined,
  after: WorktreeSnapshot | undefined,
): WorkflowReviewHandoffDetails {
  const content = parseReviewHandoff(text);
  const beforePaths = new Set(filePaths(before));
  const afterPaths = new Set(filePaths(after));
  const mentioned = mentionedPaths(content);
  const interactingFiles = [...beforePaths]
    .filter((path) => afterPaths.has(path) && (mentioned.size === 0 || mentioned.has(path)))
    .sort();
  const executionFiles = [...afterPaths]
    .filter((path) => !beforePaths.has(path) || mentioned.has(path))
    .sort();

  return {
    version: 1,
    todoItems: cloneTodoItems(todoItems),
    content,
    baselineFingerprint: before?.fingerprint,
    finalFingerprint: after?.fingerprint,
    existingWorktreeFiles: [...beforePaths].sort(),
    finalWorktreeFiles: [...afterPaths].sort(),
    executionFiles,
    interactingFiles,
    attributionLimitations: before
      ? "Execution attribution combines the implementing agent's handoff with before/after worktree snapshots. Overlapping edits in files that were already dirty cannot be separated perfectly at hunk level."
      : "No execution-start worktree snapshot was available; change attribution relies on the implementing agent's handoff.",
  };
}
