/**
 * Editor Style — adds a 𝝅 label to the top border of the input editor
 *
 * ─ 𝝅 ──────────────
 *  abc
 * ──────────────────
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

/** 𝝅 (U+1D7C5 Mathematical Bold Small Pi) */
const PI_LABEL = "𝝅";

/** Strip ANSI SGR sequences and APC sequences */
function stripInvisible(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b_P[^\x1b]*\x1b\\/g, "");
}

export class StyledEditor extends CustomEditor {
  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;

    const first = lines[0]!;
    const plain = stripInvisible(first);

    // Top border is a full-width line of ─ (possibly with scroll indicator)
    if (/^─+$/.test(plain)) {
      const prefix = `─ ${PI_LABEL} `;
      const dashes = Math.max(0, width - visibleWidth(prefix));
      lines[0] = this.borderColor(`${prefix}${"─".repeat(dashes)}`);
    }
    // If scrolled, the first line already contains "↑ N more" — leave it as-is

    return lines;
  }
}

export default function editorStyleExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
      return new StyledEditor(tui, theme, keybindings);
    });
  });
}
