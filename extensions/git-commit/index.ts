/**
 * Git Commit — /git-commit command
 *
 * Generates a terse Conventional Commits message from staged changes
 * via a direct LLM call (isolated from main session context), then
 * executes the commit.
 *
 * Style: caveman-commit — ultra-compressed, subject ≤50 chars, body
 * only when "why" isn't obvious. No AI attribution, no emoji, no fluff.
 */

import { complete, type Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execOrNull, execWithError } from "../wow/shell.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── System Prompt: caveman-commit style ──

const SYSTEM_PROMPT = `You are a terse commit message generator. Follow these rules strictly.

## Output Format
Output ONLY the commit message, no preamble, no explanation, no code fences.

## Subject Line
<type>(<scope>): <imperative summary>

Types: feat, fix, refactor, perf, docs, test, chore, build, ci, style, revert
Scope is optional. Imperative mood: "add", "fix", "remove" not "added"/"adds"/"adding".
≤50 chars when possible, hard cap 72. No trailing period.

## Body (only when needed)
Skip entirely when subject is self-explanatory.
Add body only for: non-obvious why, breaking changes, migration notes, linked issues.
Wrap at 72 chars. Bullets with "-" not "*".

## NEVER include
- "This commit does X", "I", "we", "now", "currently"
- AI attribution ("Generated with Claude Code", etc.)
- Emoji
- Restating file name when scope already says it

## Breaking Changes
Use ! after type/scope. Always include BREAKING CHANGE: in body.

## Examples

Diff: new API endpoint
feat(api): add GET /users/:id/profile

Diff: breaking route rename
feat(api)!: rename /v1/orders to /v1/checkout

BREAKING CHANGE: clients on /v1/orders must migrate to /v1/checkout`;

// ── Helpers (shell utilities imported from wow/shell.ts) ──

/** Parse commit message from LLM output — strip fences and preamble */
function parseCommitMessage(raw: string): string {
  let msg = raw.trim();
  // Extract content from code fences if present
  const fenceMatch = msg.match(/```(?:\w+)?\n([\s\S]*?)```/);
  if (fenceMatch) {
    msg = fenceMatch[1].trim();
  }
  // Remove common preamble lines
  msg = msg.replace(/^(Here['']s|Here is) (the|a|your) commit message:?\s*\n/i, "");
  msg = msg.replace(/^Commit message:?\s*\n/i, "");
  // Remove trailing attribution
  msg = msg.replace(/\n*---+\n.*$/s, "");
  msg = msg.replace(/\n*Generated (by|with) .*$/im, "");
  return msg.trim();
}

// ── Extension entry ──

export default function (pi: ExtensionAPI) {
  pi.registerCommand("git-commit", {
    description: "Generate a terse Conventional Commits message from staged changes and commit",
    handler: async (args, ctx) => {
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      // ── ① Verify git repo ──
      ctx.ui.notify("Checking git repository...", "info");
      const gitDir = execOrNull("git rev-parse --git-dir", true);
      if (gitDir === null) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }

      // ── ② Check staged changes ──
      ctx.ui.notify("Checking staged changes...", "info");
      const status = execOrNull("git status --porcelain");
      if (!status) {
        ctx.ui.notify("No staged changes. Stage files with git add first.", "error");
        return;
      }
      // Verify first column has staged status (M, A, D, R, C, etc.)
      const hasStaged = status.split("\n").some((line) => {
        const c = line[0];
        return c && c !== " " && c !== "?" && c !== "!";
      });
      if (!hasStaged) {
        ctx.ui.notify("No staged changes. Stage files with git add first.", "error");
        return;
      }

      // ── ③ Get diff ──
      ctx.ui.notify("Reading staged diff...", "info");
      const diff = execOrNull("git diff --cached");
      if (!diff) {
        ctx.ui.notify("Empty diff. Files may be staged without changes.", "error");
        return;
      }
      const files = execOrNull("git diff --cached --name-status") || "";

      // Truncate extremely large diffs
      const diffLines = diff.split("\n").length;
      let diffContent = diff;
      if (diffLines > 800) {
        const truncated = diff.split("\n").slice(0, 800).join("\n");
        diffContent = truncated + `\n\n[...diff truncated from ${diffLines} to 800 lines]`;
      }

      // ── ④ Get auth and call LLM ──
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
      if (!auth.ok || !auth.apiKey) {
        ctx.ui.notify(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error, "error");
        return;
      }

      const extraContext = args.trim() ? `\n\n## Additional Context\n\n${args.trim()}` : "";

      const userMessage: Message = {
        role: "user",
        content: [
          {
            type: "text",
            text: `## Changed Files\n\n${files}\n\n## Diff\n\n\`\`\`diff\n${diffContent}\n\`\`\`${extraContext}`,
          },
        ],
        timestamp: Date.now(),
      };

      const diffKb = Math.round(Buffer.byteLength(diffContent, "utf-8") / 1024);
      ctx.ui.notify(`Generating commit message (diff: ${diffKb}KB, ${diffLines} lines)...`, "info");

      const response = await complete(
        ctx.model!,
        { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
        { apiKey: auth.apiKey, headers: auth.headers },
      );

      if (response.stopReason === "aborted") {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const rawMessage = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      const commitMessage = parseCommitMessage(rawMessage);
      if (!commitMessage) {
        ctx.ui.notify("Failed to generate commit message", "error");
        return;
      }

      // ── ⑤ Execute commit ──
      ctx.ui.notify("Executing commit...", "info");

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-commit-"));
      const msgFile = path.join(tmpDir, "COMMIT_EDITMSG");
      fs.writeFileSync(msgFile, commitMessage + "\n", "utf-8");

      const result = execWithError(`git commit -F "${msgFile}"`);

      // Cleanup temp file
      try {
        fs.unlinkSync(msgFile);
        fs.rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }

      if (result.exitCode !== 0) {
        ctx.ui.notify(`✗ Commit failed: ${result.stderr || "unknown error"}`, "error");
        pi.sendMessage(
          {
            customType: "git-commit-error",
            content: `**Commit Failed**\n\n\`\`\`\n${result.stderr || result.stdout}\n\`\`\``,
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      const subjectLine = commitMessage.split("\n")[0];
      ctx.ui.notify(`✓ ${subjectLine}`, "info");
      pi.sendMessage(
        {
          customType: "git-commit-result",
          content: `**Committed**\n\n\`\`\`\n${commitMessage}\n\`\`\`\n\n${result.stdout || ""}`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });
}
