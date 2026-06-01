/**
 * Focus Mode — minimal, unobtrusive tool rendering
 *
 * Overrides all 7 built-in tools to replace the default green-background Box
 * with a single dim-text line per tool call. Tool results (output) are hidden.
 * Multiple consecutive tool calls appear flush together with no spacing.
 *
 * The rendering style uses `theme.fg("dim", ...)` — the same muted color as
 * collapsed thinking blocks — so tool calls remain visible for context but
 * don't compete for visual attention.
 *
 * Usage: load via package.json, then use Ctrl+O to toggle collapse/expand.
 *   Ctrl+T hides thinking blocks, Ctrl+O collapses tool rows.
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
import { Text, Container } from "@earendil-works/pi-tui";
import { hyperlink } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── Helpers ──

/** Shorten home directory paths to ~/... and truncate very long paths */
function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  if (path.length > 55) {
    return path.slice(0, 24) + "..." + path.slice(-28);
  }
  return path;
}

/**
 * Resolve a path relative to cwd and wrap it in an OSC 8 file:// hyperlink.
 * Falls back to plain text if the path cannot be resolved.
 */
function linkPath(path: string, cwd: string): string {
  try {
    const abs = resolve(cwd, path);
    return hyperlink(shortenPath(path), `file://${abs}`);
  } catch {
    return shortenPath(path);
  }
}

/** Truncate a command string to a reasonable display length */
function shortenCommand(cmd: string): string {
  const collapsed = cmd.replace(/\s+/g, " ").trim();
  if (collapsed.length > 60) {
    return collapsed.slice(0, 57) + "...";
  }
  return collapsed;
}

// ── Tool cache (keyed by cwd) ──

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

// Get a representative tool set for parameter/description extraction
const defaultTools = createToolSet(process.cwd());

// ── Extension entry ──

export default function (pi: ExtensionAPI): void {
  // =========================================================================
  // Read — "read src/index.ts"
  // =========================================================================
  pi.registerTool({
    name: "read",
    label: "read",
    description: defaultTools.read.description,
    parameters: defaultTools.read.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tools = getTools(ctx.cwd);
      return tools.read.execute(toolCallId, params, signal, onUpdate);
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
    renderResult(_result, _options, _theme, _context) {
      return new Container();
    },
  });

  // =========================================================================
  // Bash — "$ npm test"
  // =========================================================================
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: defaultTools.bash.description,
    parameters: defaultTools.bash.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tools = getTools(ctx.cwd);
      return tools.bash.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, _context) {
      const cmd = shortenCommand(args.command || "");
      return new Text(theme.fg("dim", `$ ${cmd}`), 1, 0);
    },
    renderResult(_result, _options, _theme, _context) {
      return new Container();
    },
  });

  // =========================================================================
  // Edit — "edit src/index.ts"
  // =========================================================================
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: defaultTools.edit.description,
    parameters: defaultTools.edit.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tools = getTools(ctx.cwd);
      return tools.edit.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      const cwd = context?.cwd ?? process.cwd();
      const path = linkPath(args.path || "", cwd);
      const editCount =
        args.edits && Array.isArray(args.edits) ? args.edits.length : 1;
      const countInfo = editCount > 1 ? ` (${editCount} edits)` : "";
      return new Text(theme.fg("dim", `edit ${path}${countInfo}`), 1, 0);
    },
    renderResult(_result, _options, _theme, _context) {
      return new Container();
    },
  });

  // =========================================================================
  // Write — "write dist/config.js"
  // =========================================================================
  pi.registerTool({
    name: "write",
    label: "write",
    description: defaultTools.write.description,
    parameters: defaultTools.write.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tools = getTools(ctx.cwd);
      return tools.write.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      const cwd = context?.cwd ?? process.cwd();
      const path = linkPath(args.path || "", cwd);
      return new Text(theme.fg("dim", `write ${path}`), 1, 0);
    },
    renderResult(_result, _options, _theme, _context) {
      return new Container();
    },
  });

  // =========================================================================
  // Grep — "grep /pattern/"
  // =========================================================================
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: defaultTools.grep.description,
    parameters: defaultTools.grep.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tools = getTools(ctx.cwd);
      return tools.grep.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      const cwd = context?.cwd ?? process.cwd();
      const pattern = args.pattern || "";
      const displayPattern =
        pattern.length > 40 ? pattern.slice(0, 37) + "..." : pattern;
      let text = `grep /${displayPattern}/`;
      if (args.path) {
        text += ` in ${linkPath(args.path, cwd)}`;
      }
      return new Text(theme.fg("dim", text), 1, 0);
    },
    renderResult(_result, _options, _theme, _context) {
      return new Container();
    },
  });

  // =========================================================================
  // Find — "find **/*.ts"
  // =========================================================================
  pi.registerTool({
    name: "find",
    label: "find",
    description: defaultTools.find.description,
    parameters: defaultTools.find.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tools = getTools(ctx.cwd);
      return tools.find.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      const cwd = context?.cwd ?? process.cwd();
      const pattern = args.pattern || "";
      const displayPattern =
        pattern.length > 45 ? pattern.slice(0, 42) + "..." : pattern;
      let text = `find ${displayPattern}`;
      if (args.path && args.path !== ".") {
        text += ` in ${linkPath(args.path, cwd)}`;
      }
      return new Text(theme.fg("dim", text), 1, 0);
    },
    renderResult(_result, _options, _theme, _context) {
      return new Container();
    },
  });

  // =========================================================================
  // Ls — "ls src/"
  // =========================================================================
  pi.registerTool({
    name: "ls",
    label: "ls",
    description: defaultTools.ls.description,
    parameters: defaultTools.ls.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tools = getTools(ctx.cwd);
      return tools.ls.execute(toolCallId, params, signal, onUpdate);
    },
    renderCall(args, theme, context) {
      const cwd = context?.cwd ?? process.cwd();
      const path = args.path && args.path !== "." ? linkPath(args.path, cwd) : ".";
      return new Text(theme.fg("dim", `ls ${path}`), 1, 0);
    },
    renderResult(_result, _options, _theme, _context) {
      return new Container();
    },
  });
}
