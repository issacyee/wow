/**
 * CodeGraph CLI runner.
 *
 * Uses child_process.spawn with shell=false to avoid shell injection. The
 * CodeGraph CLI is a soft dependency: if it is not available on PATH, callers
 * receive a structured result with an installation hint.
 */

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export interface CodeGraphCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  missing: boolean;
  outputTooLarge: boolean;
}

export function codeGraphCommand(): string {
  return process.platform === "win32" ? "codegraph.cmd" : "codegraph";
}

export function normalizeTimeoutMs(timeoutSeconds?: number): number {
  if (timeoutSeconds === undefined || !Number.isFinite(timeoutSeconds)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.round(timeoutSeconds * 1000)));
}

export async function runCodeGraph(
  args: string[],
  options: { cwd: string; timeoutSeconds?: number; signal?: AbortSignal },
): Promise<CodeGraphCommandResult> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutSeconds);

  return await new Promise<CodeGraphCommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let missing = false;
    let outputTooLarge = false;
    let settled = false;

    const child = spawn(codeGraphCommand(), args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (result: CodeGraphCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", abortHandler);
      resolve(result);
    };

    const kill = () => {
      if (!child.killed) child.kill(process.platform === "win32" ? undefined : "SIGTERM");
    };

    const timeoutId = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const abortHandler = () => {
      timedOut = true;
      kill();
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (outputTooLarge) return;
      const text = chunk.toString("utf8");
      if (target === "stdout") stdout += text;
      else stderr += text;

      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        stderr += `\nCodeGraph output exceeded ${MAX_OUTPUT_BYTES} bytes; process terminated.`;
        kill();
      }
    };

    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));

    child.on("error", (error: any) => {
      missing = error?.code === "ENOENT";
      finish({
        stdout,
        stderr: missing
          ? "CodeGraph CLI not found. Install with: npm i -g @colbymchenry/codegraph"
          : String(error?.message ?? error),
        exitCode: 127,
        timedOut,
        missing,
        outputTooLarge,
      });
    });

    child.on("close", (code) => {
      finish({
        stdout,
        stderr,
        exitCode: outputTooLarge ? 1 : code ?? (timedOut ? 124 : 1),
        timedOut,
        missing,
        outputTooLarge,
      });
    });
  });
}

export function formatCommandResult(result: CodeGraphCommandResult): string {
  const parts: string[] = [];
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`${stdout ? "\n" : ""}[stderr]\n${stderr}`);

  if (result.timedOut) parts.push("\n[codegraph command timed out]");
  if (result.exitCode !== 0 && !result.missing && !result.timedOut && !result.outputTooLarge) {
    parts.push(`\n[codegraph exited with code ${result.exitCode}]`);
  }

  return parts.join("\n") || "CodeGraph command completed with no output.";
}
