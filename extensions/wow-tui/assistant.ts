/**
 * Assistant-message rendering tweaks owned by the Wow visual shell.
 */

import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { hasAskMetadata, stripAskMetadata } from "../human-led-coding-workflow/ask.ts";

const PATCH_KEY = Symbol.for("wow.tui.askMetadataAssistantRenderingPatch");

interface PatchState {
  original: (this: unknown, message: any) => void;
}

function stripAskMetadataFromMessage(message: any): any {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;

  let changed = false;
  const content = message.content.map((block: any) => {
    if (block?.type !== "text" || typeof block.text !== "string" || !hasAskMetadata(block.text)) {
      return block;
    }
    changed = true;
    return { ...block, text: stripAskMetadata(block.text) };
  });

  return changed ? { ...message, content } : message;
}

/** Hide `<!-- wow-ask:v1 ... -->` metadata in TUI assistant rendering only. */
export function installAskMetadataAssistantRendering(): void {
  const proto = (AssistantMessageComponent as any)?.prototype as any;
  if (!proto || typeof proto.updateContent !== "function") return;

  const existing = proto[PATCH_KEY] as PatchState | undefined;
  const original = existing?.original ?? proto.updateContent;

  proto.updateContent = function updateContentWithoutAskMetadata(message: any): void {
    return original.call(this, stripAskMetadataFromMessage(message));
  };
  proto[PATCH_KEY] = { original } satisfies PatchState;
}
