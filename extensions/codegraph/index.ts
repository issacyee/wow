/**
 * CodeGraph integration.
 *
 * Wraps the CodeGraph CLI as static pi tools and commands. This avoids MCP while
 * keeping CodeGraph as a soft dependency installed by the user.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  CODEGRAPH_INSTALL_COMMAND,
  CODEGRAPH_UPDATE_COMMAND,
  formatCommandResult,
  installCodeGraphCli,
  runCodeGraph,
  runNpmCommand,
  updateCodeGraphCli,
  type CodeGraphCommandResult,
} from "./runner.ts";
import { truncateCodeGraphOutput } from "./truncate.ts";

const AUTO_SYNC_INTERVAL_MS = 5_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const CODEGRAPH_RENDER_OPTIONS_KEY = Symbol.for("wow.codegraph.renderOptions");
const lastSyncByRoot = new Map<string, number>();

type RenderOptionsMap = Record<string, Record<string, any>>;
type NotifyLevel = "info" | "warning" | "error";

function getCodeGraphRenderOptions(): RenderOptionsMap {
  return (globalThis as any)[CODEGRAPH_RENDER_OPTIONS_KEY] ?? {};
}

export function setCodeGraphRenderOptions(renderOptions: RenderOptionsMap): void {
  (globalThis as any)[CODEGRAPH_RENDER_OPTIONS_KEY] = renderOptions;
}

function clampLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(value)));
}

function findCodeGraphRoot(cwd: string): string | undefined {
  let current = cwd;

  while (true) {
    if (existsSync(join(current, ".codegraph"))) return current;

    const parent = join(current, "..");
    if (parent === current) return undefined;
    current = parent;
  }
}

function indexMissingText(): string {
  return [
    "CodeGraph index not found for this project.",
    "Initialize it with /codegraph:init or run: codegraph init",
  ].join("\n");
}

function notify(ctx: any, text: string, level: NotifyLevel = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
  } else {
    console.log(text);
  }
}

function clippedCommandResult(result: CodeGraphCommandResult, maxChars: number): string {
  return formatCommandResult(result).slice(0, maxChars);
}

function withReindexTip(text: string): string {
  if (!/(earlier version|re-?index|index -f)/iu.test(text)) return text;
  if (text.includes("/codegraph:reindex")) return text;
  return `${text}\n\nTip: run /codegraph:reindex to rebuild this project's index.`;
}

async function isCodeGraphInstalled(ctx: { cwd: string; signal?: AbortSignal }): Promise<boolean> {
  const result = await runCodeGraph(["version"], { cwd: ctx.cwd, timeoutSeconds: 30, signal: ctx.signal });
  return !result.missing && result.exitCode === 0;
}

async function ensureCodeGraphInstalled(ctx: any): Promise<boolean> {
  if (await isCodeGraphInstalled(ctx)) return true;

  if (!ctx.hasUI) {
    notify(
      ctx,
      [
        "CodeGraph CLI is not installed.",
        `Install it with: ${CODEGRAPH_INSTALL_COMMAND}`,
        "Then rerun the CodeGraph command.",
      ].join("\n"),
      "error",
    );
    return false;
  }

  const ok = await ctx.ui.confirm(
    "Install CodeGraph CLI?",
    [
      "CodeGraph CLI is not installed.",
      "",
      "Install it globally now? This will run:",
      CODEGRAPH_INSTALL_COMMAND,
      "",
      "It requires network access and modifies your global npm packages.",
    ].join("\n"),
  );
  if (!ok) {
    notify(ctx, "CodeGraph installation cancelled.", "info");
    return false;
  }

  notify(ctx, `Installing CodeGraph CLI: ${CODEGRAPH_INSTALL_COMMAND}`, "info");
  const installResult = await installCodeGraphCli({ cwd: ctx.cwd, timeoutSeconds: 600, signal: ctx.signal });
  if (installResult.exitCode !== 0) {
    notify(ctx, `CodeGraph install failed: ${clippedCommandResult(installResult, 2_000)}`, "error");
    return false;
  }

  notify(ctx, "CodeGraph CLI installed. Verifying...", "info");
  const verifyResult = await runCodeGraph(["version"], { cwd: ctx.cwd, timeoutSeconds: 30, signal: ctx.signal });
  if (verifyResult.exitCode !== 0 || verifyResult.missing) {
    notify(
      ctx,
      [
        "CodeGraph installed, but pi could not verify it on PATH.",
        "Restart pi or ensure your npm global bin directory is on PATH.",
        clippedCommandResult(verifyResult, 1_500),
      ].join("\n"),
      "error",
    );
    return false;
  }

  notify(ctx, `CodeGraph CLI ready (${verifyResult.stdout.trim() || "version verified"}).`, "info");
  return true;
}

async function runReindexCommand(ctx: any): Promise<void> {
  await runCommandForUi(ctx, ["index", "-f"], "CodeGraph reindex", 300);
}

async function maybeAutoSync(root: string, signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const last = lastSyncByRoot.get(root) ?? 0;
  if (now - last < AUTO_SYNC_INTERVAL_MS) return;

  lastSyncByRoot.set(root, now);
  await runCodeGraph(["sync"], { cwd: root, timeoutSeconds: 30, signal });
}

async function runToolCommand(
  args: string[],
  ctx: { cwd: string },
  signal: AbortSignal | undefined,
  timeoutSeconds?: number,
  options: { requireIndex?: boolean; sync?: boolean } = {},
) {
  const requireIndex = options.requireIndex ?? true;
  const root = findCodeGraphRoot(ctx.cwd);
  if (requireIndex && !root) {
    return {
      content: [{ type: "text" as const, text: indexMissingText() }],
      details: { missingIndex: true, args },
    };
  }

  const cwd = root ?? ctx.cwd;
  if (options.sync !== false && root) {
    await maybeAutoSync(root, signal);
  }

  const result = await runCodeGraph(args, { cwd, timeoutSeconds, signal });
  const output = await truncateCodeGraphOutput(formatCommandResult(result));

  return {
    content: [{ type: "text" as const, text: output.text }],
    details: {
      args,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      missingCli: result.missing,
      outputTooLarge: result.outputTooLarge,
      truncated: output.truncated,
      fullOutputPath: output.fullOutputPath,
    },
  };
}

async function runCommandForUi(ctx: any, args: string[], description: string, timeoutSeconds = 120): Promise<void> {
  const result: CodeGraphCommandResult = await runCodeGraph(args, { cwd: ctx.cwd, timeoutSeconds, signal: ctx.signal });
  const text = formatCommandResult(result);
  if (result.exitCode === 0) {
    notify(ctx, `${description} complete`, "info");
  } else {
    notify(ctx, `${description} failed: ${text.slice(0, 500)}`, "error");
  }
}

function renderOptions(toolName: string): Record<string, any> {
  return getCodeGraphRenderOptions()[toolName] ?? {};
}

function createExploreTool() {
  const name = "codegraph_explore";
  return defineTool({
    name,
    label: "CodeGraph Explore",
    description: [
      "Explore a codebase using CodeGraph's semantic index.",
      "Use this as the primary tool for architecture, flow, dependency, route, and symbol relationship questions.",
      "It returns relevant symbols, source snippets, relationship maps, and impact context without repeated grep/read loops.",
      "Requires the project to be initialized with /codegraph:init or `codegraph init`.",
    ].join("\n"),
    promptSnippet: "Explore code structure and flows with CodeGraph's semantic index",
    promptGuidelines: [
      "Prefer codegraph_explore over grep/read for structural code exploration when a CodeGraph index exists.",
      "Treat CodeGraph output as already-read context; use read only when exact file text is needed for editing.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language question or area to explore" }),
      timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds, max 120" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runToolCommand(["explore", params.query], ctx, signal, params.timeout);
    },
    ...renderOptions(name),
  });
}

function createNodeTool() {
  const name = "codegraph_node";
  return defineTool({
    name,
    label: "CodeGraph Node",
    description: [
      "Return one symbol's source and relationships, or read a file through CodeGraph with dependency context.",
      "Use this after locating a symbol or file with codegraph_explore/search.",
    ].join("\n"),
    promptSnippet: "Read a symbol or file with CodeGraph relationship context",
    promptGuidelines: [
      "Use codegraph_node for symbol/file details when semantic callers/callees or dependents are useful.",
      "Use pi read before editing to ensure exact current file text.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: "Symbol name or file path" }),
      timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds, max 120" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runToolCommand(["node", params.target], ctx, signal, params.timeout);
    },
    ...renderOptions(name),
  });
}

function createSearchTool() {
  const name = "codegraph_search";
  return defineTool({
    name,
    label: "CodeGraph Search",
    description: "Search CodeGraph's symbol index by name or text.",
    promptSnippet: "Search symbols with CodeGraph",
    promptGuidelines: ["Use codegraph_search when you need to locate a symbol before exploring or reading it."],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      kind: Type.Optional(StringEnum(["function", "class", "method", "interface", "variable", "file"] as const, {
        description: "Optional symbol kind filter",
      })),
      limit: Type.Optional(Type.Number({ description: `Optional result limit, max ${MAX_LIMIT}` })),
      timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds, max 120" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["query", params.query];
      if (params.kind) args.push("--kind", params.kind);
      const limit = clampLimit(params.limit) ?? DEFAULT_LIMIT;
      args.push("--limit", String(limit));
      return runToolCommand(args, ctx, signal, params.timeout);
    },
    ...renderOptions(name),
  });
}

function createCallersTool() {
  const name = "codegraph_callers";
  return defineTool({
    name,
    label: "CodeGraph Callers",
    description: "Find call sites and callback registrations for a symbol through CodeGraph.",
    promptSnippet: "Find callers of a symbol with CodeGraph",
    promptGuidelines: ["Use codegraph_callers to assess impact before changing a function, method, or class."],
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name" }),
      limit: Type.Optional(Type.Number({ description: `Optional result limit, max ${MAX_LIMIT}` })),
      timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds, max 120" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["callers", params.symbol];
      const limit = clampLimit(params.limit);
      if (limit !== undefined) args.push("--limit", String(limit));
      return runToolCommand(args, ctx, signal, params.timeout);
    },
    ...renderOptions(name),
  });
}

function createStatusTool() {
  const name = "codegraph_status";
  return defineTool({
    name,
    label: "CodeGraph Status",
    description: "Show CodeGraph index status for the current project.",
    promptSnippet: "Check CodeGraph index status",
    promptGuidelines: ["Use codegraph_status if CodeGraph tools report a missing or stale index."],
    parameters: Type.Object({
      timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds, max 120" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runToolCommand(["status"], ctx, signal, params.timeout, { requireIndex: false, sync: false });
    },
    ...renderOptions(name),
  });
}

export default function codegraphExtension(pi: ExtensionAPI): void {
  pi.registerTool(createExploreTool());
  pi.registerTool(createNodeTool());
  pi.registerTool(createSearchTool());
  pi.registerTool(createCallersTool());
  pi.registerTool(createStatusTool());

  pi.registerCommand("codegraph:init", {
    description: "Initialize CodeGraph in the current project",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm("Initialize CodeGraph?", "This creates .codegraph/ and builds a local index for the current project.");
        if (!ok) return;
      }
      if (!await ensureCodeGraphInstalled(ctx)) return;
      await runCommandForUi(ctx, ["init"], "CodeGraph init", 180);
    },
  });

  pi.registerCommand("codegraph:sync", {
    description: "Synchronize the current project's CodeGraph index",
    handler: async (_args, ctx) => {
      if (!await ensureCodeGraphInstalled(ctx)) return;
      await runCommandForUi(ctx, ["sync"], "CodeGraph sync", 120);
    },
  });

  pi.registerCommand("codegraph:reindex", {
    description: "Force rebuild the current project's CodeGraph index",
    handler: async (_args, ctx) => {
      if (!await ensureCodeGraphInstalled(ctx)) return;
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Rebuild CodeGraph index?",
          "This runs `codegraph index -f` and rebuilds the current project's .codegraph index.",
        );
        if (!ok) return;
      }
      await runReindexCommand(ctx);
    },
  });

  pi.registerCommand("codegraph:update", {
    description: "Update the global CodeGraph CLI after confirmation",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        notify(
          ctx,
          [
            "Updating the global CodeGraph CLI requires interactive confirmation.",
            `Run manually if intended: ${CODEGRAPH_UPDATE_COMMAND}`,
          ].join("\n"),
          "error",
        );
        return;
      }

      const npmResult = await runNpmCommand(["--version"], { cwd: ctx.cwd, timeoutSeconds: 30, signal: ctx.signal });
      if (npmResult.exitCode !== 0) {
        notify(ctx, `npm is not available: ${clippedCommandResult(npmResult, 1_500)}`, "error");
        return;
      }

      const current = await runCodeGraph(["version"], { cwd: ctx.cwd, timeoutSeconds: 30, signal: ctx.signal });
      const currentVersion = current.exitCode === 0 && !current.missing
        ? current.stdout.trim() || "version detected"
        : "not installed or not available on PATH";

      const ok = await ctx.ui.confirm(
        "Update CodeGraph CLI?",
        [
          `Current CodeGraph: ${currentVersion}`,
          "",
          "Update the global CodeGraph CLI now? This will run:",
          CODEGRAPH_UPDATE_COMMAND,
          "",
          "You usually only need this when you want a newer CodeGraph feature or bug fix.",
        ].join("\n"),
      );
      if (!ok) {
        notify(ctx, "CodeGraph update cancelled.", "info");
        return;
      }

      notify(ctx, `Updating CodeGraph CLI: ${CODEGRAPH_UPDATE_COMMAND}`, "info");
      const updateResult = await updateCodeGraphCli({ cwd: ctx.cwd, timeoutSeconds: 600, signal: ctx.signal });
      if (updateResult.exitCode !== 0) {
        notify(ctx, `CodeGraph update failed: ${clippedCommandResult(updateResult, 2_000)}`, "error");
        return;
      }

      const verifyResult = await runCodeGraph(["version"], { cwd: ctx.cwd, timeoutSeconds: 30, signal: ctx.signal });
      if (verifyResult.exitCode !== 0 || verifyResult.missing) {
        notify(
          ctx,
          [
            "CodeGraph update finished, but pi could not verify it on PATH.",
            "Restart pi or ensure your npm global bin directory is on PATH.",
            clippedCommandResult(verifyResult, 1_500),
          ].join("\n"),
          "error",
        );
        return;
      }

      notify(ctx, `CodeGraph CLI updated (${verifyResult.stdout.trim() || "version verified"}).`, "info");

      const reindex = await ctx.ui.confirm(
        "Rebuild current CodeGraph index?",
        "After updating CodeGraph, rebuilding this project's index can pick up engine improvements. Run `codegraph index -f` now?",
      );
      if (reindex) await runReindexCommand(ctx);
    },
  });

  pi.registerCommand("codegraph:status", {
    description: "Show CodeGraph status for the current project",
    handler: async (_args, ctx) => {
      if (!await ensureCodeGraphInstalled(ctx)) return;
      const result = await runCodeGraph(["status"], { cwd: ctx.cwd, timeoutSeconds: 60, signal: ctx.signal });
      const text = withReindexTip(formatCommandResult(result));
      notify(ctx, text.slice(0, 2_000), result.exitCode === 0 ? "info" : "error");
    },
  });
}
