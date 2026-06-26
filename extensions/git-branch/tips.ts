/**
 * Git branch working tips.
 */

import { registerWowTips, type WowTipInput } from "../wow/tips.ts";

const TIPS: WowTipInput[] = [
  {
    id: "git-branch-describe",
    short: "Run /git-branch with a short task description to create a named local branch.",
    tags: ["git", "branch"],
    priority: 55,
  },
  {
    id: "git-branch-from",
    short: "Use /git-branch --from main <task> when the new branch should start somewhere else.",
    tags: ["git", "branch"],
    priority: 45,
  },
];

export function registerGitBranchTips(): () => void {
  return registerWowTips("git-branch", TIPS);
}
