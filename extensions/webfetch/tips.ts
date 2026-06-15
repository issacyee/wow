/**
 * WebFetch working tips.
 */

import { registerWowTips, type WowTipInput } from "../wow/tips.ts";

const TIPS: WowTipInput[] = [
  {
    id: "webfetch-docs",
    short: "Use webfetch for documentation URLs; markdown output is the default.",
    tags: ["webfetch", "docs"],
    priority: 70,
  },
  {
    id: "webfetch-readonly",
    short: "webfetch is read-only and trims oversized pages before returning them to the model.",
    tags: ["webfetch", "safety"],
    priority: 50,
  },
];

export function registerWebfetchTips(): () => void {
  return registerWowTips("webfetch", TIPS);
}
