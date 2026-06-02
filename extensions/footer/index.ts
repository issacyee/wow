/**
 * Footer — custom two-line footer with clickable CWD and context usage bar
 *
 * Line 1: CWD (yellow) | git branch (purple) ... LLM model (green, right-aligned)
 * Line 2: context bar (green/yellow/red) | percent | tokens (blue) | cost (yellow)
 *
 * Color palette:
 *   green  #1faf7a — LLM model, low context usage
 *   yellow #c9a84c — CWD, cost, medium context usage
 *   red    #e8634f — high context usage
 *   blue   #17dae7 — token stats
 *   purple #7a5ea0 — git branch
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { shortenPath } from "../wow/paths.ts";

// ── Color palette ──

function rgb(r: number, g: number, b: number): (s: string) => string {
  return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}

const GREEN  = rgb(0x1f, 0xaf, 0x7a);
const YELLOW = rgb(0xc9, 0xa8, 0x4c);
const RED    = rgb(0xe8, 0x63, 0x4f);
const BLUE   = rgb(0x17, 0xda, 0xe7);
const PURPLE = rgb(0x7a, 0x5e, 0xa0);
const DIM    = rgb(0x66, 0x66, 0x66);

// ── Context bar ──

const BAR_WIDTH = 10;
const FILLED = "█";
const EMPTY = "░";

function renderContextBar(percent: number | null): string {
  const pct = Math.max(0, Math.min(100, percent ?? 0));
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = FILLED.repeat(filled) + EMPTY.repeat(empty);

  const color = pct > 80 ? RED : pct > 50 ? YELLOW : GREEN;
  return color(bar);
}

function renderContextPercent(percent: number | null, contextWindow?: number): string {
  const pct = Math.round(Math.max(0, Math.min(100, percent ?? 0)));
  const color = pct > 80 ? RED : pct > 50 ? YELLOW : GREEN;
  const windowLabel = contextWindow ? `/${fmtContextWindow(contextWindow)}` : "";
  return color(` ${pct}%${windowLabel}`);
}

// ── Token formatting ──

function fmt(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

function fmtContextWindow(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

// ── Extension ──

export default function footerExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsubBranch,
        invalidate() {},
        render(width: number): string[] {
          const cwdPath = ctx.cwd ?? process.cwd();
          const cwdName = shortenPath(cwdPath);
          const cwdDisplay = YELLOW(hyperlink(cwdName, `file://${cwdPath}`));

          // Git branch
          const branch = footerData.getGitBranch();
          const branchDisplay = branch ? ` ${PURPLE(branch)}` : "";

          // Model + thinking level (right-aligned)
          const modelName = ctx.model?.id || "no-model";
          const thinkingLevel = pi.getThinkingLevel();
          const modelDisplay = thinkingLevel && thinkingLevel !== "off"
            ? GREEN(`${modelName} ${thinkingLevel}`)
            : GREEN(modelName);

          // Line 1: cwd + branch (left) ... model (right)
          // Guarantee model name is always visible; truncate left side if needed
          const line1Left = cwdDisplay + branchDisplay;
          const line1Right = modelDisplay;
          const rightWidth = visibleWidth(line1Right);
          const minGap = 1;
          const maxLeftWidth = Math.max(0, width - rightWidth - minGap);
          const line1LeftTrunc = truncateToWidth(line1Left, maxLeftWidth, "");
          const remaining = width - visibleWidth(line1LeftTrunc) - rightWidth;
          const line1Pad = " ".repeat(Math.max(minGap, remaining));
          const line1 = truncateToWidth(line1LeftTrunc + line1Pad + line1Right, width);

          // ── Line 2 ──

          // Context usage
          const usage = ctx.getContextUsage();
          const barDisplay = renderContextBar(usage?.percent ?? null);
          const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
          const pctDisplay = renderContextPercent(usage?.percent ?? null, contextWindow);

          // Token stats
          let input = 0, output = 0, cost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && (e.message as AssistantMessage).role === "assistant") {
              const m = e.message as AssistantMessage;
              input += m.usage.input;
              output += m.usage.output;
              cost += m.usage.cost.total;
            }
          }

          const tokenDisplay = BLUE(` ↑${fmt(input)} ↓${fmt(output)}`);
          const costDisplay = YELLOW(` $${cost.toFixed(3)}`);

          // Extension statuses (right side of line 2)
          const statuses = footerData.getExtensionStatuses();
          const statusTexts: string[] = [];
          for (const [, text] of statuses) {
            statusTexts.push(text);
          }
          const statusDisplay = statusTexts.length > 0 ? DIM(statusTexts.join(" ")) : "";

          // Line 2: bar + percent + tokens + cost (left) ... statuses (right)
          const line2Left = barDisplay + pctDisplay + tokenDisplay + costDisplay;
          const line2Right = statusDisplay;
          const line2Pad = " ".repeat(Math.max(1, width - visibleWidth(line2Left) - visibleWidth(line2Right)));
          const line2 = truncateToWidth(line2Left + line2Pad + line2Right, width);

          return [line1, line2];
        },
      };
    });
  });
}
