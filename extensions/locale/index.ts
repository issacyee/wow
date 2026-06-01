/**
 * Locale — detect OS language and inject it into AI context
 *
 * The AI cannot query the OS locale itself. This extension detects the user's
 * OS language at runtime via Intl.DateTimeFormat and injects a language
 * instruction into every agent turn via before_agent_start, ensuring the AI
 * always responds in the user's language.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildLanguageInstruction } from "../wow/locale.ts";

// ── Extension entry ──

export default function localeExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (_event) => {
    const instruction = buildLanguageInstruction();
    return {
      message: {
        customType: "locale-instruction",
        content: instruction,
        display: false,
      },
    };
  });
}
