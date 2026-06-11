/**
 * Wow TUI widgets and status presenters.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWorkflowSnapshot, WORKFLOW_STATE_TYPE } from "../human-led-coding-workflow/state.ts";

export function updateWorkflowWidgets(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const snapshot = getWorkflowSnapshot();
  const allTodosCompleted = snapshot.todoItems.length > 0 && snapshot.todoItems.every((item) => item.completed);
  const showExecutionTodos = snapshot.todoItems.length > 0 &&
    (snapshot.executionActive || snapshot.turnMode === "execute" || (snapshot.executed && allTodosCompleted));

  if (snapshot.turnMode === "discuss") {
    ctx.ui.setStatus(WORKFLOW_STATE_TYPE, ctx.ui.theme.fg("muted", "◇ discuss"));
  } else if (snapshot.turnMode === "plan") {
    ctx.ui.setStatus(WORKFLOW_STATE_TYPE, ctx.ui.theme.fg("warning", "◇ plan"));
  } else if (snapshot.turnMode === "revise") {
    ctx.ui.setStatus(WORKFLOW_STATE_TYPE, ctx.ui.theme.fg("warning", "◇ revise"));
  } else if (showExecutionTodos) {
    const completed = snapshot.todoItems.filter((item) => item.completed).length;
    const label = snapshot.executed && allTodosCompleted ? "done" : "exec";
    const color = label === "done" ? "success" : "accent";
    ctx.ui.setStatus(WORKFLOW_STATE_TYPE, ctx.ui.theme.fg(color, `◇ ${label} ${completed}/${snapshot.todoItems.length}`));
  } else if (snapshot.activePlan) {
    ctx.ui.setStatus(WORKFLOW_STATE_TYPE, ctx.ui.theme.fg("muted", "◇ plan ready"));
  } else {
    ctx.ui.setStatus(WORKFLOW_STATE_TYPE, undefined);
  }

  if (showExecutionTodos) {
    const lines = snapshot.todoItems.map((item) => {
      if (item.completed) {
        return ctx.ui.theme.fg("success", "[✓] ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text));
      }
      return `${ctx.ui.theme.fg("dim", "[ ] ")}${item.text}`;
    });
    ctx.ui.setWidget(`${WORKFLOW_STATE_TYPE}-todos`, lines);
  } else {
    ctx.ui.setWidget(`${WORKFLOW_STATE_TYPE}-todos`, undefined);
  }
}
