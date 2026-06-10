/**
 * Prompt builders for BTW side-channel Q&A.
 *
 * These prompts are used only for standalone complete() calls. They are not
 * injected into the main pi agent context.
 */

import type { BtwMessage, BtwTopic } from "./state.ts";

const MAX_ANCHOR_CHARS = 6_000;
const MAX_HISTORY_CHARS = 24_000;

export const BTW_SYSTEM_PROMPT = `You are BTW, an isolated side-channel explainer for a coding agent session.

Purpose:
- Answer the user's conceptual questions, terminology questions, and clarification requests.
- Keep this side conversation separate from the main coding task.

Rules:
- Reply in the same language as the user's question.
- Prefer concise, concrete explanations with examples when useful.
- You cannot edit files, run tools, or change the main task state.
- Do not claim that the main agent will remember this side conversation.
- If something should affect the main task, say so explicitly as a short candidate conclusion the user may promote later.`;

export const BTW_PROMOTE_SYSTEM_PROMPT = `Summarize a side-channel BTW discussion for inclusion in the main coding-agent context.

Rules:
- Output only the promoted note, no preamble.
- Keep it concise and task-relevant.
- Preserve technical identifiers exactly.
- Do not include the whole learning process; include only conclusions, constraints, or decisions that matter for future work.
- Use the same language as the discussion.`;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

function formatMessage(message: BtwMessage): string {
  const role = message.role === "user" ? "User" : "BTW";
  return `${role}: ${message.text}`;
}

export function buildTopicContext(topic: BtwTopic): string {
  const sections = [
    `BTW topic: #${topic.id} ${topic.title}`,
  ];

  if (topic.anchorExcerpt) {
    sections.push([
      "Main-session anchor excerpt for context only:",
      "<anchor>",
      truncate(topic.anchorExcerpt, MAX_ANCHOR_CHARS),
      "</anchor>",
    ].join("\n"));
  }

  if (topic.summary) {
    sections.push([
      "Earlier BTW summary:",
      topic.summary,
    ].join("\n"));
  }

  return sections.join("\n\n");
}

export function selectRecentMessages(messages: BtwMessage[]): BtwMessage[] {
  const selected: BtwMessage[] = [];
  let total = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const size = formatMessage(message).length + 2;
    if (selected.length > 0 && total + size > MAX_HISTORY_CHARS) break;
    selected.unshift(message);
    total += size;
  }

  return selected;
}

export function buildPromotionPrompt(topic: BtwTopic): string {
  const allMessages = topic.messages.map(formatMessage).join("\n\n");
  const messages = selectRecentMessages(topic.messages).map(formatMessage).join("\n\n");
  const omitted = messages.length < allMessages.length
    ? "\n\n[Older BTW messages were omitted due to length.]"
    : "";

  return [
    `BTW topic: #${topic.id} ${topic.title}`,
    topic.anchorExcerpt ? `Main-session anchor excerpt:\n${truncate(topic.anchorExcerpt, MAX_ANCHOR_CHARS)}` : undefined,
    topic.summary ? `Earlier BTW summary:\n${topic.summary}` : undefined,
    `BTW transcript:\n${messages || "(empty)"}${omitted}`,
  ].filter(Boolean).join("\n\n");
}
