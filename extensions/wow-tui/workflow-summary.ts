/**
 * HLCW transcript renderers owned by Wow TUI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { linkPath } from "../wow/paths.ts";
import type { TodoItem } from "../human-led-coding-workflow/plan.ts";
import {
  WORKFLOW_EXECUTION_SUMMARY_TYPE,
  WORKFLOW_REVIEW_HANDOFF_TYPE,
  type ReviewHandoffContent,
  type WorkflowExecutionSummaryDetails,
  type WorkflowReviewHandoffDetails,
} from "../human-led-coding-workflow/types.ts";

function todoPrefix(item: TodoItem): string {
  return item.completed ? "[✓] " : "[ ] ";
}

function renderTodoLine(item: TodoItem, theme: any, width: number): string {
  const prefix = todoPrefix(item);
  const prefixWidth = visibleWidth(prefix);

  if (width <= prefixWidth) {
    const visiblePrefix = truncateToWidth(prefix, width, "");
    return item.completed ? theme.fg("success", visiblePrefix) : theme.fg("dim", visiblePrefix);
  }

  const textWidth = Math.max(0, width - prefixWidth);
  const text = truncateToWidth(item.text, textWidth);

  if (item.completed) {
    return theme.fg("success", prefix) + theme.fg("muted", theme.strikethrough(text));
  }
  return `${theme.fg("dim", prefix)}${text}`;
}

function legacyDetails(details: WorkflowExecutionSummaryDetails | undefined): WorkflowExecutionSummaryDetails {
  return {
    version: 1,
    todoItems: Array.isArray(details?.todoItems) ? details.todoItems : [],
  };
}

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

function handoffDetails(details: WorkflowReviewHandoffDetails | undefined): WorkflowReviewHandoffDetails {
  return {
    version: 1,
    todoItems: Array.isArray(details?.todoItems) ? details.todoItems : [],
    content: details?.content ?? emptyContent(),
    baselineFingerprint: details?.baselineFingerprint,
    finalFingerprint: details?.finalFingerprint,
    existingWorktreeFiles: Array.isArray(details?.existingWorktreeFiles) ? details.existingWorktreeFiles : [],
    finalWorktreeFiles: Array.isArray(details?.finalWorktreeFiles) ? details.finalWorktreeFiles : [],
    executionFiles: Array.isArray(details?.executionFiles) ? details.executionFiles : [],
    interactingFiles: Array.isArray(details?.interactingFiles) ? details.interactingFiles : [],
    attributionLimitations: details?.attributionLimitations ?? "",
  };
}

function linkInlineCode(text: string): string {
  return text.replace(/`([^`]+)`/g, (_match, target: string) => {
    const trimmed = target.trim();
    if (!/[\\/]|\.[a-z0-9]+(?::\d+)?$/iu.test(trimmed)) return trimmed;
    const match = /^(.+?)(?::(\d+)(?::\d+)?)?$/.exec(trimmed);
    return linkPath(match?.[1] ?? trimmed, process.cwd()) + (match?.[2] ? `:${match[2]}` : "");
  });
}

function section(title: string, value: string, theme: any, width: number): string[] {
  if (!value.trim()) return [];
  const wrapped = value
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, 10)
    .map(linkInlineCode)
    .flatMap((line) => wrapTextWithAnsi(line, width));
  return [...wrapTextWithAnsi(theme.fg("accent", theme.bold(title)), width), ...wrapped];
}

export function registerWorkflowSummaryRendering(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<WorkflowExecutionSummaryDetails>(WORKFLOW_EXECUTION_SUMMARY_TYPE, (message, _options, theme) => {
    const details = legacyDetails(message.details);
    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));

    box.addChild({
      invalidate() { },
      render(width: number): string[] {
        const availableWidth = Math.max(1, width);
        const header = wrapTextWithAnsi(theme.fg("success", theme.bold("Execution completed")), availableWidth);
        const note = wrapTextWithAnsi(theme.fg("dim", "legacy workflow checklist; hidden from model context"), availableWidth);
        const todoLines = details.todoItems.map((item) => renderTodoLine(item, theme, availableWidth));
        return [...header, ...note, "", ...todoLines];
      },
    });

    return box;
  });

  pi.registerMessageRenderer<WorkflowReviewHandoffDetails>(WORKFLOW_REVIEW_HANDOFF_TYPE, (message, { expanded }, theme) => {
    const details = handoffDetails(message.details);
    const content = details.content;
    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    box.addChild({
      invalidate() { },
      render(width: number): string[] {
        const inner = Math.max(1, width);
        const lines = [
          ...wrapTextWithAnsi(theme.fg("success", theme.bold("Review Handoff")), inner),
          ...wrapTextWithAnsi(theme.fg("dim", "implementing-agent handoff; not independently reviewed; hidden from model context"), inner),
          "",
          ...section("Intent", content.intent, theme, inner),
          "",
          ...section("Behavioral changes", content.behavioralChanges, theme, inner),
          "",
          ...section("Execution delta", content.executionDelta, theme, inner),
          "",
          ...section("Risks and unknowns", content.risksAndUnknowns, theme, inner),
          "",
          ...section("Suggested review path", content.suggestedReviewPath, theme, inner),
        ];
        if (details.interactingFiles.length > 0) {
          lines.push(
            "",
            ...wrapTextWithAnsi(theme.fg("warning", theme.bold("Existing worktree interactions")), inner),
            ...details.interactingFiles.flatMap((path) => wrapTextWithAnsi(`- ${linkPath(path, process.cwd())}`, inner)),
          );
        }
        if (expanded) {
          lines.push(
            "",
            ...section("Impact surface", content.impactSurface, theme, inner),
            "",
            ...section("Validation evidence", content.validationEvidence, theme, inner),
            "",
            ...section("Modified files", content.modifiedFiles, theme, inner),
            "",
            ...section("Follow-up suggestions", content.followUpSuggestions, theme, inner),
            "",
            ...(details.attributionLimitations.trim()
              ? wrapTextWithAnsi(details.attributionLimitations, inner).map((line) => theme.fg("dim", line))
              : []),
            "",
            ...wrapTextWithAnsi(theme.fg("accent", theme.bold("Workflow checklist")), inner),
            ...details.todoItems.map((item) => renderTodoLine(item, theme, inner)),
          );
        }
        return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "");
      },
    });
    return box;
  });
}
