/**
 * Git commit working tips.
 */

import { registerWowTips, type WowTipInput } from "../wow/tips.ts";

const TIPS: WowTipInput[] = [
  {
    id: "git-commit-staged",
    short: "Stage changes first, then run /git-commit to create a Conventional Commit.",
    tags: ["git", "commit"],
    priority: 60,
  },
  {
    id: "git-commit-language",
    short: "Use /git-commit:en or /git-commit:zh-CN to force commit message language.",
    tags: ["git", "commit"],
    priority: 40,
  },
];

export function registerGitCommitTips(): () => void {
  return registerWowTips("git-commit", TIPS);
}
