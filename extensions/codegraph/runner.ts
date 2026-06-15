/**
 * CodeGraph CLI runner.
 *
 * Uses child_process.spawn with shell=false to avoid shell injection. The
 * CodeGraph CLI is a soft dependency: if it is not available on PATH, callers
 * receive a structured result with an installation hint.
 */

import { existsSync } from "node:fs";
import { delimiter, dirname, join, normalize } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const CODEGRAPH_PACKAGE_SHIM = join("node_modules", "@colbymchenry", "codegraph", "npm-shim.js");
const MISSING_CLI_HINT = "CodeGraph CLI not found. Install with: npm i -g @colbymchenry/codegraph";

export interface CodeGraphCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  missing: boolean;
  outputTooLarge: boolean;
}

export interface CodeGraphInvocation {
  command: string;
  args: string[];
}

export function codeGraphCommand(): string {
  return process.platform === "win32" ? "codegraph.cmd" : "codegraph";
}

export function normalizeTimeoutMs(timeoutSeconds?: number): number {
  if (timeoutSeconds === undefined || !Number.isFinite(timeoutSeconds)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.round(timeoutSeconds * 1000)));
}

function splitPathEnv(pathEnv: string | undefined): string[] {
  if (!pathEnv) return [];

  if (process.platform === "win32") {
    if (pathEnv.includes(";")) return pathEnv.split(";");
    return pathEnv.split(":");
  }

  return pathEnv.split(delimiter);
}

function normalizePathCandidate(path: string): string {
  const trimmed = path.trim().replace(/^"|"$/g, "");
  if (process.platform !== "win32") return trimmed;

  const msysPath = /^\/([a-zA-Z])\/(.*)$/.exec(trimmed);
  if (msysPath) {
    return `${msysPath[1].toUpperCase()}:\\${msysPath[2].replace(/\//g, "\\")}`;
  }

  return normalize(trimmed);
}

function addCandidate(candidates: Set<string>, path: string | undefined): void {
  if (!path) return;

  const normalized = normalizePathCandidate(path);
  if (normalized) candidates.add(normalized);
}

function pathCandidates(): string[] {
  const candidates = new Set<string>();

  for (const entry of splitPathEnv(process.env.PATH)) {
    addCandidate(candidates, entry);
  }

  addCandidate(candidates, process.env.NPM_CONFIG_PREFIX);
  addCandidate(candidates, process.env.PREFIX);
  addCandidate(candidates, process.env.APPDATA ? join(process.env.APPDATA, "npm") : undefined);
  addCandidate(candidates, dirname(process.execPath));

  return [...candidates];
}

function findCodeGraphExe(): string | undefined {
  for (const dir of pathCandidates()) {
    const exe = join(dir, "codegraph.exe");
    if (existsSync(exe)) return exe;
  }

  return undefined;
}

function findCodeGraphNpmShim(): string | undefined {
  for (const dir of pathCandidates()) {
    const shim = join(dir, CODEGRAPH_PACKAGE_SHIM);
    if (existsSync(shim)) return shim;
  }

  return undefined;
}

export function resolveCodeGraphInvocation(args: string[]): CodeGraphInvocation | undefined {
  if (process.platform !== "win32") {
    return { command: "codegraph", args };
  }

  const exe = findCodeGraphExe();
  if (exe) return { command: exe, args };

  const npmShim = findCodeGraphNpmShim();
  if (npmShim) return { command: process.execPath, args: [npmShim, ...args] };

  return undefined;
}

function resultFromLaunchError(
  error: any,
  state: Pick<CodeGraphCommandResult, "stdout" | "timedOut" | "outputTooLarge">,
): CodeGraphCommandResult {
  const missing = error?.code === "ENOENT";
  const message = missing
    ? MISSING_CLI_HINT
    : `Failed to launch CodeGraph CLI: ${String(error?.message ?? error)}`;

  return {
    stdout: state.stdout,
    stderr: message,
    exitCode: 127,
    timedOut: state.timedOut,
    missing,
    outputTooLarge: state.outputTooLarge,
  };
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
    let child: ChildProcessWithoutNullStreams | undefined;

    const abortHandler = () => {
      timedOut = true;
      kill();
    };

    const timeoutId = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const finish = (result: CodeGraphCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", abortHandler);
      resolve(result);
    };

    const kill = () => {
      if (child && !child.killed) child.kill(process.platform === "win32" ? undefined : "SIGTERM");
    };

    const invocation = resolveCodeGraphInvocation(args);
    if (!invocation) {
      finish({
        stdout,
        stderr: MISSING_CLI_HINT,
        exitCode: 127,
        timedOut,
        missing: true,
        outputTooLarge,
      });
      return;
    }

    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: any) {
      finish(resultFromLaunchError(error, { stdout, timedOut, outputTooLarge }));
      return;
    }

    if (options.signal?.aborted) {
      abortHandler();
    } else {
      options.signal?.addEventListener("abort", abortHandler, { once: true });
    }

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

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));

    child.on("error", (error: any) => {
      missing = error?.code === "ENOENT";
      finish({
        stdout,
        stderr: missing ? MISSING_CLI_HINT : `Failed to launch CodeGraph CLI: ${String(error?.message ?? error)}`,
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
