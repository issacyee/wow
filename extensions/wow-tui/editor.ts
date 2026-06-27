/**
 * Wow TUI composite editor.
 *
 * Combines package-level editor visuals in one editor implementation so visual
 * features do not compete for the singleton editor component.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { ColorFn } from "./palette.ts";
import { wowColor } from "./theme.ts";

const PI_LABEL = "π";

function stripInvisible(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b_P[^\x1b]*\x1b\\/g, "");
}

function workflowBorderColor(text: string, theme: any): ColorFn | null {
  if (text.startsWith("?!") || text.startsWith("?！") || text.startsWith("？！") || text.startsWith("？!")) {
    return wowColor(theme, "workflow.reviseBorder");
  }
  if (text.startsWith("??") || text.startsWith("?？") || text.startsWith("？？") || text.startsWith("？?")) {
    return wowColor(theme, "workflow.planBorder");
  }
  if (text.startsWith("?$") || text.startsWith("?￥") || text.startsWith("？$") || text.startsWith("？￥")) {
    return wowColor(theme, "workflow.executeBorder");
  }
  if (text.startsWith("?") || text.startsWith("？")) {
    return wowColor(theme, "workflow.discussBorder");
  }
  if (text.startsWith("$") || text.startsWith("￥")) {
    return wowColor(theme, "workflow.executeBorder");
  }
  return null;
}

export class WowCompositeEditor extends CustomEditor {
  private _storedBorderColor!: ColorFn;
  private _modeBorderColor: ColorFn | null = null;

  constructor(
    tui: any,
    theme: any,
    keybindings: any,
    private readonly wowTheme: any,
    private readonly onHistoryPeek?: () => void,
    private readonly onClearHistoryPeek?: () => void,
    private readonly onReopenAsk?: () => void,
    private readonly onAskPanelInput?: (data: string) => boolean,
  ) {
    super(tui, theme, keybindings);
    this._storedBorderColor = theme.borderColor;

    Object.defineProperty(this, "borderColor", {
      get: () => this._modeBorderColor ?? this._storedBorderColor,
      set: (fn) => { this._storedBorderColor = fn; },
      configurable: true,
      enumerable: true,
    });
  }

  handleInput(data: string): void {
    if (!matchesKey(data, Key.ctrlAlt("a")) && this.onAskPanelInput?.(data)) {
      return;
    }

    if (matchesKey(data, Key.ctrl("r"))) {
      this.onHistoryPeek?.();
      return;
    }

    if (matchesKey(data, Key.ctrl("q"))) {
      this.onClearHistoryPeek?.();
      return;
    }

    if (matchesKey(data, Key.ctrlAlt("a"))) {
      this.onReopenAsk?.();
      return;
    }

    if (data.length === 1 && (data === "\uFF1F" || data === "\uFF01" || data === "\uFFE5")) {
      const text = this.getText();
      const cursor = this.getCursor();

      if (cursor.line === 0 && cursor.col === 0) {
        const map: Record<string, string> = {
          "\uFF1F": "?",
          "\uFF01": "!",
          "\uFFE5": "$",
        };
        super.handleInput(map[data]);
        return;
      }

      if (text === "?" && cursor.line === 0 && cursor.col === 1) {
        if (data === "\uFF1F") {
          super.handleInput("?");
          return;
        }
        if (data === "\uFF01") {
          super.handleInput("!");
          return;
        }
        if (data === "\uFFE5") {
          super.handleInput("$");
          return;
        }
      }
    }

    super.handleInput(data);
  }

  render(width: number): string[] {
    const text = this.getText();
    this._modeBorderColor = workflowBorderColor(text, this.wowTheme);

    const lines = super.render(width);
    if (lines.length === 0) return lines;

    const first = lines[0]!;
    const plain = stripInvisible(first);

    if (/^─+$/.test(plain)) {
      const prefix = `─ ${PI_LABEL} `;
      const dashes = Math.max(0, width - visibleWidth(prefix));
      lines[0] = this.borderColor(`${prefix}${"─".repeat(dashes)}`);
    }

    return lines;
  }
}

export function createEditorComponent(
  tui: any,
  theme: any,
  keybindings: any,
  wowTheme: any,
  onHistoryPeek?: () => void,
  onClearHistoryPeek?: () => void,
  onReopenAsk?: () => void,
  onAskPanelInput?: (data: string) => boolean,
): WowCompositeEditor {
  return new WowCompositeEditor(
    tui,
    theme,
    keybindings,
    wowTheme,
    onHistoryPeek,
    onClearHistoryPeek,
    onReopenAsk,
    onAskPanelInput,
  );
}
