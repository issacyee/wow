/**
 * Helpers for local generated directories that should keep only their own
 * .gitignore tracked while ignoring all generated contents below them.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LocalDirectoryGitignoreOptions {
  /** Optional comment written at the top of newly created .gitignore files. */
  comment?: string;
}

export interface LocalDirectoryGitignoreResult {
  /** Absolute or cwd-relative path to the managed .gitignore file. */
  path: string;
  /** True when this call created the file. */
  created: boolean;
  /** Non-throwing best-effort failure, if any. */
  error?: Error;
}

const DEFAULT_COMMENT = "Local generated files. Keep this .gitignore, ignore everything else in this directory.";

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function ensureLocalDirectoryGitignore(
  dir: string,
  options: LocalDirectoryGitignoreOptions = {},
): LocalDirectoryGitignoreResult {
  const gitignorePath = join(dir, ".gitignore");

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(gitignorePath)) return { path: gitignorePath, created: false };

    const comment = (options.comment ?? DEFAULT_COMMENT).trim();
    const content = [
      comment ? `# ${comment}` : undefined,
      "*",
      "!.gitignore",
      "",
    ].filter((line): line is string => line !== undefined).join("\n");

    writeFileSync(gitignorePath, content, "utf-8");
    return { path: gitignorePath, created: true };
  } catch (error) {
    return { path: gitignorePath, created: false, error: toError(error) };
  }
}
