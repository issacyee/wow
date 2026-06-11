/**
 * Shared state store for Human-Led Coding Workflow.
 *
 * Logic owns mutations. Visual layers may subscribe/read snapshots, but this
 * module has no TUI dependency and never writes to LLM context by itself.
 *
 * Pi loads package extensions through separate jiti module instances, so plain
 * module-level variables are not reliably shared between logic and visual
 * extensions. Keep the mutable store on globalThis so human-led-coding-workflow
 * and wow-tui observe the same state and listener set.
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

interface WorkflowStore extends WorkflowSnapshot {
  listeners: Set<Listener>;
}

const WORKFLOW_STORE_KEY = Symbol.for("wow.human-led-coding-workflow.state");

function createStore(): WorkflowStore {
  return {
    turnMode: null,
    activePlan: false,
    planFullText: "",
    todoItems: [],
    executionActive: false,
    executed: false,
    listeners: new Set<Listener>(),
  };
}

function getStore(): WorkflowStore {
  const globalStore = globalThis as any;
  const store = (globalStore[WORKFLOW_STORE_KEY] ??= createStore()) as Partial<WorkflowStore>;

  store.turnMode ??= null;
  store.activePlan ??= false;
  store.planFullText ??= "";
  store.todoItems ??= [];
  store.executionActive ??= false;
  store.executed ??= false;
  store.listeners ??= new Set<Listener>();

  return store as WorkflowStore;
}

const store = getStore();

function cloneTodoItems(items: TodoItem[]): TodoItem[] {
  return items.map((item) => ({ ...item }));
}

function emitChange(): void {
  for (const listener of store.listeners) {
    listener();
  }
}

export function subscribeWorkflowState(listener: Listener): () => void {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

export function getWorkflowSnapshot(): WorkflowSnapshot {
  return {
    turnMode: store.turnMode,
    activePlan: store.activePlan,
    planFullText: store.planFullText,
    todoItems: cloneTodoItems(store.todoItems),
    executionActive: store.executionActive,
    executed: store.executed,
  };
}

export function resetWorkflowState(): void {
  store.turnMode = null;
  store.activePlan = false;
  store.planFullText = "";
  store.todoItems = [];
  store.executionActive = false;
  store.executed = false;
  emitChange();
}

export function currentWorkflowState(): WorkflowState {
  return {
    activePlan: store.activePlan,
    planFullText: store.planFullText,
    todoItems: cloneTodoItems(store.todoItems),
    executionActive: store.executionActive,
    executed: store.executed,
  };
}

export function restoreWorkflowState(data: Partial<WorkflowState> | undefined): void {
  store.activePlan = data?.activePlan ?? false;
  store.planFullText = typeof data?.planFullText === "string" ? data.planFullText : "";
  store.todoItems = Array.isArray(data?.todoItems) ? cloneTodoItems(data.todoItems) : [];
  store.executed = data?.executed ?? false;
  store.executionActive = typeof data?.executionActive === "boolean"
    ? data.executionActive
    : store.activePlan && store.executed && store.todoItems.some((item) => !item.completed);
  emitChange();
}

export function getTurnMode(): TurnMode {
  return store.turnMode;
}

export function setTurnMode(mode: TurnMode): void {
  store.turnMode = mode;
  emitChange();
}

export function clearTurnMode(): void {
  setTurnMode(null);
}

export function hasActivePlan(): boolean {
  return store.activePlan;
}

export function getPlanFullText(): string {
  return store.planFullText;
}

export function setPlanFullText(text: string): void {
  store.planFullText = text;
  emitChange();
}

export function getTodoItems(): TodoItem[] {
  return cloneTodoItems(store.todoItems);
}

export function replacePlan(text: string, items: TodoItem[], isExecuted = false): void {
  store.activePlan = true;
  store.planFullText = text;
  store.todoItems = cloneTodoItems(items);
  store.executionActive = false;
  store.executed = isExecuted;
  emitChange();
}

export function clearPlan(isExecuted = false): void {
  store.activePlan = false;
  store.planFullText = "";
  store.todoItems = [];
  store.executionActive = false;
  store.executed = isExecuted;
  emitChange();
}

export function finishExecution(): void {
  store.activePlan = false;
  store.planFullText = "";
  store.todoItems = store.todoItems.map((item) => ({ ...item, completed: true }));
  store.executionActive = false;
  store.executed = true;
  emitChange();
}

export function continueExecution(): void {
  store.activePlan = true;
  store.executionActive = true;
  store.executed = true;
  emitChange();
}

export function clearCompletedExecutionDisplay(): boolean {
  if (store.activePlan || store.executionActive || !store.executed || store.todoItems.length === 0) return false;

  store.planFullText = "";
  store.todoItems = [];
  store.executed = false;
  emitChange();
  return true;
}

export function setActivePlan(value: boolean): void {
  store.activePlan = value;
  if (!value) store.executionActive = false;
  emitChange();
}

export function setExecutionActive(value: boolean): void {
  store.executionActive = value && store.activePlan;
  emitChange();
}

export function setExecuted(value: boolean): void {
  store.executed = value;
  emitChange();
}

export function mutateTodoItems(mutator: (items: TodoItem[]) => void): void {
  mutator(store.todoItems);
  emitChange();
}
