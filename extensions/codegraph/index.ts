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
import { formatCommandResult, runCodeGraph, type CodeGraphCommandResult } from "./runner.ts";
import { truncateCodeGraphOutput } from "./truncate.ts";

const AUTO_SYNC_INTERVAL_MS = 5_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const CODEGRAPH_RENDER_OPTIONS_KEY = Symbol.for("wow.codegraph.renderOptions");
const lastSyncByRoot = new Map<string, number>();

type RenderOptionsMap = Record<string, Record<string, any>>;

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
    ctx.ui.notify(`${description} complete`, "info");
  } else {
    ctx.ui.notify(`${description} failed: ${text.slice(0, 500)}`, "error");
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
      await runCommandForUi(ctx, ["init"], "CodeGraph init", 180);
    },
  });

  pi.registerCommand("codegraph:sync", {
    description: "Synchronize the current project's CodeGraph index",
    handler: async (_args, ctx) => {
      await runCommandForUi(ctx, ["sync"], "CodeGraph sync", 120);
    },
  });

  pi.registerCommand("codegraph:status", {
    description: "Show CodeGraph status for the current project",
    handler: async (_args, ctx) => {
      const result = await runCodeGraph(["status"], { cwd: ctx.cwd, timeoutSeconds: 60, signal: ctx.signal });
      const text = formatCommandResult(result);
      ctx.ui.notify(text.slice(0, 2000), result.exitCode === 0 ? "info" : "error");
    },
  });
}
