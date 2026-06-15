/**
 * CodeGraph working tips.
 */

import { registerWowTips, type WowTipInput } from "../wow/tips.ts";

const TIPS: WowTipInput[] = [
  {
    id: "codegraph-init",
    short: "Run /codegraph:init once per project to unlock semantic code exploration.",
    tags: ["codegraph", "setup"],
    priority: 80,
  },
  {
    id: "codegraph-explore-first",
    short: "Use codegraph_explore for architecture and flow questions before grep/read loops.",
    tags: ["codegraph", "tools"],
    priority: 70,
  },
  {
    id: "codegraph-status",
    short: "Run /codegraph:status when the CodeGraph index looks missing or stale.",
    tags: ["codegraph", "maintenance"],
    priority: 50,
  },
];

export function registerCodeGraphTips(): () => void {
  return registerWowTips("codegraph", TIPS);
}
