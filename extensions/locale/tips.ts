/**
 * Locale working tips.
 */

import { registerWowTips, type WowTipInput } from "../wow/tips.ts";

const TIPS: WowTipInput[] = [
  {
    id: "locale-same-language",
    short: "Wow tells the agent to reply in your OS language (Simplified/Traditional Chinese distinguished) while preserving code identifiers.",
    tags: ["locale"],
    priority: 40,
  },
];

export function registerLocaleTips(): () => void {
  return registerWowTips("locale", TIPS);
}
