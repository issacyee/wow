import type { TodoItem } from "./plan.ts";

export const WORKFLOW_EXECUTION_SUMMARY_TYPE = "human-led-coding-workflow.execution-summary";

export interface WorkflowExecutionSummaryDetails {
  version: 1;
  todoItems: TodoItem[];
}
