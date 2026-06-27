/**
 * Human-led coding workflow working tips.
 */

import { registerWowTips, type WowTipInput } from "../wow/tips.ts";

const TIPS: WowTipInput[] = [
  {
    id: "hlcw-discuss-readonly",
    short: "Use ? for read-only discussion before changing code.",
    tags: ["workflow", "basic"],
    priority: 100,
  },
  {
    id: "hlcw-discuss-to-plan",
    short: "Use ?? after ? to turn the last discussion into a reviewable plan.",
    tags: ["workflow", "planning"],
    priority: 100,
  },
  {
    id: "hlcw-revise-plan",
    short: "Use ?! to revise an active plan before executing it.",
    tags: ["workflow", "planning"],
    priority: 90,
  },
  {
    id: "hlcw-auto-execute",
    short: "Use ?$ when discussion is clear enough to create a plan and execute it immediately.",
    tags: ["workflow", "execution"],
    priority: 100,
  },
  {
    id: "hlcw-execute-plan",
    short: "Use $ to execute the human-approved active plan.",
    tags: ["workflow", "execution"],
    priority: 100,
  },
  {
    id: "hlcw-done-markers",
    short: "During $ or ?$ execution, [DONE:n] markers keep the todo widget in sync.",
    tags: ["workflow", "execution"],
    priority: 80,
  },
];

export function registerHumanLedWorkflowTips(): () => void {
  return registerWowTips("human-led-coding-workflow", TIPS);
}
