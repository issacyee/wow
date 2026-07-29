import type { CodeIntelligenceArtifact } from "./types.ts";

export interface CodeIntelligenceSnapshot {
  activeUnderstanding?: CodeIntelligenceArtifact & { kind: "understanding" };
  activeReview?: CodeIntelligenceArtifact & { kind: "review" };
  phase: "idle" | "understanding" | "reviewing" | "asking";
  label?: string;
}

type Listener = () => void;

interface Store extends CodeIntelligenceSnapshot {
  listeners: Set<Listener>;
}

const STORE_KEY = Symbol.for("wow.code-intelligence.state");

function store(): Store {
  const globalStore = globalThis as any;
  const value = (globalStore[STORE_KEY] ??= { phase: "idle", listeners: new Set<Listener>() }) as Partial<Store>;
  value.phase ??= "idle";
  value.listeners ??= new Set<Listener>();
  return value as Store;
}

function emitChange(): void {
  for (const listener of store().listeners) listener();
}

export function subscribeCodeIntelligence(listener: Listener): () => void {
  store().listeners.add(listener);
  return () => store().listeners.delete(listener);
}

export function getCodeIntelligenceSnapshot(): CodeIntelligenceSnapshot {
  const value = store();
  return {
    activeUnderstanding: value.activeUnderstanding,
    activeReview: value.activeReview,
    phase: value.phase,
    label: value.label,
  };
}

export function setCodeIntelligencePhase(phase: Store["phase"], label?: string): void {
  const value = store();
  value.phase = phase;
  value.label = label;
  emitChange();
}

export function setActiveArtifact(artifact: CodeIntelligenceArtifact): void {
  const value = store();
  if (artifact.kind === "understanding") value.activeUnderstanding = artifact;
  else value.activeReview = artifact;
  emitChange();
}

export function getActiveUnderstanding() {
  return store().activeUnderstanding;
}

export function getActiveReview() {
  return store().activeReview;
}

export function clearCodeIntelligenceState(): void {
  const value = store();
  value.activeUnderstanding = undefined;
  value.activeReview = undefined;
  value.phase = "idle";
  value.label = undefined;
  emitChange();
}
