/**
 * Wow TUI focus-style built-in tool rendering.
 *
 * Re-registers built-in tools with the same execution behavior but a minimal
 * visual shell: one dim line by default, with native details available when the
 * tool row is expanded. Also installs the same render adapter for webfetch
 * before the webfetch extension registers its logic tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadTool,
  createReadToolDefinition,
  createBashTool,
  createBashToolDefinition,
  createEditTool,
  createEditToolDefinition,
  createWriteTool,
  createWriteToolDefinition,
  createGrepTool,
  createGrepToolDefinition,
  createFindTool,
  createFindToolDefinition,
  createLsTool,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { setCodeGraphRenderOptions } from "../codegraph/index.ts";
import { setWebfetchRenderOptions } from "../webfetch/index.ts";
import { fitCommand, fitEnd, fitPath, linkPathAdaptive } from "../wow/paths.ts";
import { AdaptiveToolLine, createFocusRenderCall, focusRenderResult } from "../wow/renderer.ts";

interface ToolSet {
  read: ReturnType<typeof createReadTool>;
  bash: ReturnType<typeof createBashTool>;
  edit: ReturnType<typeof createEditTool>;
  write: ReturnType<typeof createWriteTool>;
  grep: ReturnType<typeof createGrepTool>;
  find: ReturnType<typeof createFindTool>;
  ls: ReturnType<typeof createLsTool>;
}

interface NativeToolSet {
  read: ReturnType<typeof createReadToolDefinition>;
  bash: ReturnType<typeof createBashToolDefinition>;
  edit: ReturnType<typeof createEditToolDefinition>;
  write: ReturnType<typeof createWriteToolDefinition>;
  grep: ReturnType<typeof createGrepToolDefinition>;
  find: ReturnType<typeof createFindToolDefinition>;
  ls: ReturnType<typeof createLsToolDefinition>;
}

type BuiltInToolName = keyof NativeToolSet;

interface NativeRendererState {
  nativeCallComponent?: Component;
  nativeResultComponent?: Component;
  [key: string]: any;
}

const toolCache = new Map<string, ToolSet>();
const nativeToolCache = new Map<string, NativeToolSet>();
const UNBOUNDED_WIDTH = Number.MAX_SAFE_INTEGER;

function createToolSet(cwd: string): ToolSet {
  return {
    read: createReadTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
  };
}

function createNativeToolSet(cwd: string): NativeToolSet {
  return {
    read: createReadToolDefinition(cwd),
    bash: createBashToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
  };
}

function getTools(cwd: string): ToolSet {
  let tools = toolCache.get(cwd);
  if (!tools) {
    tools = createToolSet(cwd);
    toolCache.set(cwd, tools);
  }
  return tools;
}

function getNativeTools(cwd: string): NativeToolSet {
  let tools = nativeToolCache.get(cwd);
  if (!tools) {
    tools = createNativeToolSet(cwd);
    nativeToolCache.set(cwd, tools);
  }
  return tools;
}

function renderDimToolLine(theme: any, buildLine: (width: number) => string): AdaptiveToolLine {
  return new AdaptiveToolLine(buildLine, (text) => theme.fg("dim", text));
}

function nativeRenderContext(context: any, slot: "call" | "result"): any {
  const state = context.state as NativeRendererState;
  const lastComponent = slot === "call" ? state.nativeCallComponent : state.nativeResultComponent;
  return { ...context, lastComponent };
}

function renderNativeCall(toolName: BuiltInToolName, args: any, theme: any, context: any): Component {
  const native = getNativeTools(context.cwd ?? process.cwd())[toolName];
  const renderContext = nativeRenderContext(context, "call");
  const component = native.renderCall?.(args, theme, renderContext) ?? new Container();
  (context.state as NativeRendererState).nativeCallComponent = component;
  return component;
}

function renderNativeResult(toolName: BuiltInToolName, result: any, options: any, theme: any, context: any): Component {
  if (!options?.expanded && !context?.isError) return new Container();

  const native = getNativeTools(context.cwd ?? process.cwd())[toolName];
  const renderContext = nativeRenderContext(context, "result");
  const component = native.renderResult?.(result, options, theme, renderContext) ?? new Container();
  (context.state as NativeRendererState).nativeResultComponent = component;
  return component;
}

function rangeSuffix(args: { offset?: number; limit?: number }): string {
  if (args.offset === undefined) return "";

  const start = args.offset;
  const end = args.limit !== undefined ? start + args.limit - 1 : "";
  return `:${start}${end ? `-${end}` : ""}`;
}

function pathLine(prefix: string, path: string, cwd: string, width: number, suffix = ""): string {
  const fullPath = linkPathAdaptive(path, cwd, UNBOUNDED_WIDTH);
  const fullLine = `${prefix}${fullPath}${suffix}`;
  if (visibleWidth(fullLine) <= width) return fullLine;

  const pathWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
  return `${prefix}${linkPathAdaptive(path, cwd, pathWidth)}${suffix}`;
}

function allocateTwoWidths(
  first: string,
  second: string,
  totalWidth: number,
  firstMin = 8,
  secondMin = 12,
): [number, number] {
  if (totalWidth <= 0) return [0, 0];

  const firstFull = visibleWidth(first);
  const secondFull = visibleWidth(second);
  if (firstFull + secondFull <= totalWidth) return [firstFull, secondFull];

  if (firstFull <= firstMin && firstFull + secondMin <= totalWidth) {
    return [firstFull, totalWidth - firstFull];
  }
  if (secondFull <= secondMin && secondFull + firstMin <= totalWidth) {
    return [totalWidth - secondFull, secondFull];
  }

  const firstWidth = Math.max(1, Math.min(firstFull, Math.floor(totalWidth * 0.45)));
  return [firstWidth, Math.max(1, totalWidth - firstWidth)];
}

function grepLine(args: any, cwd: string, width: number): string {
  const pattern = String(args.pattern ?? "");

  if (!args.path) {
    const prefix = "grep /";
    const suffix = "/";
    const fullLine = `${prefix}${pattern}${suffix}`;
    if (visibleWidth(fullLine) <= width) return fullLine;

    const patternWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
    return `${prefix}${fitEnd(pattern, patternWidth)}${suffix}`;
  }

  const path = String(args.path);
  const pathLabel = fitPath(path, UNBOUNDED_WIDTH);
  const fullPath = linkPathAdaptive(path, cwd, UNBOUNDED_WIDTH);
  const fullLine = `grep /${pattern}/ in ${fullPath}`;
  if (visibleWidth(fullLine) <= width) return fullLine;

  const staticWidth = visibleWidth("grep /") + visibleWidth("/ in ");
  const budget = Math.max(2, width - staticWidth);
  const [patternWidth, pathWidth] = allocateTwoWidths(pattern, pathLabel, budget);

  return `grep /${fitEnd(pattern, patternWidth)}/ in ${linkPathAdaptive(path, cwd, pathWidth)}`;
}

function findLine(args: any, cwd: string, width: number): string {
  const pattern = String(args.pattern ?? "");

  if (!args.path || args.path === ".") {
    const prefix = "find ";
    const fullLine = `${prefix}${pattern}`;
    if (visibleWidth(fullLine) <= width) return fullLine;

    return `${prefix}${fitEnd(pattern, Math.max(1, width - visibleWidth(prefix)))}`;
  }

  const path = String(args.path);
  const pathLabel = fitPath(path, UNBOUNDED_WIDTH);
  const fullPath = linkPathAdaptive(path, cwd, UNBOUNDED_WIDTH);
  const fullLine = `find ${pattern} in ${fullPath}`;
  if (visibleWidth(fullLine) <= width) return fullLine;

  const staticWidth = visibleWidth("find ") + visibleWidth(" in ");
  const budget = Math.max(2, width - staticWidth);
  const [patternWidth, pathWidth] = allocateTwoWidths(pattern, pathLabel, budget);

  return `find ${fitEnd(pattern, patternWidth)} in ${linkPathAdaptive(path, cwd, pathWidth)}`;
}

const defaultTools = createToolSet(process.cwd());

export function registerFocusToolRendering(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "read",
    description: defaultTools.read.description,
    parameters: defaultTools.read.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      if (context?.expanded) return renderNativeCall("read", args, theme, context);

      const cwd = context?.cwd ?? process.cwd();
      const path = args.path || "";
      const suffix = rangeSuffix(args);
      return renderDimToolLine(theme, (width) => pathLine("read ", path, cwd, width, suffix));
    },
    renderResult(result, options, theme, context) {
      return renderNativeResult("read", result, options, theme, context);
    },
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: defaultTools.bash.description,
    parameters: defaultTools.bash.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      if (context?.expanded) return renderNativeCall("bash", args, theme, context);

      const command = args.command || "";
      return renderDimToolLine(theme, (width) => {
        const prefix = "$ ";
        const collapsed = String(command).replace(/\s+/g, " ").trim();
        const fullLine = `${prefix}${collapsed}`;
        if (visibleWidth(fullLine) <= width) return fullLine;

        return `${prefix}${fitCommand(collapsed, Math.max(1, width - visibleWidth(prefix)))}`;
      });
    },
    renderResult(result, options, theme, context) {
      return renderNativeResult("bash", result, options, theme, context);
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: defaultTools.edit.description,
    parameters: defaultTools.edit.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      if (context?.expanded) return renderNativeCall("edit", args, theme, context);

      const cwd = context?.cwd ?? process.cwd();
      const path = args.path || "";
      const editCount = args.edits && Array.isArray(args.edits) ? args.edits.length : 1;
      const suffix = editCount > 1 ? ` (${editCount} edits)` : "";
      return renderDimToolLine(theme, (width) => pathLine("edit ", path, cwd, width, suffix));
    },
    renderResult(result, options, theme, context) {
      return renderNativeResult("edit", result, options, theme, context);
    },
  });

  pi.registerTool({
    name: "write",
    label: "write",
    description: defaultTools.write.description,
    parameters: defaultTools.write.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      if (context?.expanded) return renderNativeCall("write", args, theme, context);

      const cwd = context?.cwd ?? process.cwd();
      const path = args.path || "";
      return renderDimToolLine(theme, (width) => pathLine("write ", path, cwd, width));
    },
    renderResult(result, options, theme, context) {
      return renderNativeResult("write", result, options, theme, context);
    },
  });

  pi.registerTool({
    name: "grep",
    label: "grep",
    description: defaultTools.grep.description,
    parameters: defaultTools.grep.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      if (context?.expanded) return renderNativeCall("grep", args, theme, context);

      const cwd = context?.cwd ?? process.cwd();
      return renderDimToolLine(theme, (width) => grepLine(args, cwd, width));
    },
    renderResult(result, options, theme, context) {
      return renderNativeResult("grep", result, options, theme, context);
    },
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description: defaultTools.find.description,
    parameters: defaultTools.find.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      if (context?.expanded) return renderNativeCall("find", args, theme, context);

      const cwd = context?.cwd ?? process.cwd();
      return renderDimToolLine(theme, (width) => findLine(args, cwd, width));
    },
    renderResult(result, options, theme, context) {
      return renderNativeResult("find", result, options, theme, context);
    },
  });

  pi.registerTool({
    name: "ls",
    label: "ls",
    description: defaultTools.ls.description,
    parameters: defaultTools.ls.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      if (context?.expanded) return renderNativeCall("ls", args, theme, context);

      const cwd = context?.cwd ?? process.cwd();
      const path = args.path && args.path !== "." ? String(args.path) : ".";
      return renderDimToolLine(theme, (width) => {
        if (path === ".") return "ls .";
        return pathLine("ls ", path, cwd, width);
      });
    },
    renderResult(result, options, theme, context) {
      return renderNativeResult("ls", result, options, theme, context);
    },
  });

  setCodeGraphRenderOptions({
    codegraph_explore: {
      renderShell: "self",
      renderCall: createFocusRenderCall("codegraph explore"),
      renderResult: focusRenderResult,
    },
    codegraph_node: {
      renderShell: "self",
      renderCall: createFocusRenderCall("codegraph node"),
      renderResult: focusRenderResult,
    },
    codegraph_search: {
      renderShell: "self",
      renderCall: createFocusRenderCall("codegraph search"),
      renderResult: focusRenderResult,
    },
    codegraph_callers: {
      renderShell: "self",
      renderCall: createFocusRenderCall("codegraph callers"),
      renderResult: focusRenderResult,
    },
    codegraph_status: {
      renderShell: "self",
      renderCall: createFocusRenderCall("codegraph status"),
      renderResult: focusRenderResult,
    },
  });

  setWebfetchRenderOptions({
    renderShell: "self",
    renderCall: createFocusRenderCall("webfetch"),
    renderResult: focusRenderResult,
  });
}
