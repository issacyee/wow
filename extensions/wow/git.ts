/*
 * Read-only Git helpers shared by Wow logic extensions.
 *
 * Commands are spawned with argument arrays (never a shell) so user-supplied
 * scopes cannot become command injection. All helpers are best-effort and do
 * not mutate the repository.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 48_000;
const MAX_UNTRACKED_FILE_CHARS = 12_000;

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WorktreeFileState {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface WorktreeSnapshot {
  root: string;
  head: string;
  fingerprint: string;
  files: WorktreeFileState[];
  diffExcerpt: string;
}

export interface LocalChanges extends WorktreeSnapshot {
  stagedDiff: string;
  unstagedDiff: string;
  untrackedContent: string;
  truncated: boolean;
}

function sha256(parts: Array<string | Buffer>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

export function runGit(cwd: string, args: string[]): GitRunResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    return { stdout: result.stdout ?? "", stderr: result.error.message, exitCode: 127 };
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

export function findGitRoot(cwd: string): string | undefined {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const root = result.exitCode === 0 ? result.stdout.trim() : "";
  return root || undefined;
}

function normalizeScope(root: string, scope?: string): string | undefined {
  const value = scope?.trim();
  if (!value || value === ".") return undefined;

  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  if (!existsSync(absolute)) return undefined; // A symbol/natural-language scope is not a Git pathspec.
  const scoped = relative(root, absolute).replace(/\\/g, "/");
  if (!scoped || scoped === "." || scoped.startsWith("../")) return undefined;
  return scoped;
}

function pathArgs(root: string, scope?: string): string[] {
  const normalized = normalizeScope(root, scope);
  return normalized ? ["--", normalized] : [];
}

function parseStatus(text: string): WorktreeFileState[] {
  const files: WorktreeFileState[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 3) continue;
    const status = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;
    const path = (rawPath.includes(" -> ") ? rawPath.split(" -> ").pop()! : rawPath)
      .replace(/^"|"$/g, "")
      .replace(/\\/g, "/");
    files.push({
      path,
      status,
      staged: status[0] !== " " && status[0] !== "?",
      unstaged: status[1] !== " " && status[1] !== "?",
      untracked: status === "??",
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function readUntracked(root: string, files: WorktreeFileState[]): { content: string; hashParts: Buffer[]; truncated: boolean } {
  const sections: string[] = [];
  const hashParts: Buffer[] = [];
  let truncated = false;

  for (const file of files.filter((item) => item.untracked)) {
    const absolute = resolve(root, file.path);
    try {
      if (!statSync(absolute).isFile()) continue;
      const buffer = readFileSync(absolute);
      hashParts.push(Buffer.from(file.path), buffer);
      if (buffer.includes(0)) {
        sections.push(`## ${file.path}\n[binary file: ${buffer.length} bytes]`);
        continue;
      }
      const text = buffer.toString("utf-8");
      const excerpt = text.length > MAX_UNTRACKED_FILE_CHARS
        ? `${text.slice(0, MAX_UNTRACKED_FILE_CHARS)}\n[untracked file truncated]`
        : text;
      if (excerpt.length !== text.length) truncated = true;
      sections.push(`## ${file.path}\n${excerpt}`);
    } catch {
      sections.push(`## ${file.path}\n[unable to read]`);
    }
  }

  return { content: sections.join("\n\n"), hashParts, truncated };
}

function clipContext(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  return { text: `${text.slice(0, budget)}\n[diff context truncated]`, truncated: true };
}

export function collectLocalChanges(cwd: string, scope?: string): LocalChanges | undefined {
  const root = findGitRoot(cwd);
  if (!root) return undefined;

  const statusResult = runGit(root, ["status", "--porcelain=v1", "--untracked-files=all", ...pathArgs(root, scope)]);
  const stagedResult = runGit(root, ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=40", ...pathArgs(root, scope)]);
  const unstagedResult = runGit(root, ["diff", "--no-ext-diff", "--no-color", "--unified=40", ...pathArgs(root, scope)]);
  const headResult = runGit(root, ["rev-parse", "HEAD"]);

  if (statusResult.exitCode !== 0 || stagedResult.exitCode !== 0 || unstagedResult.exitCode !== 0) return undefined;

  const files = parseStatus(statusResult.stdout);
  const untracked = readUntracked(root, files);
  const fullStaged = stagedResult.stdout;
  const fullUnstaged = unstagedResult.stdout;
  const fingerprint = sha256([
    headResult.stdout.trim() || "NO_HEAD",
    scope?.trim() || ".",
    statusResult.stdout,
    fullStaged,
    fullUnstaged,
    ...untracked.hashParts,
  ]);

  let remaining = MAX_CONTEXT_CHARS;
  const staged = clipContext(fullStaged, Math.floor(remaining * 0.45));
  remaining -= staged.text.length;
  const unstaged = clipContext(fullUnstaged, Math.floor(Math.max(0, remaining) * 0.65));
  remaining -= unstaged.text.length;
  const untrackedContent = clipContext(untracked.content, Math.max(0, remaining));

  return {
    root,
    head: headResult.stdout.trim() || "NO_HEAD",
    fingerprint,
    files,
    stagedDiff: staged.text,
    unstagedDiff: unstaged.text,
    untrackedContent: untrackedContent.text,
    diffExcerpt: [staged.text, unstaged.text, untrackedContent.text].filter(Boolean).join("\n\n"),
    truncated: staged.truncated || unstaged.truncated || untrackedContent.truncated || untracked.truncated,
  };
}

export function captureWorktreeSnapshot(cwd: string): WorktreeSnapshot | undefined {
  const changes = collectLocalChanges(cwd);
  if (!changes) return undefined;
  return {
    root: changes.root,
    head: changes.head,
    fingerprint: changes.fingerprint,
    files: changes.files,
    diffExcerpt: changes.diffExcerpt.slice(0, 20_000),
  };
}

export function hashDependencyFiles(root: string, paths: string[]): string {
  const parts: Array<string | Buffer> = [];
  for (const path of [...new Set(paths)].sort()) {
    const absolute = isAbsolute(path) ? path : resolve(root, path);
    parts.push(path);
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) {
        parts.push("NOT_FILE");
        continue;
      }
      parts.push(readFileSync(absolute));
    } catch {
      parts.push("MISSING");
    }
  }
  return sha256(parts);
}
