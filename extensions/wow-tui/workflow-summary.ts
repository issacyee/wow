/**
 * HLCW transcript renderers owned by Wow TUI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TodoItem } from "../human-led-coding-workflow/plan.ts";
import {
  WORKFLOW_EXECUTION_SUMMARY_TYPE,
  type WorkflowExecutionSummaryDetails,
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

function normalizeDetails(details: WorkflowExecutionSummaryDetails | undefined): WorkflowExecutionSummaryDetails {
  return {
    version: 1,
    todoItems: Array.isArray(details?.todoItems) ? details.todoItems : [],
  };
}

export function registerWorkflowSummaryRendering(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<WorkflowExecutionSummaryDetails>(WORKFLOW_EXECUTION_SUMMARY_TYPE, (message, _options, theme) => {
    const details = normalizeDetails(message.details);
    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));

    box.addChild({
      invalidate() { },
      render(width: number): string[] {
        const availableWidth = Math.max(1, width);
        const header = theme.fg("success", theme.bold("Execution completed"));
        const note = theme.fg("dim", "workflow checklist; hidden from model context");
        const todoLines = details.todoItems.map((item) => renderTodoLine(item, theme, availableWidth));
        return [header, note, "", ...todoLines];
      },
    });

    return box;
  });
}
