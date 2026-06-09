/**
 * Locale — byte-stable language policy
 *
 * Prefix-cache rule: do not inject OS-specific language messages into every
 * turn. A generic same-language policy is appended to the system prompt with
 * identical bytes each turn, while local UI/template code may still use OS
 * locale outside LLM context.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildStableLanguagePolicy } from "../wow/locale.ts";

// ── Extension entry ──

export default function localeExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildStableLanguagePolicy()}`,
    };
  });
}
