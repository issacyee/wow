/**
 * Prefix Cache — Reasonix-inspired prompt stability optimizations.
 *
 * Design rules for future extensions:
 * - Do not mutate the system prompt with per-turn timestamps, locale strings,
 *   counters, random IDs, or transient mode state.
 * - Do not switch active tools for modes such as planning; enforce permissions
 *   in tool_call gates so the tool schema prefix remains stable.
 * - Do not send response-only reasoning/thinking back to OpenAI-compatible
 *   reasoning models. Keep it in session/UI, strip it from provider context.
 * - Keep provider tool schemas deterministic: sorted tools and canonical JSON.
 */

import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { canonicalizeJson, canonicalizeTools } from "./schema.ts";
import {
  shouldStripReasoning,
  stripReasoningFromMessages,
  stripReasoningFromProviderPayload,
} from "./reasoning.ts";
import {
  collectCacheStats,
  collectThinkingStats,
  formatBytes,
  formatHitRate,
  formatTokenCount,
} from "./stats.ts";
import { registerPrefixCacheTips } from "./tips.ts";

interface PayloadDiagnostics {
  requests: number;
  lastToolsHash?: string;
  distinctToolsHashes: Set<string>;
  lastMessagePrefixHash?: string;
}

const diagnostics: PayloadDiagnostics = {
  requests: 0,
  distinctToolsHashes: new Set(),
};

const systemPromptHashes = new Set<string>();
let lastSystemPromptHash: string | undefined;
let strippedReasoningTurns = 0;

const MAX_TOOL_RESULT_CONTEXT_BYTES = 32 * 1024;

function stableHash(value: unknown): string {
  const canonical = JSON.stringify(canonicalizeJson(value));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

function hashSystemPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}

function shouldCanonicalizeProviderTools(model: any): boolean {
  const provider = String(model?.provider ?? "").toLowerCase();
  const id = String(model?.id ?? "").toLowerCase();

  // Avoid touching native providers whose tool order or cache-control placement
  // can carry provider-specific meaning. DeepSeek/OpenAI-compatible payloads are
  // the primary target for this package's prefix-cache optimization.
  if (["anthropic", "amazon-bedrock", "google", "google-vertex", "mistral"].includes(provider)) {
    return false;
  }
  if (provider === "openrouter" && id.startsWith("anthropic/")) return false;

  return true;
}

function formatCacheStats(entries: any[]): string {
  const stats = collectCacheStats(entries);
  return [
    "Prefix cache stats",
    `- assistant messages: ${stats.assistantMessages}`,
    `- input: ${formatTokenCount(stats.input)}`,
    `- output: ${formatTokenCount(stats.output)}`,
    `- cache read: ${formatTokenCount(stats.cacheRead)}`,
    `- cache write: ${formatTokenCount(stats.cacheWrite)}`,
    `- hit rate: ${formatHitRate(stats.hitRate)}`,
    `- cost: $${stats.cost.toFixed(4)}`,
  ].join("\n");
}

function countLocaleInstructionMessages(entries: any[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry?.customType === "locale-instruction") count++;
    if (entry?.type === "custom_message" && entry.customType === "locale-instruction") count++;
    if (entry?.type === "message" && entry.message?.customType === "locale-instruction") count++;
  }
  return count;
}

function formatCacheDoctor(pi: ExtensionAPI, ctx: any): string {
  const entries = ctx.sessionManager.getBranch();
  const cache = collectCacheStats(entries);
  const thinking = collectThinkingStats(entries);
  const localeMessages = countLocaleInstructionMessages(entries);
  const allTools = pi.getAllTools();
  const activeTools = pi.getActiveTools();
  const activeToolCount = activeTools.length;
  const allToolCount = allTools.length;

  const lines = [
    "Prefix cache doctor",
    `- model: ${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`,
    `- reasoning strip active: ${shouldStripReasoning(ctx.model) ? "yes" : "no"}`,
    `- stripped reasoning turns: ${strippedReasoningTurns}`,
    `- cache hit rate: ${formatHitRate(cache.hitRate)} (${formatTokenCount(cache.cacheRead)} read)`,
    `- system prompt hashes this runtime: ${systemPromptHashes.size}${lastSystemPromptHash ? ` (last ${lastSystemPromptHash})` : ""}`,
    `- provider requests observed: ${diagnostics.requests}`,
    `- tool schema hashes this runtime: ${diagnostics.distinctToolsHashes.size}${diagnostics.lastToolsHash ? ` (last ${diagnostics.lastToolsHash})` : ""}`,
    `- active tools: ${activeToolCount}/${allToolCount}`,
    `- locale custom messages in branch: ${localeMessages}`,
    `- assistant thinking stored locally: ${thinking.thinkingBlocks} blocks, ${formatBytes(thinking.thinkingBytes)}`,
    `- largest tool result in branch: ${formatBytes(thinking.toolResultBytesMax)}`,
  ];

  const warnings: string[] = [];
  if (systemPromptHashes.size > 1) {
    warnings.push("system prompt changed in this runtime; avoid per-turn system prompt mutations");
  }
  if (diagnostics.distinctToolsHashes.size > 1) {
    warnings.push("tool schema hash changed; avoid active tool switching or nondeterministic schemas");
  }
  if (activeToolCount !== allToolCount) {
    warnings.push("active tool set is filtered; mode extensions should prefer tool_call gates");
  }
  if (localeMessages > 0) {
    warnings.push("old locale custom messages exist; new locale policy should be system-prompt stable");
  }
  if (thinking.largeToolResults.length > 0) {
    warnings.push(`${thinking.largeToolResults.length} tool result(s) exceed 32KB and will burden future prefixes`);
  }

  if (warnings.length > 0) {
    lines.push("", "Warnings:", ...warnings.map((w) => `- ${w}`));
  }

  return lines.join("\n");
}

function notify(ctx: any, text: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, "info");
  } else {
    console.log(text);
  }
}

function textBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sliceUtf8(text: string, maxBytes: number): string {
  return new TextDecoder().decode(Buffer.from(text, "utf8").subarray(0, maxBytes));
}

async function truncateToolResultContent(event: any): Promise<any | undefined> {
  if (!Array.isArray(event.content)) return;

  const textBlocks = event.content.filter((block: any) => block?.type === "text" && typeof block.text === "string");
  const totalBytes = textBlocks.reduce((sum: number, block: any) => sum + textBytes(block.text), 0);
  if (totalBytes <= MAX_TOOL_RESULT_CONTEXT_BYTES) return;

  const fullText = textBlocks.map((block: any) => block.text).join("\n");
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-result-"));
  const fullOutputPath = join(dir, `${event.toolName ?? "tool"}.txt`);
  await writeFile(fullOutputPath, fullText, "utf8");

  const marker = `\n\n[prefix-cache truncated ${event.toolName ?? "tool"} result: ${MAX_TOOL_RESULT_CONTEXT_BYTES} bytes of ${totalBytes} bytes.\nFull output saved to: ${fullOutputPath}]`;
  let remaining = Math.max(0, MAX_TOOL_RESULT_CONTEXT_BYTES - textBytes(marker));
  const content: any[] = [];

  for (const block of event.content) {
    if (block?.type !== "text" || typeof block.text !== "string") {
      content.push(block);
      continue;
    }

    if (remaining <= 0) continue;

    const bytes = textBytes(block.text);
    if (bytes <= remaining) {
      content.push(block);
      remaining -= bytes;
    } else {
      content.push({ ...block, text: sliceUtf8(block.text, remaining) });
      remaining = 0;
    }
  }

  content.push({
    type: "text",
    text: marker,
  });

  return {
    content,
    details: {
      ...(event.details ?? {}),
      prefixCacheTruncated: true,
      prefixCacheFullOutputPath: fullOutputPath,
      prefixCacheOriginalBytes: totalBytes,
    },
  };
}

export default function prefixCacheExtension(pi: ExtensionAPI): void {
  const unregisterTips = registerPrefixCacheTips();

  pi.on("before_agent_start", async (event) => {
    const hash = hashSystemPrompt(event.systemPrompt ?? "");
    lastSystemPromptHash = hash;
    systemPromptHashes.add(hash);
  });

  pi.on("context", async (event, ctx) => {
    if (!shouldStripReasoning(ctx.model)) return;

    const result = stripReasoningFromMessages(event.messages as any[]);
    if (!result.changed) return;

    strippedReasoningTurns++;
    return { messages: result.messages };
  });

  pi.on("tool_result", async (event) => {
    return truncateToolResultContent(event);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    diagnostics.requests++;

    let payload: any = event.payload;
    let changed = false;

    if (shouldCanonicalizeProviderTools(ctx.model) && payload && typeof payload === "object" && Array.isArray(payload.tools)) {
      const tools = canonicalizeTools(payload.tools);
      const toolsHash = stableHash(tools);
      diagnostics.lastToolsHash = toolsHash;
      diagnostics.distinctToolsHashes.add(toolsHash);
      payload = { ...payload, tools };
      changed = true;
    }

    if (payload && typeof payload === "object" && Array.isArray(payload.messages)) {
      diagnostics.lastMessagePrefixHash = stableHash(payload.messages.slice(0, -1));
    }

    if (shouldStripReasoning(ctx.model)) {
      const result = stripReasoningFromProviderPayload(payload);
      payload = result.payload;
      changed = changed || result.changed;
    }

    return changed ? payload : undefined;
  });

  pi.registerCommand("cache-stats", {
    description: "Show session prefix-cache usage statistics",
    handler: async (_args, ctx) => {
      notify(ctx, formatCacheStats(ctx.sessionManager.getBranch()));
    },
  });

  pi.registerCommand("cache-doctor", {
    description: "Diagnose common prefix-cache stability problems",
    handler: async (_args, ctx) => {
      notify(ctx, formatCacheDoctor(pi, ctx));
    },
  });

  pi.on("session_shutdown", async () => {
    unregisterTips();
  });
}
