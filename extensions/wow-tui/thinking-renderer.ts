/**
 * Per-message hidden Thinking timer rendering for Wow TUI.
 *
 * Pi's public hidden Thinking label API is global, so live timer updates would
 * rewrite historical assistant messages. This module keeps labels per assistant
 * message object and patches only the hidden Thinking label component inside the
 * affected AssistantMessageComponent.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface PatchedAssistantMessageComponent extends AssistantMessageComponent {
  contentContainer?: { children?: unknown[] };
  hideThinkingBlock?: boolean;
}

interface ThinkingRendererState {
  installed: boolean;
  originalUpdateContent?: (this: AssistantMessageComponent, message: AssistantMessage) => void;
  originalSetHiddenThinkingLabel?: (this: AssistantMessageComponent, label: string) => void;
  labelsByMessage: WeakMap<AssistantMessage, Map<number, string>>;
  componentsByMessage: WeakMap<AssistantMessage, AssistantMessageComponent>;
  colorThinkingText: (text: string) => string;
}

const STATE_KEY = Symbol.for("wow-tui.thinking-renderer.state");
const stateHolder = globalThis as typeof globalThis & { [STATE_KEY]?: ThinkingRendererState };

function getState(): ThinkingRendererState {
  if (!stateHolder[STATE_KEY]) {
    stateHolder[STATE_KEY] = {
      installed: false,
      labelsByMessage: new WeakMap(),
      componentsByMessage: new WeakMap(),
      colorThinkingText: (text: string) => text,
    };
  }

  return stateHolder[STATE_KEY];
}

function isThinkingContent(content: unknown): content is { type: "thinking"; thinking: string } {
  return Boolean(
    content &&
    typeof content === "object" &&
    (content as { type?: unknown }).type === "thinking" &&
    typeof (content as { thinking?: unknown }).thinking === "string" &&
    (content as { thinking: string }).thinking.trim(),
  );
}

function hasVisibleContentAfter(message: AssistantMessage, contentIndex: number): boolean {
  return message.content
    .slice(contentIndex + 1)
    .some((content) =>
      (content.type === "text" && content.text.trim()) ||
      (content.type === "thinking" && content.thinking.trim())
    );
}

function hasVisibleContent(message: AssistantMessage): boolean {
  return message.content.some((content) =>
    (content.type === "text" && content.text.trim()) ||
    (content.type === "thinking" && content.thinking.trim())
  );
}

function replaceHiddenThinkingLabels(component: AssistantMessageComponent, message: AssistantMessage): void {
  const messageComponent = component as PatchedAssistantMessageComponent;
  const labels = getState().labelsByMessage.get(message);
  const contentChildren = messageComponent.contentContainer?.children;
  if (!labels || !contentChildren || messageComponent.hideThinkingBlock !== true) return;

  const color = getState().colorThinkingText;
  let childIndex = hasVisibleContent(message) ? 1 : 0;

  for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
    const content = message.content[contentIndex];

    if (content.type === "text" && content.text.trim()) {
      childIndex++;
      continue;
    }

    if (!isThinkingContent(content)) continue;

    const label = labels.get(contentIndex);
    if (label && contentChildren[childIndex]) {
      contentChildren[childIndex] = new Text(color(label), 1, 0);
    }

    childIndex++;
    if (hasVisibleContentAfter(message, contentIndex)) {
      childIndex++;
    }
  }
}

export function installThinkingRendererPatch(): void {
  const state = getState();
  if (state.installed) return;

  const prototype = AssistantMessageComponent.prototype as AssistantMessageComponent;
  state.originalUpdateContent = prototype.updateContent;
  state.originalSetHiddenThinkingLabel = prototype.setHiddenThinkingLabel;

  prototype.updateContent = function updateContentWithThinkingTimers(message: AssistantMessage): void {
    state.componentsByMessage.set(message, this);
    state.originalUpdateContent!.call(this, message);
    replaceHiddenThinkingLabels(this, message);
  };

  prototype.setHiddenThinkingLabel = function setHiddenThinkingLabelWithoutHistoricalTimerRefresh(label: string): void {
    state.originalSetHiddenThinkingLabel!.call(this, label);
    const lastMessage = (this as { lastMessage?: AssistantMessage }).lastMessage;
    if (lastMessage) {
      replaceHiddenThinkingLabels(this, lastMessage);
    }
  };

  state.installed = true;
}

export function setThinkingLabelColor(color: (text: string) => string): void {
  getState().colorThinkingText = color;
}

export function setThinkingLabel(message: AssistantMessage, contentIndex: number, label: string): void {
  const state = getState();
  let labels = state.labelsByMessage.get(message);
  if (!labels) {
    labels = new Map();
    state.labelsByMessage.set(message, labels);
  }

  labels.set(contentIndex, label);
}

export function getThinkingLabel(message: AssistantMessage, contentIndex: number): string | undefined {
  return getState().labelsByMessage.get(message)?.get(contentIndex);
}

export function refreshThinkingMessage(message: AssistantMessage): void {
  const component = getState().componentsByMessage.get(message);
  if (!component) return;

  component.updateContent(message);
}

export function getThinkingMessageComponent(message: AssistantMessage): AssistantMessageComponent | undefined {
  return getState().componentsByMessage.get(message);
}

