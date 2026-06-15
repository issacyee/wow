/**
 * Prefix-cache working tips.
 */

import { registerWowTips, type WowTipInput } from "../wow/tips.ts";

const TIPS: WowTipInput[] = [
  {
    id: "prefix-cache-stability",
    short: "Stable prompts and tool schemas improve provider prefix-cache hit rates.",
    tags: ["cache", "performance"],
    priority: 60,
  },
  {
    id: "prefix-cache-stats",
    short: "Use /cache-stats to inspect input, output, and cache token usage.",
    tags: ["cache", "diagnostics"],
    priority: 50,
  },
  {
    id: "prefix-cache-doctor",
    short: "Use /cache-doctor when prefix-cache hit rate looks unexpectedly low.",
    tags: ["cache", "diagnostics"],
    priority: 50,
  },
];

export function registerPrefixCacheTips(): () => void {
  return registerWowTips("prefix-cache", TIPS);
}
