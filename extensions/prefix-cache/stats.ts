/**
 * Prefix cache statistics helpers.
 *
 * These helpers only read persisted session entries. They do not inject context
 * and must remain side-effect free so cache diagnostics cannot perturb prompts.
 */

export interface CacheStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  assistantMessages: number;
  totalPrompt: number;
  hitRate: number | null;
}

export interface ThinkingStats {
  assistantMessages: number;
  thinkingBlocks: number;
  thinkingBytes: number;
  toolResultBytesMax: number;
  largeToolResults: Array<{ toolName: string; bytes: number }>;
}

function textBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function messageTextBytes(content: unknown): number {
  if (typeof content === "string") return textBytes(content);
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const block of content as any[]) {
    if (block?.type === "text" && typeof block.text === "string") {
      total += textBytes(block.text);
    }
  }
  return total;
}

export function collectCacheStats(entries: any[]): CacheStats {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let assistantMessages = 0;

  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant") continue;

    const usage = message.usage;
    if (!usage) continue;

    assistantMessages++;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
    cost += usage.cost?.total ?? 0;
  }

  const totalPrompt = input + cacheRead + cacheWrite;
  const hitRate = totalPrompt > 0 ? cacheRead / totalPrompt : null;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    assistantMessages,
    totalPrompt,
    hitRate,
  };
}

export function collectThinkingStats(entries: any[], largeToolResultBytes = 32 * 1024): ThinkingStats {
  let assistantMessages = 0;
  let thinkingBlocks = 0;
  let thinkingBytes = 0;
  let toolResultBytesMax = 0;
  const largeToolResults: Array<{ toolName: string; bytes: number }> = [];

  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (!message) continue;

    if (message.role === "assistant") {
      assistantMessages++;
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "thinking" && typeof block.thinking === "string") {
            thinkingBlocks++;
            thinkingBytes += textBytes(block.thinking);
          }
        }
      }
    }

    if (message.role === "toolResult") {
      const bytes = messageTextBytes(message.content);
      toolResultBytesMax = Math.max(toolResultBytesMax, bytes);
      if (bytes > largeToolResultBytes) {
        largeToolResults.push({
          toolName: message.toolName ?? "unknown",
          bytes,
        });
      }
    }
  }

  return {
    assistantMessages,
    thinkingBlocks,
    thinkingBytes,
    toolResultBytesMax,
    largeToolResults,
  };
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function formatHitRate(hitRate: number | null): string {
  return hitRate === null ? "n/a" : `${Math.round(hitRate * 100)}%`;
}
