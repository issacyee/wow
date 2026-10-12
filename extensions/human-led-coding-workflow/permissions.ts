/** UI-independent workflow permissions, shared by direct and nested tool calls. */

import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { isSafeCommand } from "../wow/safe.ts";
import { readGlobalWowSetting } from "../wow/settings.ts";
import type { TurnMode } from "./state.ts";

export const READ_ONLY_MCP_TOOLS_SETTING = ["wow", "workflow", "readOnlyMcpTools"];

const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls", "bash", "webfetch", "codemode",
  "codegraph_explore", "codegraph_node", "codegraph_search", "codegraph_callers", "codegraph_status",
]);
const MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

export function isReadOnlyMode(mode: TurnMode): boolean {
  return mode === "discuss" || mode === "plan" || mode === "revise";
}

export function readReadOnlyMcpTools(): string[] {
  const value = readGlobalWowSetting(READ_ONLY_MCP_TOOLS_SETTING);
  if (!Array.isArray(value)) return [];
  // Only exact registered identifiers are meaningful. Wildcards never grant access.
  return value.filter((name): name is string => typeof name === "string" && (
    /^mcp__[A-Za-z0-9_]+$/.test(name) || MCP_RESOURCE_TOOLS.has(name)
  ));
}

export function checkWorkflowToolCall(
  mode: TurnMode,
  event: Pick<ToolCallEvent, "toolName" | "input" | "parentToolCallId">,
  mcpTools: readonly string[] = [],
  registeredTools: readonly string[] = [],
): ToolCallEventResult | undefined {
  if (!isReadOnlyMode(mode)) return;
  const name = event.toolName;
  const block = (reason: string): ToolCallEventResult => ({ block: true, reason: `Human-led workflow: ${reason}` });

  if (name === "edit" || name === "write") {
    return block(`${name} is disabled in ${mode} mode. Use $ to execute an approved plan.`);
  }
  if (name === "tool_search") {
    return block(`tool_search is disabled in ${mode} mode because it activates tools. Use codemode's searchTools() or describeTool() instead.`);
  }
  if (/^mcp__/.test(name) || MCP_RESOURCE_TOOLS.has(name)) {
    if (mcpTools.includes(name) && registeredTools.includes(name)) return;
    return block(`${name} is not authorized in ${mode} mode. Add its exact registered name to global wow.workflow.readOnlyMcpTools only after verifying its behavior.`);
  }
  if (!READ_ONLY_TOOLS.has(name)) {
    return block(`${name} is not allowed in ${mode} mode. Allowed tools: read, grep, find, ls, bash(read-only), webfetch, codegraph queries, codemode, and globally authorized MCP tools.`);
  }
  if (name === "bash") {
    const commandInput = (event.input as Record<string, unknown>).command;
    const command = typeof commandInput === "string" ? commandInput : "";
    if (!command.trim() || !isSafeCommand(command)) {
      return block(`command blocked in ${mode} mode. Only allowlisted read-only commands are permitted.\nBlocked command: ${command}`);
    }
  }
  // Codemode is an orchestrator, not a script-text allowlist: pi routes every
  // tools.* call through this same hook. models.* is intentionally outside it;
  // data disclosure and model-call costs are accepted policy boundaries.
}
