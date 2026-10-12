/**
 * Focus-style tool presentation only.
 *
 * Renderer resolvers preserve native execution, schemas, prompt metadata, and
 * activation. Expanded/error rows delegate to the next renderer in pi's chain.
 */

import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { fitCommand, fitEnd, fitPath, linkPathAdaptive } from "../wow/paths.ts";
import { AdaptiveToolLine, createFocusRenderCall, focusRenderResult } from "../wow/renderer.ts";

const BUILT_IN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const CUSTOM_LABELS: Record<string, string> = {
  codegraph_explore: "codegraph explore",
  codegraph_node: "codegraph node",
  codegraph_search: "codegraph search",
  codegraph_callers: "codegraph callers",
  codegraph_status: "codegraph status",
  webfetch: "webfetch",
};
const UNBOUNDED_WIDTH = Number.MAX_SAFE_INTEGER;
const NATIVE_STATE_KEY = "wowFocusNativeRenderer";

interface NativeRendererState {
  call?: Component;
  result?: Component;
  state: Record<string, any>;
}

/** Native renderers normally rely on pi's default shell for horizontal padding. */
class PaddedComponent implements Component {
  constructor(private readonly child: Component, private readonly paddingX: number) {}

  invalidate(): void { this.child.invalidate(); }

  render(width: number): string[] {
    const padding = width >= this.paddingX * 2 + 1 ? this.paddingX : 0;
    return this.child.render(Math.max(1, width - padding * 2))
      .map((line) => `${" ".repeat(padding)}${truncateToWidth(line, Math.max(0, width - padding * 2), "")}${" ".repeat(padding)}`);
  }
}

function nativeState(context: any): NativeRendererState {
  return context.state[NATIVE_STATE_KEY] ??= { state: {} };
}

function delegateCall(native: ToolRenderers | undefined, args: any, theme: any, context: any): Component {
  const state = nativeState(context);
  const component = native?.renderCall?.(args, theme, { ...context, state: state.state, lastComponent: state.call })
    ?? new Text("", 0, 0);
  state.call = component;
  return paddedNative(component, native, context.outputPad);
}

function delegateResult(native: ToolRenderers | undefined, result: any, options: any, theme: any, context: any): Component {
  const state = nativeState(context);
  // Keep calling an already-created native result renderer so it can stop live
  // timers when a row is collapsed before its final result arrives.
  const visible = options.expanded || context.isError;
  if (!visible && !state.result) return new Container();

  if (!native?.renderResult) return focusRenderResult(result, options, theme, context);
  const component = native.renderResult(result, options, theme, { ...context, state: state.state, lastComponent: state.result });
  state.result = component;
  return visible ? paddedNative(component, native, context.outputPad) : new Container();
}

function paddedNative(component: Component, native: ToolRenderers | undefined, padding: number): Component {
  // A self-rendering downstream renderer already owns its framing/padding.
  return native?.renderShell === "self" ? component : new PaddedComponent(component, padding);
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

function allocateTwoWidths(first: string, second: string, totalWidth: number, firstMin = 8, secondMin = 12): [number, number] {
  if (totalWidth <= 0) return [0, 0];
  const firstFull = visibleWidth(first);
  const secondFull = visibleWidth(second);
  if (firstFull + secondFull <= totalWidth) return [firstFull, secondFull];
  if (firstFull <= firstMin && firstFull + secondMin <= totalWidth) return [firstFull, totalWidth - firstFull];
  if (secondFull <= secondMin && secondFull + firstMin <= totalWidth) return [totalWidth - secondFull, secondFull];
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
    return `${prefix}${fitEnd(pattern, Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix)))}${suffix}`;
  }
  const path = String(args.path);
  const pathLabel = fitPath(path, UNBOUNDED_WIDTH);
  const fullPath = linkPathAdaptive(path, cwd, UNBOUNDED_WIDTH);
  const fullLine = `grep /${pattern}/ in ${fullPath}`;
  if (visibleWidth(fullLine) <= width) return fullLine;
  const budget = Math.max(2, width - visibleWidth("grep /") - visibleWidth("/ in "));
  const [patternWidth, pathWidth] = allocateTwoWidths(pattern, pathLabel, budget);
  return `grep /${fitEnd(pattern, patternWidth)}/ in ${linkPathAdaptive(path, cwd, pathWidth)}`;
}

function findLine(args: any, cwd: string, width: number): string {
  const pattern = String(args.pattern ?? "");
  if (!args.path || args.path === ".") {
    const prefix = "find ";
    if (visibleWidth(`${prefix}${pattern}`) <= width) return `${prefix}${pattern}`;
    return `${prefix}${fitEnd(pattern, Math.max(1, width - visibleWidth(prefix)))}`;
  }
  const path = String(args.path);
  const pathLabel = fitPath(path, UNBOUNDED_WIDTH);
  const fullPath = linkPathAdaptive(path, cwd, UNBOUNDED_WIDTH);
  const fullLine = `find ${pattern} in ${fullPath}`;
  if (visibleWidth(fullLine) <= width) return fullLine;
  const budget = Math.max(2, width - visibleWidth("find ") - visibleWidth(" in "));
  const [patternWidth, pathWidth] = allocateTwoWidths(pattern, pathLabel, budget);
  return `find ${fitEnd(pattern, patternWidth)} in ${linkPathAdaptive(path, cwd, pathWidth)}`;
}

function compactLine(name: string, args: any, cwd: string, width: number): string {
  switch (name) {
    case "read": return pathLine("read ", args.path || "", cwd, width, rangeSuffix(args));
    case "bash": {
      const command = String(args.command ?? "").replace(/\s+/g, " ").trim();
      return visibleWidth(`$ ${command}`) <= width ? `$ ${command}` : `$ ${fitCommand(command, Math.max(1, width - 2))}`;
    }
    case "edit": {
      const count = Array.isArray(args.edits) ? args.edits.length : 1;
      return pathLine("edit ", args.path || "", cwd, width, count > 1 ? ` (${count} edits)` : "");
    }
    case "write": return pathLine("write ", args.path || "", cwd, width);
    case "grep": return grepLine(args, cwd, width);
    case "find": return findLine(args, cwd, width);
    default: return args.path && args.path !== "." ? pathLine("ls ", String(args.path), cwd, width) : "ls .";
  }
}

export function registerFocusToolRendering(pi: ExtensionAPI): void {
  pi.registerToolRenderer((name, next) => {
    if (BUILT_IN_NAMES.has(name)) {
      const native = next();
      return {
        renderShell: "self",
        renderCall(args, theme, context) {
          // Initialize native state even while collapsed (e.g. live bash timing).
          const expandedCall = delegateCall(native, args, theme, context);
          if (context.expanded) return expandedCall;
          return new AdaptiveToolLine(
            (width) => compactLine(name, args, context.cwd ?? process.cwd(), width),
            (text) => theme.fg("dim", text),
            context.outputPad,
          );
        },
        renderResult(result, options, theme, context) {
          // Forward durationMs unchanged; pi's renderer owns persisted/live timing.
          return delegateResult(native, result, options, theme, context);
        },
      };
    }
    const label = CUSTOM_LABELS[name];
    if (label) {
      return {
        renderShell: "self",
        renderCall: createFocusRenderCall(label),
        renderResult: focusRenderResult,
      };
    }
    return next();
  });
}
