/**
 * Git Branch — /git-branch command
 *
 * Generates a local git branch name and start point from a task description
 * or the current session/git context, asks the user to review/edit them, then
 * creates and switches to the new branch.
 */

import { complete, type Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import { registerGitBranchTips } from "./tips.ts";

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedArgs {
  description: string;
  fromFlagPresent: boolean;
  explicitStartPoint?: string;
}

interface BranchSuggestion {
  branchName: string;
  startPoint: string;
  reason: string;
}

interface GitContext {
  currentBranch?: string;
  headSha?: string;
  status: string;
  unstagedStat: string;
  stagedStat: string;
  diffExcerpt: string;
  stagedDiffExcerpt: string;
  localBranches: string[];
  remoteBranches: string[];
}

const MAX_DIFF_LINES = 500;
const MAX_RECENT_CONTEXT_BYTES = 8_000;
const MAX_BRANCH_OPTIONS = 300;
const MAX_COMPLETION_ITEMS = 100;
const ALLOWED_PREFIXES = [
  "feat",
  "fix",
  "docs",
  "refactor",
  "test",
  "chore",
  "build",
  "ci",
  "perf",
  "style",
  "revert",
  "hotfix",
  "release",
];

const SYSTEM_PROMPT = `You generate safe local git branch metadata for a developer.

Output ONLY strict JSON, no markdown, no code fences, no explanation.

Schema:
{
  "branchName": "<type>/<short-kebab-name>",
  "startPoint": "<one available local or remote-tracking branch, or HEAD>",
  "reason": "<one short sentence explaining the choice>"
}

Branch name rules:
- Use lowercase ASCII only.
- Use kebab-case words.
- Prefer one of these type prefixes: feat, fix, docs, refactor, test, chore, build, ci, perf, style, revert, hotfix, release.
- Choose the prefix from intent: new behavior -> feat, bug -> fix, docs -> docs, internal cleanup -> refactor, tests -> test, maintenance -> chore.
- Keep it concise: usually 2-6 words after the prefix.
- Do not include spaces, underscores, emoji, quotes, shell syntax, trailing punctuation, or AI attribution.
- Do not include dates/timestamps. The caller handles conflicts.

Start point rules:
- If an explicit --from value is provided, use it exactly when valid.
- Otherwise infer the best start point from the task/context.
- The start point MUST be one of the provided available branches, or HEAD.
- Do not invent remote branches and do not request git fetch.
- If uncertain, prefer the current branch.
- Remote-tracking branches such as origin/main are allowed only as start points; do not imply upstream tracking.`;

function runGit(args: string[], timeout = 10_000): GitResult {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf-8",
    timeout,
    windowsHide: true,
  });

  const stdout = (result.stdout ?? "").toString().trim();
  const stderr = (result.stderr ?? "").toString().trim();
  if (result.error) {
    return {
      stdout,
      stderr: stderr || result.error.message,
      exitCode: typeof result.status === "number" ? result.status : 1,
    };
  }

  return {
    stdout,
    stderr,
    exitCode: typeof result.status === "number" ? result.status : 0,
  };
}

function gitOutput(args: string[], timeout?: number): string | undefined {
  const result = runGit(args, timeout);
  return result.exitCode === 0 ? result.stdout : undefined;
}

function isGitRepository(): boolean {
  return runGit(["rev-parse", "--git-dir"]).exitCode === 0;
}

function currentBranch(): string | undefined {
  const branch = gitOutput(["branch", "--show-current"]);
  return branch?.trim() || undefined;
}

function headSha(): string | undefined {
  return gitOutput(["rev-parse", "--verify", "HEAD"]);
}

function commitSha(ref: string): string | undefined {
  const value = gitOutput(["rev-parse", "--verify", `${ref}^{commit}`]);
  return value?.trim() || undefined;
}

function isDirty(status: string): boolean {
  return status
    .split("\n")
    .some((line) => line.trim() && !line.startsWith("##"));
}

function stripRefPrefix(ref: string, prefix: string): string | undefined {
  if (!ref.startsWith(prefix)) return undefined;
  const name = ref.slice(prefix.length).trim();
  return name || undefined;
}

function listBranches(): { localBranches: string[]; remoteBranches: string[] } {
  const localOutput = gitOutput(["for-each-ref", "--format=%(refname)", "refs/heads"]) ?? "";
  const remoteOutput = gitOutput(["for-each-ref", "--format=%(refname)", "refs/remotes"]) ?? "";

  return {
    localBranches: uniqueSorted(localOutput.split("\n")
      .map((line) => stripRefPrefix(line.trim(), "refs/heads/"))
      .filter((name): name is string => Boolean(name))),
    remoteBranches: uniqueSorted(remoteOutput.split("\n")
      .map((line) => stripRefPrefix(line.trim(), "refs/remotes/"))
      .filter((name): name is string => typeof name === "string" && Boolean(name) && !name.endsWith("/HEAD"))),
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function collectGitContext(): GitContext {
  const status = gitOutput(["status", "--porcelain=v1", "-b"]) ?? "";
  const unstagedStat = gitOutput(["diff", "--stat"], 10_000) ?? "";
  const stagedStat = gitOutput(["diff", "--cached", "--stat"], 10_000) ?? "";
  const diffExcerpt = truncateLines(gitOutput(["diff"], 20_000) ?? "", MAX_DIFF_LINES);
  const stagedDiffExcerpt = truncateLines(gitOutput(["diff", "--cached"], 20_000) ?? "", MAX_DIFF_LINES);
  const branches = listBranches();

  return {
    currentBranch: currentBranch(),
    headSha: headSha(),
    status,
    unstagedStat,
    stagedStat,
    diffExcerpt,
    stagedDiffExcerpt,
    ...branches,
  };
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n\n[...truncated from ${lines.length} to ${maxLines} lines]`;
}

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function parseArgs(args: string): ParsedArgs {
  const tokens = tokenizeArgs(args.trim());
  const descriptionTokens: string[] = [];
  let fromFlagPresent = false;
  let explicitStartPoint: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--from") {
      fromFlagPresent = true;
      const value = tokens[i + 1];
      if (value) {
        explicitStartPoint = value;
        i++;
      }
      continue;
    }

    descriptionTokens.push(token);
  }

  return {
    description: descriptionTokens.join(" ").trim(),
    fromFlagPresent,
    explicitStartPoint,
  };
}

interface FromCompletionContext {
  partial: string;
  leadingText: string;
  separator: string;
}

function fromCompletionContext(argumentPrefix: string): FromCompletionContext | undefined {
  const spaceMatch = argumentPrefix.match(/(^|\s)--from(?:\s+(\S*))?$/);
  if (!spaceMatch) return undefined;

  return {
    partial: spaceMatch[2] ?? "",
    leadingText: argumentPrefix.slice(0, spaceMatch.index),
    separator: spaceMatch[1] ?? "",
  };
}

function fromCompletionValue(context: FromCompletionContext, branch: string): string {
  return `${context.leadingText}${context.separator}--from ${branch}`;
}

function branchKind(name: string, branches: { localBranches: string[]; remoteBranches: string[] }): string {
  if (name === "HEAD") return "current HEAD";
  if (branches.localBranches.includes(name)) return "local branch";
  if (branches.remoteBranches.includes(name)) return "remote-tracking branch";
  return "git start point";
}

function fuzzyMatch(candidate: string, query: string): boolean {
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (!normalizedQuery) return true;

  let queryIndex = 0;
  for (const char of normalizedCandidate) {
    if (char === normalizedQuery[queryIndex]) {
      queryIndex++;
      if (queryIndex === normalizedQuery.length) return true;
    }
  }

  return false;
}

function branchCompletionRank(name: string, query: string, branches: { localBranches: string[]; remoteBranches: string[] }): number {
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let rank = 0;

  if (lowerQuery && !lowerName.startsWith(lowerQuery)) rank += 100;
  if (name === "HEAD") rank += 20;
  else if (branches.remoteBranches.includes(name)) rank += 10;
  else if (!branches.localBranches.includes(name)) rank += 15;
  rank += Math.max(0, name.length - lowerQuery.length) / 100;

  return rank;
}

function gitBranchArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const context = fromCompletionContext(argumentPrefix);
  if (!context || !isGitRepository()) return null;

  const branches = listBranches();
  const candidates = uniqueSorted(["HEAD", ...branches.localBranches, ...branches.remoteBranches]);
  const filtered = candidates
    .filter((name) => fuzzyMatch(name, context.partial))
    .sort((a, b) => {
      const rank = branchCompletionRank(a, context.partial, branches) - branchCompletionRank(b, context.partial, branches);
      return rank !== 0 ? rank : a.localeCompare(b);
    })
    .slice(0, MAX_COMPLETION_ITEMS)
    .map((name) => ({
      value: fromCompletionValue(context, name),
      label: name,
      description: branchKind(name, branches),
    }));

  return filtered.length > 0 ? filtered : null;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: { text: string }) => block.text)
    .join("\n");
}

function entryText(entry: any): { role: string; text: string } | undefined {
  if (entry?.type === "message") {
    const message = entry.message;
    if (!message || typeof message !== "object") return undefined;
    if (message.role === "user" || message.role === "assistant") {
      return { role: message.role, text: contentToText(message.content) };
    }
    return undefined;
  }

  if (entry?.type === "custom_message" && entry.display === true) {
    return { role: "custom", text: contentToText(entry.content) };
  }

  if (entry?.type === "compaction" && typeof entry.summary === "string") {
    return { role: "compaction", text: entry.summary };
  }

  if (entry?.type === "branch_summary" && typeof entry.summary === "string") {
    return { role: "branch", text: entry.summary };
  }

  return undefined;
}

function collectRecentChatContext(ctx: ExtensionCommandContext): string {
  let entries: any[];
  try {
    entries = ctx.sessionManager.getBranch() as any[];
  } catch {
    return "";
  }

  const lines: string[] = [];
  for (const entry of entries.slice(-16)) {
    const extracted = entryText(entry);
    if (!extracted) continue;
    const text = extracted.text.trim();
    if (!text) continue;
    lines.push(`### ${extracted.role}\n${text}`);
  }

  let joined = lines.join("\n\n");
  while (Buffer.byteLength(joined, "utf-8") > MAX_RECENT_CONTEXT_BYTES && lines.length > 1) {
    lines.shift();
    joined = lines.join("\n\n");
  }
  return joined;
}

function availableStartPoints(git: GitContext): string[] {
  return uniqueSorted([
    "HEAD",
    ...git.localBranches,
    ...git.remoteBranches,
  ]);
}

function formatBranchList(branches: string[]): string {
  if (branches.length === 0) return "(none)";
  return branches.join("\n");
}

function buildUserPrompt(parsed: ParsedArgs, git: GitContext, chatContext: string): string {
  const description = parsed.description || "(none — infer from recent chat and git state)";
  const explicitStartPoint = parsed.explicitStartPoint || "(none)";

  return `## User Task Description\n${description}\n\n` +
    `## Explicit Start Point From --from\n${explicitStartPoint}\n\n` +
    `## Current Git State\n` +
    `Current branch: ${git.currentBranch ?? "(detached HEAD or unknown)"}\n` +
    `HEAD: ${git.headSha ?? "(unknown)"}\n\n` +
    `## Available Local Branches\n${formatBranchList(git.localBranches)}\n\n` +
    `## Available Remote-Tracking Branches\n${formatBranchList(git.remoteBranches)}\n\n` +
    `## Git Status\n\`\`\`\n${git.status || "(clean)"}\n\`\`\`\n\n` +
    `## Unstaged Diff Stat\n\`\`\`\n${git.unstagedStat || "(none)"}\n\`\`\`\n\n` +
    `## Staged Diff Stat\n\`\`\`\n${git.stagedStat || "(none)"}\n\`\`\`\n\n` +
    `## Unstaged Diff Excerpt\n\`\`\`diff\n${git.diffExcerpt || "(none)"}\n\`\`\`\n\n` +
    `## Staged Diff Excerpt\n\`\`\`diff\n${git.stagedDiffExcerpt || "(none)"}\n\`\`\`\n\n` +
    `## Recent Chat Context\n${chatContext || "(none)"}`;
}

function responseText(response: any): string {
  return response.content
    .filter((block: any): block is { type: "text"; text: string } => block.type === "text")
    .map((block: { text: string }) => block.text)
    .join("\n");
}

function stripJsonWrapper(raw: string): string {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

function parseSuggestion(raw: string): BranchSuggestion | undefined {
  try {
    const parsed = JSON.parse(stripJsonWrapper(raw));
    const branchName = typeof parsed.branchName === "string" ? parsed.branchName.trim() : "";
    const startPoint = typeof parsed.startPoint === "string" ? parsed.startPoint.trim() : "";
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    if (!branchName || !startPoint) return undefined;
    return { branchName, startPoint, reason };
  } catch {
    return undefined;
  }
}

function fallbackBranchName(description: string): string {
  const base = description || "work";
  const slug = sanitizePathSegment(base).split("-").slice(0, 6).join("-") || "work";
  return `feat/${slug}`;
}

function sanitizePathSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
}

function sanitizeBranchName(raw: string): string {
  let name = raw.trim().replace(/^refs\/heads\//, "").replace(/\\+/g, "/");
  name = name.replace(/\s*\/\s*/g, "/");

  const parts = name
    .split("/")
    .map(sanitizePathSegment)
    .filter(Boolean);

  if (parts.length === 0) return "feat/work";

  if (parts.length === 1) {
    return ALLOWED_PREFIXES.includes(parts[0]) ? `${parts[0]}/work` : `feat/${parts[0]}`;
  }

  return parts.join("/");
}

function isValidBranchName(branchName: string): boolean {
  if (!branchName || branchName.startsWith("-") || branchName.includes("..")) return false;
  if (branchName === "HEAD" || branchName.endsWith("/")) return false;
  return runGit(["check-ref-format", "--branch", branchName]).exitCode === 0;
}

function localBranchExists(branchName: string): boolean {
  return runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]).exitCode === 0;
}

function startPointExists(startPoint: string, git: GitContext): boolean {
  const normalized = startPoint.trim();
  if (!normalized) return false;
  if (normalized === "HEAD") return true;
  if (git.localBranches.includes(normalized) || git.remoteBranches.includes(normalized)) return true;
  return false;
}

function normalizeStartPoint(candidate: string, git: GitContext): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  if (startPointExists(trimmed, git)) return trimmed;
  return undefined;
}

function timestampSuffix(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join("");
}

function appendTimestamp(branchName: string): string {
  const suffix = timestampSuffix();
  const parts = branchName.split("/");
  const last = parts.pop() ?? branchName;
  parts.push(`${last}-${suffix}`);
  return parts.join("/");
}

function resolveBranchNameConflict(branchName: string): string {
  if (!localBranchExists(branchName)) return branchName;

  const timestamped = appendTimestamp(branchName);
  if (!localBranchExists(timestamped)) return timestamped;

  for (let i = 2; i <= 99; i++) {
    const candidate = `${timestamped}-${i}`;
    if (!localBranchExists(candidate)) return candidate;
  }

  return `${timestamped}-${Date.now()}`;
}

async function generateSuggestion(
  parsed: ParsedArgs,
  git: GitContext,
  chatContext: string,
  ctx: ExtensionCommandContext,
): Promise<BranchSuggestion | undefined> {
  if (!ctx.model) {
    ctx.ui.notify("No model selected", "error");
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    ctx.ui.notify(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error, "error");
    return undefined;
  }

  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: buildUserPrompt(parsed, git, chatContext),
      },
    ],
    timestamp: Date.now(),
  };

  ctx.ui.notify("Generating branch name and start point...", "info");
  const response = await complete(
    ctx.model,
    { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers },
  );

  if (response.stopReason === "aborted") {
    ctx.ui.notify("Cancelled", "info");
    return undefined;
  }

  return parseSuggestion(responseText(response));
}

async function promptBranchName(ctx: ExtensionCommandContext, suggested: string): Promise<string | undefined> {
  let current = suggested;

  while (true) {
    const edited = await ctx.ui.input(
      `Branch name (leave empty to keep: ${current})`,
      current,
    );
    if (edited === undefined) return undefined;

    const raw = edited.trim() || current;
    const sanitized = sanitizeBranchName(raw);
    if (sanitized !== raw) {
      ctx.ui.notify(`Normalized branch name to ${sanitized}`, "info");
    }

    if (!isValidBranchName(sanitized)) {
      ctx.ui.notify(`Invalid git branch name: ${sanitized}`, "error");
      current = sanitized || current;
      continue;
    }

    return sanitized;
  }
}

async function promptStartPoint(
  ctx: ExtensionCommandContext,
  suggested: string,
  git: GitContext,
): Promise<string | undefined> {
  let current = normalizeStartPoint(suggested, git) ?? git.currentBranch ?? "HEAD";

  while (true) {
    const choice = await ctx.ui.select(
      `Start point: ${current}`,
      [
        `Use ${current}`,
        "Choose from local/remote branches",
        "Type manually",
        "Cancel",
      ],
    );

    if (!choice || choice === "Cancel") return undefined;
    if (choice.startsWith("Use ")) return current;

    if (choice === "Choose from local/remote branches") {
      const options = availableStartPoints(git).slice(0, MAX_BRANCH_OPTIONS);
      const selected = await ctx.ui.select("Choose start point", options);
      if (!selected) continue;
      current = selected;
      continue;
    }

    if (choice === "Type manually") {
      const typed = await ctx.ui.input(
        `Start point (local/remote branch or HEAD; leave empty to keep: ${current})`,
        current,
      );
      if (typed === undefined) continue;
      const candidate = typed.trim() || current;
      const normalized = normalizeStartPoint(candidate, git);
      if (!normalized) {
        ctx.ui.notify(`Unknown start point: ${candidate}`, "error");
        continue;
      }
      current = normalized;
    }
  }
}

async function confirmDirtyWorktree(
  ctx: ExtensionCommandContext,
  status: string,
  startPoint: string,
  git: GitContext,
): Promise<boolean> {
  if (!isDirty(status)) return true;

  const summary = truncateLines(status, 20);
  const ok = await ctx.ui.confirm(
    "Working tree has uncommitted changes",
    `Create and switch branch anyway?\n\n${summary}`,
  );
  if (!ok) return false;

  const currentHead = git.headSha;
  const startHead = commitSha(startPoint);
  if (currentHead && startHead && currentHead !== startHead) {
    return ctx.ui.confirm(
      "Start point differs from current HEAD",
      "Uncommitted changes may fail to carry across or may conflict. Continue and let git decide?",
    );
  }

  return true;
}

function createBranch(branchName: string, startPoint: string, noTrack = false): GitResult {
  const switchArgs = noTrack
    ? ["switch", "--no-track", "-c", branchName, startPoint]
    : ["switch", "-c", branchName, startPoint];
  const switchResult = runGit(switchArgs, 30_000);
  if (switchResult.exitCode === 0) return switchResult;

  const combined = `${switchResult.stderr}\n${switchResult.stdout}`.toLowerCase();
  const shouldFallback = combined.includes("not a git command") ||
    combined.includes("unknown switch") ||
    combined.includes("usage: git");
  if (!shouldFallback) return switchResult;

  const checkoutArgs = noTrack
    ? ["checkout", "--no-track", "-b", branchName, startPoint]
    : ["checkout", "-b", branchName, startPoint];
  const checkoutResult = runGit(checkoutArgs, 30_000);
  if (checkoutResult.exitCode === 0) return checkoutResult;

  return {
    stdout: checkoutResult.stdout || switchResult.stdout,
    stderr: checkoutResult.stderr || switchResult.stderr,
    exitCode: checkoutResult.exitCode,
  };
}

function formatFailure(result: GitResult): string {
  return result.stderr || result.stdout || "unknown error";
}

function sendResultMessage(
  pi: ExtensionAPI,
  branchName: string,
  startPoint: string,
  reason: string,
  result: GitResult,
): void {
  pi.sendMessage(
    {
      customType: "git-branch-result",
      content: `**Created branch**\n\n- Branch: \`${branchName}\`\n- Start point: \`${startPoint}\`\n- Reason: ${reason || "(none)"}\n\n\`\`\`\n${result.stdout || "ok"}\n\`\`\``,
      display: true,
    },
    { triggerTurn: false },
  );
}

function sendErrorMessage(pi: ExtensionAPI, result: GitResult): void {
  pi.sendMessage(
    {
      customType: "git-branch-error",
      content: `**Branch Creation Failed**\n\n\`\`\`\n${formatFailure(result)}\n\`\`\``,
      display: true,
    },
    { triggerTurn: false },
  );
}

async function handleGitBranch(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/git-branch requires an interactive UI for review", "error");
    return;
  }

  if (!isGitRepository()) {
    ctx.ui.notify("Not a git repository", "error");
    return;
  }

  const parsed = parseArgs(args);
  const git = collectGitContext();

  let explicitStartPoint: string | undefined;
  if (parsed.fromFlagPresent) {
    if (!parsed.explicitStartPoint) {
      ctx.ui.notify("Missing start point after --from", "error");
      return;
    }

    explicitStartPoint = normalizeStartPoint(parsed.explicitStartPoint, git);
    if (!explicitStartPoint) {
      ctx.ui.notify(`Unknown start point from --from: ${parsed.explicitStartPoint}`, "error");
      return;
    }
  }

  const chatContext = collectRecentChatContext(ctx);
  const suggestion = await generateSuggestion(parsed, git, chatContext, ctx);
  if (!suggestion) {
    ctx.ui.notify("Failed to generate branch suggestion", "error");
    return;
  }

  const rawBranch = suggestion.branchName || fallbackBranchName(parsed.description);
  let branchName = sanitizeBranchName(rawBranch);
  if (!isValidBranchName(branchName)) {
    branchName = sanitizeBranchName(fallbackBranchName(parsed.description));
  }

  const suggestedStartPoint = explicitStartPoint ?? suggestion.startPoint;
  let startPoint: string;
  if (explicitStartPoint) {
    startPoint = explicitStartPoint;
  } else {
    startPoint = normalizeStartPoint(suggestedStartPoint, git) ?? git.currentBranch ?? "HEAD";
    if (!startPointExists(startPoint, git)) {
      ctx.ui.notify(`Generated start point is unavailable: ${suggestedStartPoint}`, "warning");
      startPoint = git.currentBranch ?? "HEAD";
    }
  }

  const conflictResolved = resolveBranchNameConflict(branchName);
  if (conflictResolved !== branchName) {
    ctx.ui.notify(`Branch already exists; using ${conflictResolved}`, "warning");
    branchName = conflictResolved;
  }

  const reviewedBranchName = await promptBranchName(ctx, branchName);
  if (!reviewedBranchName) {
    ctx.ui.notify("Branch creation cancelled", "info");
    return;
  }
  const reviewedConflictResolved = resolveBranchNameConflict(reviewedBranchName);
  if (reviewedConflictResolved !== reviewedBranchName) {
    ctx.ui.notify(`Branch already exists; using ${reviewedConflictResolved}`, "warning");
  }
  branchName = reviewedConflictResolved;

  if (!explicitStartPoint) {
    const reviewedStartPoint = await promptStartPoint(ctx, startPoint, git);
    if (!reviewedStartPoint) {
      ctx.ui.notify("Branch creation cancelled", "info");
      return;
    }
    startPoint = reviewedStartPoint;
  }

  const confirmed = await ctx.ui.confirm(
    "Create git branch?",
    `Branch: ${branchName}\nStart point: ${startPoint}\nReason: ${suggestion.reason || "(none)"}`,
  );
  if (!confirmed) {
    ctx.ui.notify("Branch creation cancelled", "info");
    return;
  }

  if (!(await confirmDirtyWorktree(ctx, git.status, startPoint, git))) {
    ctx.ui.notify("Branch creation cancelled", "info");
    return;
  }

  ctx.ui.notify(`Creating ${branchName} from ${startPoint}...`, "info");
  const result = createBranch(branchName, startPoint, git.remoteBranches.includes(startPoint));
  if (result.exitCode !== 0) {
    ctx.ui.notify(`✗ Branch creation failed: ${formatFailure(result)}`, "error");
    sendErrorMessage(pi, result);
    return;
  }

  ctx.ui.notify(`✓ Switched to ${branchName}`, "info");
  sendResultMessage(pi, branchName, startPoint, suggestion.reason, result);
}

export default function (pi: ExtensionAPI) {
  const unregisterTips = registerGitBranchTips();

  pi.registerCommand("git-branch", {
    description: "Generate a git branch name/start point, review it, then create and switch to the branch",
    getArgumentCompletions: gitBranchArgumentCompletions,
    handler: async (args, ctx) => handleGitBranch(pi, args, ctx),
  });

  pi.on("session_shutdown", async () => {
    unregisterTips();
  });
}
