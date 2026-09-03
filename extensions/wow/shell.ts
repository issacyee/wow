/**
 * Shell execution utilities
 *
 * Synchronous command execution wrappers with error handling.
 * Extracted from git-commit for reuse across extensions.
 */

import { execSync } from "node:child_process";

export interface ShellExecutionOptions {
  /** Maximum execution time in milliseconds. */
  timeout?: number;
  /** Maximum buffered stdout/stderr size in bytes. */
  maxBuffer?: number;
}

export interface ExecOrNullOptions extends ShellExecutionOptions {
  /** Suppress stderr instead of inheriting it. */
  ignoreStderr?: boolean;
}

export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Node.js execution error code, for example ENOBUFS or ETIMEDOUT. */
  errorCode?: string;
  /** Signal used to terminate the child process, when available. */
  signal?: string;
}

/**
 * Run a command, return stdout on success or null on failure.
 * The boolean form remains supported for existing ignoreStderr callers.
 * Uses stdio options instead of shell redirects to avoid
 * /dev/null vs NUL incompatibility on Windows.
 */
export function execOrNull(
  command: string,
  optionsOrIgnoreStderr: boolean | ExecOrNullOptions = false,
): string | null {
  try {
    const options = typeof optionsOrIgnoreStderr === "boolean"
      ? { ignoreStderr: optionsOrIgnoreStderr }
      : optionsOrIgnoreStderr;
    const opts: any = {
      encoding: "utf-8",
      timeout: options.timeout ?? 10000,
    };
    if (options.maxBuffer !== undefined) opts.maxBuffer = options.maxBuffer;
    if (options.ignoreStderr) opts.stdio = ["ignore", "pipe", "ignore"];
    return execSync(command, opts).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Run a command, returning structured output and failure details.
 * Never throws — errors are captured in the return value.
 */
export function execWithError(
  command: string,
  options: ShellExecutionOptions = {},
): ShellExecutionResult {
  const execOptions: any = {
    encoding: "utf-8",
    timeout: options.timeout ?? 30000,
  };
  if (options.maxBuffer !== undefined) execOptions.maxBuffer = options.maxBuffer;

  try {
    const stdout = execSync(command, execOptions).trim();
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error: unknown) {
    const executionError = error as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number | null;
      code?: string;
      signal?: string;
    };
    return {
      stdout: (executionError.stdout?.toString() || "").trim(),
      stderr: (executionError.stderr?.toString() || "").trim(),
      exitCode: executionError.status ?? 1,
      errorCode: executionError.code,
      signal: executionError.signal,
    };
  }
}
