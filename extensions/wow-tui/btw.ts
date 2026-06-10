/**
 * BTW message renderers.
 *
 * Visual presentation for BTW side-channel messages lives in wow-tui so the
 * BTW logic extension can remain UI-independent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  BTW_DISPLAY_TYPE,
  BTW_PROMOTED_TYPE,
  type BtwDisplayDetails,
  type BtwPromotedDetails,
} from "../btw/types.ts";

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

export function registerBtwRendering(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<BtwDisplayDetails>(BTW_DISPLAY_TYPE, (message, { expanded }, theme) => {
    const details = message.details;
    const header = theme.fg("accent", theme.bold(`BTW #${details?.topicId ?? "?"}`)) +
      (details?.title ? theme.fg("muted", ` — ${details.title}`) : "");
    const content = typeof message.content === "string" ? message.content : "";
    const display = expanded ? content : truncateText(content, 4_000);

    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${header}\n${theme.fg("dim", "side-channel; hidden from main context")}\n\n${display}`, 0, 0));
    return box;
  });

  pi.registerMessageRenderer<BtwPromotedDetails>(BTW_PROMOTED_TYPE, (message, _options, theme) => {
    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    const content = typeof message.content === "string" ? message.content : "";
    box.addChild(new Text(`${theme.fg("success", theme.bold("BTW promoted"))}\n${content}`, 0, 0));
    return box;
  });
}
