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
import { wowColor } from "./theme.ts";

const BAR_WIDTH = 10;
const FILLED = "█";
const EMPTY = "░";

function contextColorToken(percent: number | null): "footer.contextOk" | "footer.contextWarn" | "footer.contextDanger" {
  const pct = Math.max(0, Math.min(100, percent ?? 0));
  if (pct > 80) return "footer.contextDanger";
  if (pct > 50) return "footer.contextWarn";
  return "footer.contextOk";
}

function renderContextBar(theme: any, percent: number | null): string {
  const pct = Math.max(0, Math.min(100, percent ?? 0));
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = FILLED.repeat(filled) + EMPTY.repeat(empty);

  return wowColor(theme, contextColorToken(percent))(bar);
}

function fmt(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

function fmtContextWindow(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

function renderContextPercent(theme: any, percent: number | null, contextWindow?: number): string {
  const pct = Math.round(Math.max(0, Math.min(100, percent ?? 0)));
  const windowLabel = contextWindow ? `/${fmtContextWindow(contextWindow)}` : "";
  return wowColor(theme, contextColorToken(percent))(` ${pct}%${windowLabel}`);
}

export function installFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubBranch,
      invalidate() { },
      render(width: number): string[] {
        const cwdPath = ctx.cwd ?? process.cwd();
        const cwdName = shortenPath(cwdPath);
        const cwdDisplay = wowColor(theme, "footer.cwd")(hyperlink(cwdName, `file://${cwdPath}`));

        const branch = footerData.getGitBranch();
        const branchDisplay = branch ? ` ${wowColor(theme, "footer.branch")(branch)}` : "";

        const modelName = ctx.model?.id || "no-model";
        const thinkingLevel = pi.getThinkingLevel();
        const modelDisplay = thinkingLevel && thinkingLevel !== "off"
          ? wowColor(theme, "footer.model")(`${modelName} • ${thinkingLevel}`)
          : wowColor(theme, "footer.model")(modelName);

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
        const barDisplay = renderContextBar(theme, usage?.percent ?? null);
        const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
        const pctDisplay = renderContextPercent(theme, usage?.percent ?? null, contextWindow);

        const cacheStats = collectCacheStats(ctx.sessionManager.getBranch());
        const tokenDisplay = wowColor(theme, "footer.tokens")(` ↑${fmt(cacheStats.input)} ↓${fmt(cacheStats.output)}`);
        const cacheDisplay = cacheStats.hitRate === null
          ? ""
          : wowColor(theme, "footer.cache")(` ⚡${Math.round(cacheStats.hitRate * 100)}%`);
        const costDisplay = wowColor(theme, "footer.cost")(` $${cacheStats.cost.toFixed(3)}`);

        const statuses = footerData.getExtensionStatuses();
        const statusTexts: string[] = [];
        for (const [, text] of statuses) {
          statusTexts.push(text);
        }
        const statusDisplay = statusTexts.length > 0 ? wowColor(theme, "footer.status")(statusTexts.join(" ")) : "";

        const line2Left = barDisplay + pctDisplay + tokenDisplay + cacheDisplay + costDisplay;
        const line2Right = statusDisplay;
        const line2Pad = " ".repeat(Math.max(1, width - visibleWidth(line2Left) - visibleWidth(line2Right)));
        const line2 = truncateToWidth(line2Left + line2Pad + line2Right, width);

        return [line1, line2];
      },
    };
  });
}
