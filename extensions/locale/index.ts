/**
 * Locale — OS-locale language policy
 *
 * Appends an OS-locale-backed hard language directive to the system prompt via
 * before_agent_start. The directive names the target language explicitly so the
 * model does not have to guess from each turn. On a single machine the detected
 * OS locale is stable across turns, so the system-prompt prefix cache is
 * unaffected; local UI/template code may still use detectLocale() outside LLM
 * context.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildLanguageInstruction } from "../wow/locale.ts";
import { buildStableAnswerQualityPolicy } from "../wow/quality.ts";
import { registerLocaleTips } from "./tips.ts";

// ── Extension entry ──

export default function localeExtension(pi: ExtensionAPI): void {
  const unregisterTips = registerLocaleTips();

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildLanguageInstruction()}\n\n${buildStableAnswerQualityPolicy()}`,
    };
  });

  pi.on("session_shutdown", async () => {
    unregisterTips();
  });
}
