/**
 * State store for BTW side-channel Q&A topics.
 *
 * BTW state is persisted via pi.appendEntry() custom entries only. It is not
 * injected into the main LLM context unless explicitly promoted by the user.
 *
 * Pi can load package extensions through separate jiti module instances, so the
 * mutable store lives on globalThis. This lets the logic extension and wow-tui
 * observe the same transient ask status and topic state.
 */

export const BTW_STATE_TYPE = "btw-state";

export type BtwTopicStatus = "open" | "closed";
export type BtwMessageRole = "user" | "assistant";

export interface BtwMessage {
  role: BtwMessageRole;
  text: string;
  timestamp: number;
}

export interface BtwTopic {
  id: string;
  title: string;
  status: BtwTopicStatus;
  anchorEntryId?: string;
  anchorExcerpt?: string;
  messages: BtwMessage[];
  summary?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface BtwState {
  currentTopicId?: string;
  nextId: number;
  topics: BtwTopic[];
  askProgresses?: BtwAskProgress[];
}

export type BtwAskPhase = "asking" | "asked" | "cancelled" | "failed";

export interface BtwAskProgress {
  progressId: string;
  topicId: string;
  title: string;
  phase: BtwAskPhase;
  startedAt: number;
  durationMs?: number;
  updatedAt: number;
  error?: string;
}

type Listener = () => void;

interface BtwStore extends BtwState {
  askProgresses: Map<string, BtwAskProgress>;
  listeners: Set<Listener>;
}

const BTW_STORE_KEY = Symbol.for("wow.btw.state");

function createStore(): BtwStore {
  return {
    currentTopicId: undefined,
    nextId: 1,
    topics: [],
    askProgresses: new Map<string, BtwAskProgress>(),
    listeners: new Set<Listener>(),
  };
}

function getStore(): BtwStore {
  const globalStore = globalThis as any;
  const store = (globalStore[BTW_STORE_KEY] ??= createStore()) as Partial<BtwStore>;

  store.nextId = typeof store.nextId === "number" && store.nextId > 0 ? Math.floor(store.nextId) : 1;
  store.topics ??= [];
  if (!(store.askProgresses instanceof Map)) {
    store.askProgresses = new Map<string, BtwAskProgress>();
  }
  store.listeners ??= new Set<Listener>();

  return store as BtwStore;
}

const store = getStore();

function cloneTopic(topic: BtwTopic): BtwTopic {
  return {
    ...topic,
    messages: topic.messages.map((message) => ({ ...message })),
  };
}

function cloneTopics(value: BtwTopic[]): BtwTopic[] {
  return value.map(cloneTopic);
}

function emitChange(): void {
  for (const listener of store.listeners) listener();
}

function normalizeNextId(value: unknown, restoredTopics: BtwTopic[]): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  let maxId = 0;
  for (const topic of restoredTopics) {
    const match = topic.id.match(/^b(\d+)$/i);
    if (match) maxId = Math.max(maxId, Number(match[1]));
  }
  return maxId + 1;
}

function normalizeProgress(value: any): BtwAskProgress | null {
  if (!value || typeof value !== "object") return null;
  if (typeof value.progressId !== "string" || !value.progressId.trim()) return null;
  if (typeof value.topicId !== "string" || !value.topicId.trim()) return null;

  const phase: BtwAskPhase =
    value.phase === "asked" || value.phase === "cancelled" || value.phase === "failed"
      ? value.phase
      : "cancelled";
  const startedAt = typeof value.startedAt === "number" ? value.startedAt : Date.now();
  const durationMs = typeof value.durationMs === "number"
    ? Math.max(0, Math.round(value.durationMs))
    : undefined;
  const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : startedAt;

  return {
    progressId: value.progressId.trim(),
    topicId: value.topicId.trim(),
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : value.topicId.trim(),
    phase,
    startedAt,
    durationMs,
    updatedAt,
    error: typeof value.error === "string" ? value.error : undefined,
  };
}

function normalizeTopic(value: any): BtwTopic | null {
  if (!value || typeof value !== "object") return null;
  if (typeof value.id !== "string" || !value.id.trim()) return null;

  const status: BtwTopicStatus = value.status === "closed" ? "closed" : "open";
  const messages = Array.isArray(value.messages)
    ? value.messages
      .filter((message: any) =>
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.text === "string"
      )
      .map((message: any) => ({
        role: message.role as BtwMessageRole,
        text: message.text,
        timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
      }))
    : [];

  const now = Date.now();
  return {
    id: value.id.trim(),
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : value.id.trim(),
    status,
    anchorEntryId: typeof value.anchorEntryId === "string" ? value.anchorEntryId : undefined,
    anchorExcerpt: typeof value.anchorExcerpt === "string" ? value.anchorExcerpt : undefined,
    messages,
    summary: typeof value.summary === "string" && value.summary.trim() ? value.summary.trim() : undefined,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
    closedAt: typeof value.closedAt === "number" ? value.closedAt : undefined,
  };
}

export function subscribeBtwState(listener: Listener): () => void {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

export function resetBtwState(): void {
  store.currentTopicId = undefined;
  store.nextId = 1;
  store.topics = [];
  store.askProgresses.clear();
  emitChange();
}

export function restoreBtwState(data: Partial<BtwState> | undefined): void {
  const restoredTopics = Array.isArray(data?.topics)
    ? data.topics.map(normalizeTopic).filter((topic): topic is BtwTopic => topic !== null)
    : [];
  const restoredProgresses = Array.isArray(data?.askProgresses)
    ? data.askProgresses.map(normalizeProgress).filter((progress): progress is BtwAskProgress => progress !== null)
    : [];

  store.topics = restoredTopics;
  store.askProgresses = new Map(restoredProgresses.map((progress) => [progress.progressId, progress]));
  store.nextId = normalizeNextId(data?.nextId, restoredTopics);

  const restoredCurrent = typeof data?.currentTopicId === "string" ? data.currentTopicId : undefined;
  store.currentTopicId = restoredCurrent && store.topics.some((topic) => topic.id === restoredCurrent && topic.status === "open")
    ? restoredCurrent
    : undefined;

  emitChange();
}

export function currentBtwState(): BtwState {
  return {
    currentTopicId: store.currentTopicId,
    nextId: store.nextId,
    topics: cloneTopics(store.topics),
    askProgresses: [...store.askProgresses.values()]
      .filter((progress) => progress.phase !== "asking")
      .map(cloneProgress),
  };
}

function cloneProgress(progress: BtwAskProgress): BtwAskProgress {
  return { ...progress };
}

export function getBtwAskProgress(progressId: string | undefined): BtwAskProgress | undefined {
  if (!progressId) return undefined;
  const progress = store.askProgresses.get(progressId);
  return progress ? cloneProgress(progress) : undefined;
}

export function hasActiveBtwAskProgress(): boolean {
  for (const progress of store.askProgresses.values()) {
    if (progress.phase === "asking") return true;
  }
  return false;
}

export function startBtwAskProgress(input: {
  progressId: string;
  topicId: string;
  title: string;
  startedAt?: number;
}): BtwAskProgress {
  const startedAt = input.startedAt ?? Date.now();
  const progress: BtwAskProgress = {
    progressId: input.progressId,
    topicId: input.topicId,
    title: input.title,
    phase: "asking",
    startedAt,
    updatedAt: startedAt,
  };
  store.askProgresses.set(progress.progressId, progress);
  emitChange();
  return cloneProgress(progress);
}

export function updateBtwAskProgress(
  progressId: string,
  patch: Partial<Pick<BtwAskProgress, "phase" | "durationMs" | "updatedAt" | "error">>,
): BtwAskProgress | undefined {
  const progress = store.askProgresses.get(progressId);
  if (!progress) return undefined;

  Object.assign(progress, patch, { updatedAt: patch.updatedAt ?? Date.now() });
  emitChange();
  return cloneProgress(progress);
}

export function getCurrentTopicId(): string | undefined {
  return store.currentTopicId;
}

export function setCurrentTopicId(id: string | undefined): void {
  store.currentTopicId = id;
  emitChange();
}

export function createTopic(input: {
  title: string;
  anchorEntryId?: string;
  anchorExcerpt?: string;
  now?: number;
}): BtwTopic {
  const now = input.now ?? Date.now();
  const topic: BtwTopic = {
    id: `b${store.nextId++}`,
    title: input.title,
    status: "open",
    anchorEntryId: input.anchorEntryId,
    anchorExcerpt: input.anchorExcerpt,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };

  store.topics.push(topic);
  store.currentTopicId = topic.id;
  emitChange();
  return cloneTopic(topic);
}

export function getTopic(id: string | undefined): BtwTopic | undefined {
  if (!id) return undefined;
  const topic = store.topics.find((candidate) => candidate.id === id);
  return topic ? cloneTopic(topic) : undefined;
}

export function getTopicRef(id: string | undefined): BtwTopic | undefined {
  if (!id) return undefined;
  return store.topics.find((candidate) => candidate.id === id);
}

export function getTopics(status: BtwTopicStatus | "all" = "all"): BtwTopic[] {
  const filtered = status === "all" ? store.topics : store.topics.filter((topic) => topic.status === status);
  return cloneTopics(filtered);
}

export function addTopicMessage(id: string, message: BtwMessage): BtwTopic | undefined {
  const topic = getTopicRef(id);
  if (!topic) return undefined;

  topic.messages.push({ ...message });
  topic.updatedAt = message.timestamp;
  emitChange();
  return cloneTopic(topic);
}

export function updateTopicSummary(id: string, summary: string): BtwTopic | undefined {
  const topic = getTopicRef(id);
  if (!topic) return undefined;

  topic.summary = summary;
  topic.updatedAt = Date.now();
  emitChange();
  return cloneTopic(topic);
}

export function closeTopic(id: string): BtwTopic | undefined {
  const topic = getTopicRef(id);
  if (!topic) return undefined;

  topic.status = "closed";
  topic.closedAt = Date.now();
  topic.updatedAt = topic.closedAt;
  if (store.currentTopicId === id) store.currentTopicId = undefined;
  emitChange();
  return cloneTopic(topic);
}

export function reopenTopic(id: string): BtwTopic | undefined {
  const topic = getTopicRef(id);
  if (!topic) return undefined;

  topic.status = "open";
  topic.closedAt = undefined;
  topic.updatedAt = Date.now();
  store.currentTopicId = id;
  emitChange();
  return cloneTopic(topic);
}
