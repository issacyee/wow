/**
 * BTW working tips.
 */

import { registerWowTips, type WowTipInput } from "../wow/tips.ts";

const TIPS: WowTipInput[] = [
  {
    id: "btw-side-channel",
    short: "Use /btw for side questions that should stay out of the main coding context.",
    tags: ["btw", "context"],
    priority: 80,
  },
  {
    id: "btw-new-topic",
    short: "Use /btw:new to start a separate side-channel topic.",
    tags: ["btw"],
    priority: 60,
  },
  {
    id: "btw-promote",
    short: "Use /btw:promote only when a BTW conclusion should enter the main context.",
    tags: ["btw", "context"],
    priority: 60,
  },
];

export function registerBtwTips(): () => void {
  return registerWowTips("btw", TIPS);
}
