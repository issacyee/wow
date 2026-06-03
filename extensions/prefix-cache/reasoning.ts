/**
 * Reasoning/thinking stripping for prefix-cache friendly provider requests.
 *
 * Pi keeps thinking blocks in the session so the UI/export can still show them.
 * For DeepSeek/OpenAI-compatible reasoning models, we remove those blocks from
 * the LLM context copy and final provider payload to avoid paying to re-upload
 * response-only reasoning on every later turn.
 */

const PRESERVE_THINKING_PROVIDERS = new Set([
  "anthropic",
  "amazon-bedrock",
  "google",
  "google-vertex",
  "mistral",
]);

const OPENAI_COMPAT_HINTS = [
  "deepseek",
  "openai",
  "openrouter",
  "together",
  "zai",
  "moonshot",
  "opencode",
  "chutes",
  "cerebras",
  "xai",
  "cloudflare",
];

export function shouldStripReasoning(model: any): boolean {
  if (!model?.reasoning) return false;

  const provider = String(model.provider ?? "").toLowerCase();
  if (PRESERVE_THINKING_PROVIDERS.has(provider)) return false;

  const id = String(model.id ?? "").toLowerCase();
  const baseUrl = String(model.baseUrl ?? "").toLowerCase();
  const haystack = `${provider} ${id} ${baseUrl}`;

  return OPENAI_COMPAT_HINTS.some((hint) => haystack.includes(hint));
}

export function stripAssistantThinkingBlocks(message: any): any {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;

  let changed = false;
  const content = message.content.flatMap((block: any) => {
    if (block?.type === "thinking") {
      changed = true;
      return [];
    }

    if (block?.type === "toolCall" && block.thoughtSignature !== undefined) {
      changed = true;
      const { thoughtSignature: _thoughtSignature, ...rest } = block;
      return [rest];
    }

    return [block];
  });

  if (!changed) return message;
  return { ...message, content };
}

export function stripReasoningFromMessages(messages: any[]): { messages: any[]; changed: boolean } {
  let changed = false;
  const next = messages.map((message) => {
    const stripped = stripAssistantThinkingBlocks(message);
    if (stripped !== message) changed = true;
    return stripped;
  });

  return { messages: next, changed };
}

export function stripReasoningFromProviderPayload(payload: any): { payload: any; changed: boolean } {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) {
    return { payload, changed: false };
  }

  let changed = false;
  const messages = payload.messages.map((message: any) => {
    if (message?.role !== "assistant" || typeof message !== "object") return message;

    const next = { ...message };
    for (const key of ["reasoning_content", "reasoning", "reasoning_text", "reasoning_details"] as const) {
      if (key in next) {
        delete next[key];
        changed = true;
      }
    }
    return next;
  });

  if (!changed) return { payload, changed: false };
  return { payload: { ...payload, messages }, changed: true };
}
