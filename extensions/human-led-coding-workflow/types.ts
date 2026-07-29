import type { TodoItem } from "./plan.ts";

/** Kept as an alias so existing persisted transcript entries still render. */
export const WORKFLOW_EXECUTION_SUMMARY_TYPE = "human-led-coding-workflow.execution-summary";
export const WORKFLOW_REVIEW_HANDOFF_TYPE = "human-led-coding-workflow.review-handoff";

export interface ReviewHandoffContent {
  intent: string;
  behavioralChanges: string;
  executionDelta: string;
  existingWorktreeInteractions: string;
  impactSurface: string;
  validationEvidence: string;
  risksAndUnknowns: string;
  suggestedReviewPath: string;
  modifiedFiles: string;
  followUpSuggestions: string;
}

export interface WorkflowReviewHandoffDetails {
  version: 1;
  todoItems: TodoItem[];
  content: ReviewHandoffContent;
  baselineFingerprint?: string;
  finalFingerprint?: string;
  existingWorktreeFiles: string[];
  finalWorktreeFiles: string[];
  executionFiles: string[];
  interactingFiles: string[];
  attributionLimitations: string;
}

/** Legacy details shape for old execution-summary transcript entries. */
export interface WorkflowExecutionSummaryDetails {
  version: 1;
  todoItems: TodoItem[];
}
