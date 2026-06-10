/**
 * State store for BTW side-channel Q&A topics.
 *
 * BTW state is persisted via pi.appendEntry() custom entries only. It is not
 * injected into the main LLM context unless explicitly promoted by the user.
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
}

type Listener = () => void;

let currentTopicId: string | undefined;
let nextId = 1;
let topics: BtwTopic[] = [];
const listeners = new Set<Listener>();

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
  for (const listener of listeners) listener();
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
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetBtwState(): void {
  currentTopicId = undefined;
  nextId = 1;
  topics = [];
  emitChange();
}

export function restoreBtwState(data: Partial<BtwState> | undefined): void {
  const restoredTopics = Array.isArray(data?.topics)
    ? data.topics.map(normalizeTopic).filter((topic): topic is BtwTopic => topic !== null)
    : [];

  topics = restoredTopics;
  nextId = normalizeNextId(data?.nextId, restoredTopics);

  const restoredCurrent = typeof data?.currentTopicId === "string" ? data.currentTopicId : undefined;
  currentTopicId = restoredCurrent && topics.some((topic) => topic.id === restoredCurrent && topic.status === "open")
    ? restoredCurrent
    : undefined;

  emitChange();
}

export function currentBtwState(): BtwState {
  return {
    currentTopicId,
    nextId,
    topics: cloneTopics(topics),
  };
}

export function getCurrentTopicId(): string | undefined {
  return currentTopicId;
}

export function setCurrentTopicId(id: string | undefined): void {
  currentTopicId = id;
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
    id: `b${nextId++}`,
    title: input.title,
    status: "open",
    anchorEntryId: input.anchorEntryId,
    anchorExcerpt: input.anchorExcerpt,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };

  topics.push(topic);
  currentTopicId = topic.id;
  emitChange();
  return cloneTopic(topic);
}

export function getTopic(id: string | undefined): BtwTopic | undefined {
  if (!id) return undefined;
  const topic = topics.find((candidate) => candidate.id === id);
  return topic ? cloneTopic(topic) : undefined;
}

export function getTopicRef(id: string | undefined): BtwTopic | undefined {
  if (!id) return undefined;
  return topics.find((candidate) => candidate.id === id);
}

export function getTopics(status: BtwTopicStatus | "all" = "all"): BtwTopic[] {
  const filtered = status === "all" ? topics : topics.filter((topic) => topic.status === status);
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
  if (currentTopicId === id) currentTopicId = undefined;
  emitChange();
  return cloneTopic(topic);
}

export function reopenTopic(id: string): BtwTopic | undefined {
  const topic = getTopicRef(id);
  if (!topic) return undefined;

  topic.status = "open";
  topic.closedAt = undefined;
  topic.updatedAt = Date.now();
  currentTopicId = id;
  emitChange();
  return cloneTopic(topic);
}
