/**
 * BTW — isolated side-channel Q&A threads.
 *
 * /btw and /btw:* commands let the user ask multi-turn clarification
 * questions without polluting the main agent context. Each topic is persisted
 * as custom state outside LLM context. Only /btw:promote writes a concise note
 * back into the main conversation.
 */

import type { Message } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  BTW_PROMOTE_SYSTEM_PROMPT,
  BTW_SYSTEM_PROMPT,
  buildPromotionPrompt,
  buildTopicContext,
  selectRecentMessages,
} from "./prompts.ts";
import { BTW_DISPLAY_TYPE, BTW_PROMOTED_TYPE } from "./types.ts";
import {
  addTopicMessage,
  closeTopic,
  createTopic,
  currentBtwState,
  getCurrentTopicId,
  getTopic,
  getTopics,
  reopenTopic,
  resetBtwState,
  restoreBtwState,
  setCurrentTopicId,
  updateTopicSummary,
  BTW_STATE_TYPE,
  type BtwMessage,
  type BtwTopic,
  type BtwTopicStatus,
} from "./state.ts";

const MAX_TITLE_CHARS = 56;
const MAX_DISPLAY_CONTENT_CHARS = 24_000;
const INLINE_TOPIC_PATTERN = /^#([A-Za-z0-9_-]+)\s+([\s\S]+)$/;

interface AnchorInfo {
  entryId?: string;
  excerpt?: string;
}

interface CommandCompletionItem {
  value: string;
  label: string;
  description?: string;
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
  } else {
    console.log(text);
  }
}

function normalizeTopicId(raw: string | undefined): string | undefined {
  const id = raw?.trim().replace(/^#/, "");
  return id || undefined;
}

function firstArg(args: string): string | undefined {
  return normalizeTopicId(args.trim().split(/\s+/, 1)[0]);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function deriveTitle(question: string): string {
  const title = singleLine(question).replace(/^#+\s*/, "");
  if (!title) return "BTW topic";
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

function getTextContent(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

function latestAssistantAnchor(ctx: ExtensionContext): AnchorInfo {
  const branch = ctx.sessionManager.getBranch() as any[];

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;

    const text = getTextContent(entry.message).trim();
    if (!text) continue;

    return {
      entryId: typeof entry.id === "string" ? entry.id : undefined,
      excerpt: truncateText(text, 6_000),
    };
  }

  return {};
}

function latestBtwState(ctx: ExtensionContext): any | undefined {
  const entry = (ctx.sessionManager.getBranch() as any[])
    .filter((candidate: any) => candidate?.type === "custom" && candidate.customType === BTW_STATE_TYPE)
    .pop() as { data?: any } | undefined;
  return entry?.data;
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry(BTW_STATE_TYPE, currentBtwState());
}

function formatTopicLine(topic: BtwTopic, currentId?: string): string {
  const marker = topic.id === currentId ? "*" : " ";
  const status = topic.status === "open" ? "open" : "closed";
  const turns = Math.ceil(topic.messages.length / 2);
  return `${marker} #${topic.id} [${status}] ${topic.title} (${turns} turn${turns === 1 ? "" : "s"})`;
}

function topicSelectLabel(topic: BtwTopic): string {
  return `#${topic.id} — ${topic.title}${topic.status === "closed" ? " [closed]" : ""}`;
}

function parseTopicSelectLabel(label: string): string | undefined {
  const match = label.match(/^#([^\s]+)\s/);
  return match?.[1];
}

function topicCompletions(status: BtwTopicStatus | "all") {
  return (prefix: string): CommandCompletionItem[] | null => {
    const query = prefix.trim().replace(/^#/, "").toLowerCase();
    const items = getTopics(status)
      .filter((topic) =>
        !query ||
        topic.id.toLowerCase().startsWith(query) ||
        topic.title.toLowerCase().includes(query)
      )
      .map((topic) => ({
        value: topic.id,
        label: `#${topic.id}`,
        description: `${topic.status} · ${topic.title}`,
      }));

    return items.length > 0 ? items : null;
  };
}

async function selectTopic(
  ctx: ExtensionCommandContext,
  options: {
    title: string;
    status: BtwTopicStatus | "all";
    allowNew?: boolean;
  },
): Promise<string | "__new__" | undefined> {
  const topics = getTopics(options.status);
  if (topics.length === 0 && !options.allowNew) return undefined;

  if (!ctx.hasUI) {
    if (topics.length === 1) return topics[0].id;
    return options.allowNew ? "__new__" : undefined;
  }

  const choices = [
    ...(options.allowNew ? ["+ New BTW topic"] : []),
    ...topics.map(topicSelectLabel),
  ];

  const selected = await ctx.ui.select(options.title, choices);
  if (!selected) return undefined;
  if (selected.startsWith("+ ")) return "__new__";
  return parseTopicSelectLabel(selected);
}

function getCurrentOpenTopic(): BtwTopic | undefined {
  const current = getTopic(getCurrentTopicId());
  return current?.status === "open" ? current : undefined;
}

async function resolveTopicForQuestion(ctx: ExtensionCommandContext, question: string): Promise<BtwTopic | undefined> {
  const inline = question.match(INLINE_TOPIC_PATTERN);
  if (inline) {
    const topic = getTopic(normalizeTopicId(inline[1]));
    if (!topic) {
      notify(ctx, `BTW topic not found: #${inline[1]}`, "error");
      return undefined;
    }
    if (topic.status !== "open") {
      notify(ctx, `BTW topic #${topic.id} is closed. Use /btw:reopen ${topic.id} first.`, "warning");
      return undefined;
    }
    setCurrentTopicId(topic.id);
    return topic;
  }

  const current = getCurrentOpenTopic();
  if (current) return current;

  const openTopics = getTopics("open");
  if (openTopics.length > 0) {
    const selected = await selectTopic(ctx, {
      title: "Continue which BTW topic?",
      status: "open",
      allowNew: true,
    });

    if (!selected) return undefined;
    if (selected !== "__new__") {
      const topic = getTopic(selected);
      if (topic) {
        setCurrentTopicId(topic.id);
        return topic;
      }
    }
  }

  const anchor = latestAssistantAnchor(ctx);
  return createTopic({
    title: deriveTitle(question),
    anchorEntryId: anchor.entryId,
    anchorExcerpt: anchor.excerpt,
  });
}

function questionWithoutInlineTopic(question: string): string {
  const inline = question.match(INLINE_TOPIC_PATTERN);
  return inline ? inline[2].trim() : question.trim();
}

async function getAuth(ctx: ExtensionCommandContext): Promise<{ apiKey: string; headers?: Record<string, string> } | undefined> {
  if (!ctx.model) {
    notify(ctx, "No model selected", "error");
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    notify(ctx, auth.ok ? `No API key for ${ctx.model.provider}` : auth.error, "error");
    return undefined;
  }

  return { apiKey: auth.apiKey, headers: auth.headers };
}

function topicMessagesForModel(topic: BtwTopic): Message[] {
  const selectedHistory = selectRecentMessages(topic.messages);
  const omitted = selectedHistory.length < topic.messages.length
    ? "\n\n[Older BTW messages were omitted due to length.]"
    : "";
  const transcript = selectedHistory
    .map((message) => `${message.role === "user" ? "User" : "BTW"}: ${message.text}`)
    .join("\n\n");

  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            buildTopicContext(topic),
            `BTW transcript so far:\n${transcript || "(empty)"}${omitted}`,
            "Answer the latest User message in the BTW transcript.",
          ].join("\n\n"),
        },
      ],
      timestamp: Date.now(),
    },
  ];
}

function extractResponseText(response: any): string {
  return response.content
    .filter((block: any): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

function sendBtwDisplay(pi: ExtensionAPI, topic: BtwTopic, content: string, kind: string, ctx?: ExtensionContext): void {
  const displayedContent = truncateText(content, MAX_DISPLAY_CONTENT_CHARS);
  if (ctx && !ctx.hasUI) {
    console.log(displayedContent);
  }

  pi.sendMessage(
    {
      customType: BTW_DISPLAY_TYPE,
      content: displayedContent,
      display: true,
      details: {
        kind,
        topicId: topic.id,
        title: topic.title,
        status: topic.status,
      },
    },
    { triggerTurn: false },
  );
}

async function askBtw(pi: ExtensionAPI, ctx: ExtensionCommandContext, topic: BtwTopic, rawQuestion: string): Promise<void> {
  const question = questionWithoutInlineTopic(rawQuestion);
  if (!question) {
    notify(ctx, "Usage: /btw <question>", "info");
    return;
  }

  const auth = await getAuth(ctx);
  if (!auth || !ctx.model) return;

  const now = Date.now();
  addTopicMessage(topic.id, { role: "user", text: question, timestamp: now });
  setCurrentTopicId(topic.id);
  persistState(pi);

  const updatedTopic = getTopic(topic.id) ?? topic;
  notify(ctx, `BTW #${updatedTopic.id}: asking...`, "info");

  let response: any;
  try {
    response = await complete(
      ctx.model,
      {
        systemPrompt: BTW_SYSTEM_PROMPT,
        messages: topicMessagesForModel(updatedTopic),
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
      },
    );
  } catch (error: any) {
    notify(ctx, `BTW request failed: ${error?.message ?? String(error)}`, "error");
    return;
  }

  if (response.stopReason === "aborted") {
    notify(ctx, "BTW cancelled", "info");
    return;
  }

  const answer = extractResponseText(response);
  if (!answer) {
    notify(ctx, "BTW produced no answer", "warning");
    return;
  }

  const assistantMessage: BtwMessage = {
    role: "assistant",
    text: answer,
    timestamp: Date.now(),
  };
  const finalTopic = addTopicMessage(topic.id, assistantMessage) ?? updatedTopic;
  persistState(pi);
  sendBtwDisplay(pi, finalTopic, answer, "answer", ctx);
}

function formatTopicTranscript(topic: BtwTopic): string {
  const lines = [
    `# BTW #${topic.id}: ${topic.title}`,
    "",
    `Status: ${topic.status}`,
  ];

  if (topic.anchorExcerpt) {
    lines.push("", "## Anchor", "", truncateText(topic.anchorExcerpt, 2_000));
  }

  if (topic.summary) {
    lines.push("", "## Summary", "", topic.summary);
  }

  lines.push("", "## Transcript", "");
  if (topic.messages.length === 0) {
    lines.push("(empty)");
  } else {
    for (const message of topic.messages) {
      lines.push(`### ${message.role === "user" ? "User" : "BTW"}`, "", message.text, "");
    }
  }

  return lines.join("\n");
}

async function resolveTopicFromArgs(
  args: string,
  ctx: ExtensionCommandContext,
  options: {
    status: BtwTopicStatus | "all";
    fallbackCurrent?: boolean;
    selectTitle: string;
  },
): Promise<BtwTopic | undefined> {
  const requestedId = firstArg(args);
  if (requestedId) {
    const topic = getTopic(requestedId);
    if (!topic) {
      notify(ctx, `BTW topic not found: #${requestedId}`, "error");
      return undefined;
    }
    if (options.status !== "all" && topic.status !== options.status) {
      notify(ctx, `BTW topic #${topic.id} is ${topic.status}, not ${options.status}.`, "warning");
      return undefined;
    }
    return topic;
  }

  if (options.fallbackCurrent) {
    const current = getTopic(getCurrentTopicId());
    if (current && (options.status === "all" || current.status === options.status)) return current;
  }

  const selected = await selectTopic(ctx, {
    title: options.selectTitle,
    status: options.status,
  });
  return selected ? getTopic(selected) : undefined;
}

async function promoteTopic(pi: ExtensionAPI, ctx: ExtensionCommandContext, topic: BtwTopic): Promise<void> {
  if (topic.messages.length === 0) {
    notify(ctx, `BTW #${topic.id} has no transcript to promote.`, "warning");
    return;
  }

  const auth = await getAuth(ctx);
  if (!auth || !ctx.model) return;

  notify(ctx, `Summarizing BTW #${topic.id} for promotion...`, "info");
  let response: any;
  try {
    response = await complete(
      ctx.model,
      {
        systemPrompt: BTW_PROMOTE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildPromotionPrompt(topic) }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
      },
    );
  } catch (error: any) {
    notify(ctx, `BTW promotion failed: ${error?.message ?? String(error)}`, "error");
    return;
  }

  if (response.stopReason === "aborted") {
    notify(ctx, "BTW promotion cancelled", "info");
    return;
  }

  const summary = extractResponseText(response);
  if (!summary) {
    notify(ctx, "BTW promotion produced no summary", "warning");
    return;
  }

  let approved = true;
  if (ctx.hasUI) {
    approved = await ctx.ui.confirm(
      `Promote BTW #${topic.id}?`,
      `${summary}\n\nThis note will be visible to the main agent context.`,
    );
  }

  if (!approved) {
    notify(ctx, "BTW promotion skipped", "info");
    return;
  }

  const promoted = `[BTW promoted from #${topic.id}: ${topic.title}]\n${summary}`;
  updateTopicSummary(topic.id, summary);
  persistState(pi);

  pi.sendMessage(
    {
      customType: BTW_PROMOTED_TYPE,
      content: promoted,
      display: true,
      details: {
        topicId: topic.id,
        title: topic.title,
      },
    },
    { triggerTurn: false },
  );

  notify(ctx, `Promoted BTW #${topic.id}`, "info");
}

function messageCustomType(message: any): string | undefined {
  return typeof message?.customType === "string" ? message.customType : undefined;
}

export default function btwExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    resetBtwState();
    restoreBtwState(latestBtwState(ctx));
  });

  pi.on("session_tree", async (_event, ctx) => {
    resetBtwState();
    restoreBtwState(latestBtwState(ctx));
  });

  pi.on("context", async (event) => {
    let changed = false;
    const messages = event.messages.filter((message: any) => {
      if (messageCustomType(message) !== BTW_DISPLAY_TYPE) return true;
      changed = true;
      return false;
    });

    if (changed) return { messages };
  });

  pi.registerCommand("btw", {
    description: "Ask an isolated side-channel question without polluting main context",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        notify(ctx, "Usage: /btw <question>", "info");
        return;
      }

      const topic = await resolveTopicForQuestion(ctx, question);
      if (!topic) return;
      await askBtw(pi, ctx, topic, question);
    },
  });

  pi.registerCommand("btw:new", {
    description: "Start a new isolated BTW topic and ask a question",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        notify(ctx, "Usage: /btw:new <question>", "info");
        return;
      }

      const anchor = latestAssistantAnchor(ctx);
      const topic = createTopic({
        title: deriveTitle(question),
        anchorEntryId: anchor.entryId,
        anchorExcerpt: anchor.excerpt,
      });
      persistState(pi);
      await askBtw(pi, ctx, topic, question);
    },
  });

  pi.registerCommand("btw:list", {
    description: "List BTW topics (use --all or --closed for archived topics)",
    handler: async (args, _ctx) => {
      const trimmed = args.trim();
      const status = trimmed.includes("--all") ? "all" : trimmed.includes("--closed") ? "closed" : "open";
      const topics = getTopics(status as BtwTopicStatus | "all");
      const currentId = getCurrentTopicId();
      const content = topics.length > 0
        ? [`BTW topics (${status})`, "", ...topics.map((topic) => formatTopicLine(topic, currentId))].join("\n")
        : `No BTW topics (${status}). Use /btw:new <question> to start one.`;

      sendBtwDisplay(pi, {
        id: "list",
        title: "topics",
        status: "open",
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }, content, "list", _ctx);
    },
  });

  pi.registerCommand("btw:switch", {
    description: "Switch the current BTW topic",
    getArgumentCompletions: topicCompletions("open"),
    handler: async (args, ctx) => {
      const topic = await resolveTopicFromArgs(args, ctx, {
        status: "open",
        selectTitle: "Switch to BTW topic",
      });
      if (!topic) {
        notify(ctx, "No open BTW topic selected", "info");
        return;
      }

      setCurrentTopicId(topic.id);
      persistState(pi);
      notify(ctx, `Current BTW topic: #${topic.id} ${topic.title}`, "info");
    },
  });

  pi.registerCommand("btw:show", {
    description: "Show a BTW topic transcript",
    getArgumentCompletions: topicCompletions("all"),
    handler: async (args, ctx) => {
      const topic = await resolveTopicFromArgs(args, ctx, {
        status: "all",
        fallbackCurrent: true,
        selectTitle: "Show BTW topic",
      });
      if (!topic) {
        notify(ctx, "No BTW topic selected", "info");
        return;
      }

      sendBtwDisplay(pi, topic, formatTopicTranscript(topic), "show", ctx);
    },
  });

  pi.registerCommand("btw:close", {
    description: "Close/archive a BTW topic without deleting it",
    getArgumentCompletions: topicCompletions("open"),
    handler: async (args, ctx) => {
      const topic = await resolveTopicFromArgs(args, ctx, {
        status: "open",
        fallbackCurrent: true,
        selectTitle: "Close BTW topic",
      });
      if (!topic) {
        notify(ctx, "No open BTW topic selected", "info");
        return;
      }

      const closed = closeTopic(topic.id);
      persistState(pi);
      notify(ctx, closed ? `Closed BTW #${closed.id}: ${closed.title}` : `BTW topic not found: #${topic.id}`, closed ? "info" : "error");
    },
  });

  pi.registerCommand("btw:reopen", {
    description: "Reopen an archived BTW topic",
    getArgumentCompletions: topicCompletions("closed"),
    handler: async (args, ctx) => {
      const topic = await resolveTopicFromArgs(args, ctx, {
        status: "closed",
        selectTitle: "Reopen BTW topic",
      });
      if (!topic) {
        notify(ctx, "No closed BTW topic selected", "info");
        return;
      }

      const reopened = reopenTopic(topic.id);
      persistState(pi);
      notify(ctx, reopened ? `Reopened BTW #${reopened.id}: ${reopened.title}` : `BTW topic not found: #${topic.id}`, reopened ? "info" : "error");
    },
  });

  pi.registerCommand("btw:promote", {
    description: "Promote a concise BTW conclusion into the main context",
    getArgumentCompletions: topicCompletions("all"),
    handler: async (args, ctx) => {
      const topic = await resolveTopicFromArgs(args, ctx, {
        status: "all",
        fallbackCurrent: true,
        selectTitle: "Promote BTW topic",
      });
      if (!topic) {
        notify(ctx, "No BTW topic selected", "info");
        return;
      }

      await promoteTopic(pi, ctx, topic);
    },
  });
}
