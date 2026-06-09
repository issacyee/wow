/**
 * Wow TUI focus-style built-in tool rendering.
 *
 * Re-registers built-in tools with the same execution behavior but a minimal
 * visual shell: one dim line for the call and no result preview. Also installs
 * the same render adapter for webfetch before the webfetch extension registers
 * its logic tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { setWebfetchRenderOptions } from "../webfetch/index.ts";
import { linkPath, shortenCommand } from "../wow/paths.ts";
import { createFocusRenderCall, focusRenderResult } from "../wow/renderer.ts";

interface ToolSet {
  read: ReturnType<typeof createReadTool>;
  bash: ReturnType<typeof createBashTool>;
  edit: ReturnType<typeof createEditTool>;
  write: ReturnType<typeof createWriteTool>;
  grep: ReturnType<typeof createGrepTool>;
  find: ReturnType<typeof createFindTool>;
  ls: ReturnType<typeof createLsTool>;
}

const toolCache = new Map<string, ToolSet>();

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

function getTools(cwd: string): ToolSet {
  let tools = toolCache.get(cwd);
  if (!tools) {
    tools = createToolSet(cwd);
    toolCache.set(cwd, tools);
  }
  return tools;
}

const defaultTools = createToolSet(process.cwd());
const emptyResult = () => new Container();

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
      const cwd = context?.cwd ?? process.cwd();
      const path = linkPath(args.path || "", cwd);
      let text = `read ${path}`;
      if (args.offset !== undefined) {
        const start = args.offset;
        const end = args.limit !== undefined ? start + args.limit - 1 : "";
        text += `:${start}${end ? `-${end}` : ""}`;
      }
      return new Text(theme.fg("dim", text), 1, 0);
    },
    renderResult: emptyResult,
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
    renderCall(args, theme) {
      const cmd = shortenCommand(args.command || "");
      return new Text(theme.fg("dim", `$ ${cmd}`), 1, 0);
    },
    renderResult: emptyResult,
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
      const cwd = context?.cwd ?? process.cwd();
      const path = linkPath(args.path || "", cwd);
      const editCount = args.edits && Array.isArray(args.edits) ? args.edits.length : 1;
      const countInfo = editCount > 1 ? ` (${editCount} edits)` : "";
      return new Text(theme.fg("dim", `edit ${path}${countInfo}`), 1, 0);
    },
    renderResult: emptyResult,
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
      const cwd = context?.cwd ?? process.cwd();
      const path = linkPath(args.path || "", cwd);
      return new Text(theme.fg("dim", `write ${path}`), 1, 0);
    },
    renderResult: emptyResult,
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
      const cwd = context?.cwd ?? process.cwd();
      const pattern = args.pattern || "";
      const displayPattern = pattern.length > 40 ? pattern.slice(0, 37) + "..." : pattern;
      let text = `grep /${displayPattern}/`;
      if (args.path) {
        text += ` in ${linkPath(args.path, cwd)}`;
      }
      return new Text(theme.fg("dim", text), 1, 0);
    },
    renderResult: emptyResult,
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
      const cwd = context?.cwd ?? process.cwd();
      const pattern = args.pattern || "";
      const displayPattern = pattern.length > 45 ? pattern.slice(0, 42) + "..." : pattern;
      let text = `find ${displayPattern}`;
      if (args.path && args.path !== ".") {
        text += ` in ${linkPath(args.path, cwd)}`;
      }
      return new Text(theme.fg("dim", text), 1, 0);
    },
    renderResult: emptyResult,
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
      const cwd = context?.cwd ?? process.cwd();
      const path = args.path && args.path !== "." ? linkPath(args.path, cwd) : ".";
      return new Text(theme.fg("dim", `ls ${path}`), 1, 0);
    },
    renderResult: emptyResult,
  });

  setWebfetchRenderOptions({
    renderShell: "self",
    renderCall: createFocusRenderCall("webfetch"),
    renderResult: focusRenderResult,
  });
}
