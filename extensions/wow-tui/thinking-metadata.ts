/**
 * Sidecar persistence for Wow TUI thinking duration metadata.
 *
 * This file stores UI-only metadata outside pi's real message history. The data
 * is never written to session entries, prompts, or provider context, preserving
 * prefix-cache stability.
 */

import fs from "node:fs";
import path from "node:path";

export interface ThinkingDurationRecord {
  sessionId: string;
  assistantMessageId: string;
  contentIndex: number;
  durationMs: number;
  label?: string;
  updatedAt: string;
}

interface SidecarData {
  version: 1;
  sessionId: string;
  thinkingDurations: Record<string, ThinkingDurationRecord>;
}

export interface ThinkingMetadataStore {
  get(assistantMessageId: string, contentIndex: number): ThinkingDurationRecord | undefined;
  set(record: Omit<ThinkingDurationRecord, "sessionId" | "updatedAt">): void;
}

const SIDECAR_SUFFIX = ".wow-tui.json";

function metadataKey(sessionId: string, assistantMessageId: string, contentIndex: number): string {
  return `${sessionId}:${assistantMessageId}:${contentIndex}`;
}

function getSidecarPath(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) return undefined;

  return `${sessionFile}${SIDECAR_SUFFIX}`;
}

function createEmptyData(sessionId: string): SidecarData {
  return {
    version: 1,
    sessionId,
    thinkingDurations: {},
  };
}

function readSidecar(filePath: string | undefined, sessionId: string): SidecarData {
  if (!filePath || !fs.existsSync(filePath)) return createEmptyData(sessionId);

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SidecarData>;
    if (parsed.version !== 1 || parsed.sessionId !== sessionId || !parsed.thinkingDurations) {
      return createEmptyData(sessionId);
    }

    return {
      version: 1,
      sessionId,
      thinkingDurations: parsed.thinkingDurations,
    };
  } catch {
    return createEmptyData(sessionId);
  }
}

function writeSidecar(filePath: string | undefined, data: SidecarData): void {
  if (!filePath) return;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  } catch {
    // UI metadata must never break the coding session.
  }
}

export function openThinkingMetadataStore(sessionFile: string | undefined, sessionId: string): ThinkingMetadataStore {
  const filePath = getSidecarPath(sessionFile);
  const data = readSidecar(filePath, sessionId);

  return {
    get(assistantMessageId: string, contentIndex: number): ThinkingDurationRecord | undefined {
      return data.thinkingDurations[metadataKey(sessionId, assistantMessageId, contentIndex)];
    },

    set(record: Omit<ThinkingDurationRecord, "sessionId" | "updatedAt">): void {
      const fullRecord: ThinkingDurationRecord = {
        ...record,
        sessionId,
        durationMs: Math.max(0, Math.round(record.durationMs)),
        updatedAt: new Date().toISOString(),
      };
      data.thinkingDurations[metadataKey(sessionId, record.assistantMessageId, record.contentIndex)] = fullRecord;
      writeSidecar(filePath, data);
    },
  };
}
