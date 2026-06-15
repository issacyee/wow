/**
 * Wow TUI widgets and status presenters.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TodoItem } from "../human-led-coding-workflow/plan.ts";
import { getWorkflowSnapshot, WORKFLOW_STATE_TYPE } from "../human-led-coding-workflow/state.ts";
import { AdaptiveLines } from "../wow/renderer.ts";
import { wowColor } from "./theme.ts";

const MAX_TODO_WIDGET_LINES = 10;

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

function renderTruncatedTodoLine(remaining: number, theme: any, width: number): string {
  return theme.fg("muted", truncateToWidth(`... (${remaining} more todos)`, width));
}

class WorkflowTodoWidget extends AdaptiveLines {
  constructor(items: TodoItem[], theme: any) {
    super((width) => {
      const visibleItems = items.length > MAX_TODO_WIDGET_LINES
        ? items.slice(0, MAX_TODO_WIDGET_LINES - 1)
        : items;
      const lines = visibleItems.map((item) => renderTodoLine(item, theme, width));

      if (items.length > visibleItems.length) {
        lines.push(renderTruncatedTodoLine(items.length - visibleItems.length, theme, width));
      }

      return lines;
    }, {
      normalizeWhitespace: false,
      paddingX: 1,
    });
  }
}

export function updateWorkflowWidgets(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const snapshot = getWorkflowSnapshot();
  const showExecutionTodos = snapshot.todoItems.length > 0 &&
    (snapshot.executionActive || snapshot.turnMode === "execute");

  if (snapshot.turnMode === "discuss") {
    ctx.ui.setStatus(WORKFLOW_STATE_TYPE, wowColor(ctx.ui.theme, "workflow.statusDiscuss")("◇ discuss"));
  } else if (snapshot.turnMode === "plan") {
    ctx.ui.setStatus(WORKFLOW_STATE_TYPE, wowColor(ctx.ui.theme, "workflow.statusPlan")("◇ plan"));
  } else if (snapshot.turnMode === "revise") {
    ctx.ui.setStatus(WORKFLOW_STATE_TYPE, wowColor(ctx.ui.theme, "workflow.statusRevise")("◇ revise"));
  } else if (showExecutionTodos) {
    const completed = snapshot.todoItems.filter((item) => item.completed).length;
    ctx.ui.setStatus(WORKFLOW_STATE_TYPE, wowColor(ctx.ui.theme, "workflow.statusExec")(`◇ exec ${completed}/${snapshot.todoItems.length}`));
  } else if (snapshot.activePlan) {
    ctx.ui.setStatus(WORKFLOW_STATE_TYPE, wowColor(ctx.ui.theme, "workflow.statusReady")("◇ plan ready"));
  } else {
    ctx.ui.setStatus(WORKFLOW_STATE_TYPE, undefined);
  }

  if (showExecutionTodos) {
    const items = snapshot.todoItems;
    ctx.ui.setWidget(`${WORKFLOW_STATE_TYPE}-todos`, (_tui, theme) => new WorkflowTodoWidget(items, theme));
  } else {
    ctx.ui.setWidget(`${WORKFLOW_STATE_TYPE}-todos`, undefined);
  }
}
