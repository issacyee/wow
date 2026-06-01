/**
 * Shell execution utilities
 *
 * Synchronous command execution wrappers with error handling.
 * Extracted from git-commit for reuse across extensions.
 */

import { execSync } from "node:child_process";

/**
 * Run a command, return stdout on success or null on failure.
 * When ignoreStderr is true, stderr is suppressed (cross-platform).
 * Uses stdio option instead of shell redirects to avoid
 * /dev/null vs NUL incompatibility on Windows.
 */
export function execOrNull(command: string, ignoreStderr = false): string | null {
  try {
    const opts: any = { encoding: "utf-8", timeout: 10000 };
    if (ignoreStderr) opts.stdio = ["ignore", "pipe", "ignore"];
    return execSync(command, opts).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Run a command, returning structured result with stdout, stderr, and exitCode.
 * Never throws — errors are captured in the return value.
 */
export function execWithError(command: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(command, { encoding: "utf-8", timeout: 30000 }).trim();
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: (e.stdout?.toString() || "").trim(),
      stderr: (e.stderr?.toString() || "").trim(),
      exitCode: e.status ?? 1,
    };
  }
}
