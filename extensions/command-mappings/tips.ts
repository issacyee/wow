/**
 * Command mapping working tips.
 */

import { registerWowTips, type WowTipInput } from "../wow/tips.ts";

const TIPS: WowTipInput[] = [
  {
    id: "command-mappings-exit",
    short: "Use /exit as a familiar alias for pi's built-in /quit command.",
    tags: ["commands"],
    priority: 20,
  },
];

export function registerCommandMappingTips(): () => void {
  return registerWowTips("command-mappings", TIPS);
}
