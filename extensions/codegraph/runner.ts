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
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const CODEGRAPH_PACKAGE_NAME = "@colbymchenry/codegraph";
const CODEGRAPH_PACKAGE_SHIM = join("node_modules", CODEGRAPH_PACKAGE_NAME, "npm-shim.js");
const NPM_CLI_SHIM = join("node_modules", "npm", "bin", "npm-cli.js");
export const CODEGRAPH_INSTALL_COMMAND = `npm install -g ${CODEGRAPH_PACKAGE_NAME}`;
export const CODEGRAPH_UPDATE_COMMAND = `npm install -g ${CODEGRAPH_PACKAGE_NAME}@latest`;
const MISSING_CLI_HINT = [
  "CodeGraph CLI not found.",
  `Install with: ${CODEGRAPH_INSTALL_COMMAND}`,
  "Or run /codegraph:init in interactive mode to install and initialize it.",
].join("\n");
const MISSING_NPM_HINT = [
  "npm CLI not found.",
  `Install Node.js/npm, then run: ${CODEGRAPH_INSTALL_COMMAND}`,
].join("\n");

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

function normalizeInstallTimeoutMs(timeoutSeconds?: number): number {
  if (timeoutSeconds === undefined || !Number.isFinite(timeoutSeconds)) return DEFAULT_INSTALL_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_INSTALL_TIMEOUT_MS, Math.round(timeoutSeconds * 1000)));
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

function findNpmCliShim(): string | undefined {
  for (const dir of pathCandidates()) {
    const shim = join(dir, NPM_CLI_SHIM);
    if (existsSync(shim)) return shim;
  }

  return undefined;
}

function findNpmCmd(): string | undefined {
  for (const dir of pathCandidates()) {
    const cmd = join(dir, "npm.cmd");
    if (existsSync(cmd)) return cmd;
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

function resolveNpmInvocation(args: string[]): CodeGraphInvocation {
  if (process.platform !== "win32") return { command: "npm", args };

  const npmCli = findNpmCliShim();
  if (npmCli) return { command: process.execPath, args: [npmCli, ...args] };

  const npmCmd = findNpmCmd();
  if (npmCmd) return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${npmCmd}"`, ...args] };

  return { command: "npm.cmd", args };
}

function resultFromLaunchError(
  error: any,
  state: Pick<CodeGraphCommandResult, "stdout" | "timedOut" | "outputTooLarge">,
  missingHint: string,
  label: string,
): CodeGraphCommandResult {
  const missing = error?.code === "ENOENT";
  const message = missing
    ? missingHint
    : `Failed to launch ${label}: ${String(error?.message ?? error)}`;

  return {
    stdout: state.stdout,
    stderr: message,
    exitCode: 127,
    timedOut: state.timedOut,
    missing,
    outputTooLarge: state.outputTooLarge,
  };
}

async function runProcess(
  invocation: CodeGraphInvocation | undefined,
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    missingHint: string;
    label: string;
    outputLabel: string;
  },
): Promise<CodeGraphCommandResult> {
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
    }, options.timeoutMs);

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

    if (!invocation) {
      finish({
        stdout,
        stderr: options.missingHint,
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
      finish(resultFromLaunchError(error, { stdout, timedOut, outputTooLarge }, options.missingHint, options.label));
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
        stderr += `\n${options.outputLabel} output exceeded ${MAX_OUTPUT_BYTES} bytes; process terminated.`;
        kill();
      }
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));

    child.on("error", (error: any) => {
      missing = error?.code === "ENOENT";
      finish({
        stdout,
        stderr: missing ? options.missingHint : `Failed to launch ${options.label}: ${String(error?.message ?? error)}`,
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

export async function runCodeGraph(
  args: string[],
  options: { cwd: string; timeoutSeconds?: number; signal?: AbortSignal },
): Promise<CodeGraphCommandResult> {
  return runProcess(resolveCodeGraphInvocation(args), {
    cwd: options.cwd,
    timeoutMs: normalizeTimeoutMs(options.timeoutSeconds),
    signal: options.signal,
    missingHint: MISSING_CLI_HINT,
    label: "CodeGraph CLI",
    outputLabel: "CodeGraph",
  });
}

export async function runNpmCommand(
  args: string[],
  options: { cwd: string; timeoutSeconds?: number; signal?: AbortSignal },
): Promise<CodeGraphCommandResult> {
  return runProcess(resolveNpmInvocation(args), {
    cwd: options.cwd,
    timeoutMs: normalizeInstallTimeoutMs(options.timeoutSeconds),
    signal: options.signal,
    missingHint: MISSING_NPM_HINT,
    label: "npm",
    outputLabel: "npm",
  });
}

export async function installCodeGraphCli(
  options: { cwd: string; timeoutSeconds?: number; signal?: AbortSignal },
): Promise<CodeGraphCommandResult> {
  return runNpmCommand(["install", "-g", CODEGRAPH_PACKAGE_NAME], options);
}

export async function updateCodeGraphCli(
  options: { cwd: string; timeoutSeconds?: number; signal?: AbortSignal },
): Promise<CodeGraphCommandResult> {
  return runNpmCommand(["install", "-g", `${CODEGRAPH_PACKAGE_NAME}@latest`], options);
}

export function formatCommandResult(result: CodeGraphCommandResult): string {
  const parts: string[] = [];
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`${stdout ? "\n" : ""}[stderr]\n${stderr}`);

  if (result.timedOut) parts.push("\n[command timed out]");
  if (result.exitCode !== 0 && !result.missing && !result.timedOut && !result.outputTooLarge) {
    parts.push(`\n[command exited with code ${result.exitCode}]`);
  }

  return parts.join("\n") || "CodeGraph command completed with no output.";
}
