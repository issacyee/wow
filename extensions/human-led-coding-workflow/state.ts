/**
 * Shared state store for Human-Led Coding Workflow.
 *
 * Logic owns mutations. Visual layers may subscribe/read snapshots, but this
 * module has no TUI dependency and never writes to LLM context by itself.
 */

import type { WorkflowMode } from "./prompts.ts";
import type { TodoItem } from "./plan.ts";

export const WORKFLOW_STATE_TYPE = "human-led-coding-workflow";

export type TurnMode = WorkflowMode | null;

export interface WorkflowState {
  activePlan: boolean;
  planFullText: string;
  todoItems: TodoItem[];
  executionActive: boolean;
  executed: boolean;
}

export interface WorkflowSnapshot extends WorkflowState {
  turnMode: TurnMode;
}

type Listener = () => void;

let turnMode: TurnMode = null;
let activePlan = false;
let planFullText = "";
let todoItems: TodoItem[] = [];
let executionActive = false;
let executed = false;
const listeners = new Set<Listener>();

function cloneTodoItems(items: TodoItem[]): TodoItem[] {
  return items.map((item) => ({ ...item }));
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeWorkflowState(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getWorkflowSnapshot(): WorkflowSnapshot {
  return {
    turnMode,
    activePlan,
    planFullText,
    todoItems: cloneTodoItems(todoItems),
    executionActive,
    executed,
  };
}

export function resetWorkflowState(): void {
  turnMode = null;
  activePlan = false;
  planFullText = "";
  todoItems = [];
  executionActive = false;
  executed = false;
  emitChange();
}

export function currentWorkflowState(): WorkflowState {
  return {
    activePlan,
    planFullText,
    todoItems: cloneTodoItems(todoItems),
    executionActive,
    executed,
  };
}

export function restoreWorkflowState(data: Partial<WorkflowState> | undefined): void {
  activePlan = data?.activePlan ?? false;
  planFullText = typeof data?.planFullText === "string" ? data.planFullText : "";
  todoItems = Array.isArray(data?.todoItems) ? cloneTodoItems(data.todoItems) : [];
  executed = data?.executed ?? false;
  executionActive = typeof data?.executionActive === "boolean"
    ? data.executionActive
    : activePlan && executed && todoItems.some((item) => !item.completed);
  emitChange();
}

export function getTurnMode(): TurnMode {
  return turnMode;
}

export function setTurnMode(mode: TurnMode): void {
  turnMode = mode;
  emitChange();
}

export function clearTurnMode(): void {
  setTurnMode(null);
}

export function hasActivePlan(): boolean {
  return activePlan;
}

export function getPlanFullText(): string {
  return planFullText;
}

export function setPlanFullText(text: string): void {
  planFullText = text;
  emitChange();
}

export function getTodoItems(): TodoItem[] {
  return cloneTodoItems(todoItems);
}

export function replacePlan(text: string, items: TodoItem[], isExecuted = false): void {
  activePlan = true;
  planFullText = text;
  todoItems = cloneTodoItems(items);
  executionActive = false;
  executed = isExecuted;
  emitChange();
}

export function clearPlan(isExecuted = false): void {
  activePlan = false;
  planFullText = "";
  todoItems = [];
  executionActive = false;
  executed = isExecuted;
  emitChange();
}

export function setActivePlan(value: boolean): void {
  activePlan = value;
  if (!value) executionActive = false;
  emitChange();
}

export function setExecutionActive(value: boolean): void {
  executionActive = value && activePlan;
  emitChange();
}

export function setExecuted(value: boolean): void {
  executed = value;
  emitChange();
}

export function mutateTodoItems(mutator: (items: TodoItem[]) => void): void {
  mutator(todoItems);
  emitChange();
}
