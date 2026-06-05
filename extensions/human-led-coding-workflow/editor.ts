/**
 * Editor integration for Human-Led Coding Workflow.
 *
 * Adds mode-specific border colors for workflow prefixes and converts common
 * Chinese IME full-width prefix characters at the start of the editor.
 */

import { StyledEditor } from "../editor-style/index.ts";

function rgb(r: number, g: number, b: number): (str: string) => string {
  return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}

export class HumanLedWorkflowEditor extends StyledEditor {
  private discussBorderColor: (str: string) => string;
  private planBorderColor: (str: string) => string;
  private reviseBorderColor: (str: string) => string;
  private executeBorderColor: (str: string) => string;
  /** Native border color set by the framework (thinking level, bash mode) */
  private _storedBorderColor!: (str: string) => string;
  /** Mode border color override (null = use stored native color) */
  private _modeBorderColor: ((str: string) => string) | null = null;

  constructor(tui: any, theme: any, keybindings: any) {
    super(tui, theme, keybindings);
    this.discussBorderColor = rgb(122, 94, 160);  // purple
    this.planBorderColor = rgb(245, 167, 66);     // orange
    this.reviseBorderColor = rgb(201, 168, 76);   // yellow
    this.executeBorderColor = rgb(92, 156, 245);  // blue

    this._storedBorderColor = theme.borderColor;

    Object.defineProperty(this, "borderColor", {
      get: () => this._modeBorderColor ?? this._storedBorderColor,
      set: (fn) => { this._storedBorderColor = fn; },
      configurable: true,
      enumerable: true,
    });
  }

  handleInput(data: string): void {
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
      }
    }

    super.handleInput(data);
  }

  render(width: number): string[] {
    const text = this.getText();

    if (text.startsWith("?!") || text.startsWith("?！") || text.startsWith("？！") || text.startsWith("？!")) {
      this._modeBorderColor = this.reviseBorderColor;
    } else if (text.startsWith("??") || text.startsWith("?？") || text.startsWith("？？") || text.startsWith("？?")) {
      this._modeBorderColor = this.planBorderColor;
    } else if (text.startsWith("?") || text.startsWith("？")) {
      this._modeBorderColor = this.discussBorderColor;
    } else if (text.startsWith("$") || text.startsWith("￥")) {
      this._modeBorderColor = this.executeBorderColor;
    } else {
      this._modeBorderColor = null;
    }

    return super.render(width);
  }
}
