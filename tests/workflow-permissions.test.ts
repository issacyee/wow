// Regression: direct and Codemode-nested calls share one read-only policy.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkflowToolCall, readReadOnlyMcpTools } from "../extensions/human-led-coding-workflow/permissions.ts";
import { readGlobalWowSetting, readWowSetting } from "../extensions/wow/settings.ts";

const root = mkdtempSync(join(tmpdir(), "wow-permissions-"));
const agentDir = join(root, "agent");
const project = join(root, "project");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalCwd = process.cwd();
mkdirSync(agentDir);
mkdirSync(join(project, ".pi"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.chdir(project);
const key = ["wow", "workflow", "readOnlyMcpTools"];
const settings = (value: unknown) => ({ wow: { workflow: { readOnlyMcpTools: value } } });
const globalPath = join(agentDir, "settings.json");

try {
  writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify(settings(["mcp__project__write"])));
  assert.deepEqual(readReadOnlyMcpTools(), [], "project-only settings cannot grant access");
  for (const value of [null, "mcp__docs__search", {}, 42, [], ["*", "mcp__*", "mcp__docs__*", "read", 7]]) {
    writeFileSync(globalPath, JSON.stringify(settings(value)));
    assert.deepEqual(readReadOnlyMcpTools(), []);
  }
  for (const invalid of ["", "{", "[]", "null"]) {
    writeFileSync(globalPath, invalid);
    assert.deepEqual(readReadOnlyMcpTools(), []);
  }
  // pi truncates long names before appending a hash; the server/tool separator
  // need not survive truncation. Authorization still requires actual registration.
  const shortened = `mcp__${"a".repeat(50)}_12345678`;
  const authorized = ["mcp__docs__search", shortened, "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
  writeFileSync(globalPath, JSON.stringify(settings([...authorized, "*", null, "other"])));
  assert.deepEqual(readReadOnlyMcpTools(), authorized);
  assert.deepEqual(readGlobalWowSetting(key), [...authorized, "*", null, "other"]);
  assert.deepEqual(readWowSetting(key), ["mcp__project__write"], "ordinary scoped settings still prefer the project");

  for (const mode of ["discuss", "plan", "revise"] as const) {
    for (const parentToolCallId of [undefined, "codemode-parent"]) {
      const call = (toolName: string, input: Record<string, unknown> = {}, allow = authorized, registered = authorized) =>
        checkWorkflowToolCall(mode, { toolName, input, parentToolCallId }, allow, registered);
      for (const name of ["read", "grep", "find", "ls", "webfetch", "codemode", "codegraph_explore", "codegraph_node", "codegraph_search", "codegraph_callers", "codegraph_status"]) {
        assert.equal(call(name), undefined, `${mode}: ${name}`);
      }
      for (const command of ["git status --short", "git diff --stat", "rg pattern . | head -20", "ls && pwd", "curl https://example.com"]) {
        assert.equal(call("bash", { command }), undefined, command);
      }
      for (const command of ["rm -rf .", "git reset --hard", "echo value > file", "ls; touch changed", "find . -delete", "curl -o file https://example.com", "env node -e 'process.exit()'"]) {
        assert.equal(call("bash", { command })?.block, true, command);
      }
      for (const name of ["edit", "write", "unknown_tool", "powershell", "tool_search", "mcp__project__write", "mcp__docs__Search"]) {
        assert.equal(call(name)?.block, true, name);
      }
      assert.equal(call("bash", {})?.block, true, "missing command fails closed");
      for (const name of authorized) {
        assert.equal(call(name), undefined, name);
        assert.equal(call(name, {}, [], authorized)?.block, true, "registration alone cannot grant access");
        assert.equal(call(name, {}, authorized, [])?.block, true, "allowlisting alone cannot grant access");
      }
      assert.equal(call("mcp__docs__search", {}, ["mcp__docs__*"], authorized)?.block, true);
      assert.match(call("tool_search")!.reason!, /searchTools\(\).*describeTool\(\)/);
    }
  }
  for (const mode of [null, "execute", "autoExecute"] as const) {
    for (const toolName of ["write", "edit", "tool_search", "unknown", "mcp__project__write", "bash"]) {
      assert.equal(checkWorkflowToolCall(mode, { toolName, input: { command: "rm anything" } }), undefined);
    }
  }
  console.log("OK: shared direct/nested permissions and exact global MCP authorization");
} finally {
  process.chdir(originalCwd);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(root, { recursive: true, force: true });
}
