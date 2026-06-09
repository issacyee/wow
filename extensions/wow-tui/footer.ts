/**
 * Wow TUI footer compositor.
 *
 * Owns the package footer as a single composed TUI surface. Feature extensions
 * should expose state; this module decides how that state is displayed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { shortenPath } from "../wow/paths.ts";
import { collectCacheStats } from "../prefix-cache/stats.ts";
import { BLUE, DIM, GREEN, PURPLE, RED, YELLOW } from "./palette.ts";

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

function fmt(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

function fmtContextWindow(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

function renderContextPercent(percent: number | null, contextWindow?: number): string {
  const pct = Math.round(Math.max(0, Math.min(100, percent ?? 0)));
  const color = pct > 80 ? RED : pct > 50 ? YELLOW : GREEN;
  const windowLabel = contextWindow ? `/${fmtContextWindow(contextWindow)}` : "";
  return color(` ${pct}%${windowLabel}`);
}

export function installFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  ctx.ui.setFooter((tui, _theme, footerData) => {
    const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubBranch,
      invalidate() {},
      render(width: number): string[] {
        const cwdPath = ctx.cwd ?? process.cwd();
        const cwdName = shortenPath(cwdPath);
        const cwdDisplay = YELLOW(hyperlink(cwdName, `file://${cwdPath}`));

        const branch = footerData.getGitBranch();
        const branchDisplay = branch ? ` ${PURPLE(branch)}` : "";

        const modelName = ctx.model?.id || "no-model";
        const thinkingLevel = pi.getThinkingLevel();
        const modelDisplay = thinkingLevel && thinkingLevel !== "off"
          ? GREEN(`${modelName} ${thinkingLevel}`)
          : GREEN(modelName);

        const line1Left = cwdDisplay + branchDisplay;
        const line1Right = modelDisplay;
        const rightWidth = visibleWidth(line1Right);
        const minGap = 1;
        const maxLeftWidth = Math.max(0, width - rightWidth - minGap);
        const line1LeftTrunc = truncateToWidth(line1Left, maxLeftWidth, "");
        const remaining = width - visibleWidth(line1LeftTrunc) - rightWidth;
        const line1Pad = " ".repeat(Math.max(minGap, remaining));
        const line1 = truncateToWidth(line1LeftTrunc + line1Pad + line1Right, width);

        const usage = ctx.getContextUsage();
        const barDisplay = renderContextBar(usage?.percent ?? null);
        const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
        const pctDisplay = renderContextPercent(usage?.percent ?? null, contextWindow);

        const cacheStats = collectCacheStats(ctx.sessionManager.getBranch());
        const tokenDisplay = BLUE(` ↑${fmt(cacheStats.input)} ↓${fmt(cacheStats.output)}`);
        const cacheDisplay = cacheStats.hitRate === null
          ? ""
          : GREEN(` ⚡${Math.round(cacheStats.hitRate * 100)}%`);
        const costDisplay = YELLOW(` $${cacheStats.cost.toFixed(3)}`);

        const statuses = footerData.getExtensionStatuses();
        const statusTexts: string[] = [];
        for (const [, text] of statuses) {
          statusTexts.push(text);
        }
        const statusDisplay = statusTexts.length > 0 ? DIM(statusTexts.join(" ")) : "";

        const line2Left = barDisplay + pctDisplay + tokenDisplay + cacheDisplay + costDisplay;
        const line2Right = statusDisplay;
        const line2Pad = " ".repeat(Math.max(1, width - visibleWidth(line2Left) - visibleWidth(line2Right)));
        const line2 = truncateToWidth(line2Left + line2Pad + line2Right, width);

        return [line1, line2];
      },
    };
  });
}
