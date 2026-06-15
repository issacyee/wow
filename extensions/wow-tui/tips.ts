/**
 * Wow TUI working tips.
 */

import { registerWowTips, type WowTipInput } from "../wow/tips.ts";

const TIPS: WowTipInput[] = [
  {
    id: "wow-tui-config",
    short: "Use /config:global or /config:project to manage model, thinking, and UI settings.",
    tags: ["tui", "config"],
    priority: 50,
  },
  {
    id: "wow-tui-ime-prefixes",
    short: "Chinese IME prefixes ？, ！, and ￥ are converted to ?, !, and $ automatically.",
    tags: ["tui", "workflow"],
    priority: 40,
  },
];

export function registerWowTuiTips(): () => void {
  return registerWowTips("wow-tui", TIPS);
}
