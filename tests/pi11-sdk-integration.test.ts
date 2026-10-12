// pi >= 1.1.0 SDK integration. No live model/MCP calls or user settings are used.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession, createCodemodeExtension, createToolSearchExtension, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import workflow from "../extensions/human-led-coding-workflow/index.ts";
import { registerFocusToolRendering } from "../extensions/wow-tui/tools.ts";

const root = mkdtempSync(join(tmpdir(), "wow-pi11-sdk-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
mkdirSync(agentDir);
mkdirSync(join(cwd, ".pi"), { recursive: true });
writeFileSync(join(cwd, "fixture.txt"), "read-only fixture");
const settingsPath = join(agentDir, "settings.json");
const settings = (names: string[]) => JSON.stringify({ wow: { workflow: { readOnlyMcpTools: names } } });
writeFileSync(settingsPath, settings(["mcp__docs__search"]));
writeFileSync(join(cwd, ".pi", "settings.json"), settings(["mcp__docs__write"]));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessions: AgentSession[] = [];

try {
  // Actual jiti/resource-loader loading, not just ESM entrypoint imports.
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const smoke = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.inMemory(), noContextFiles: true,
    noSkills: true, noThemes: true, noPromptTemplates: true,
    additionalExtensionPaths: manifest.pi.extensions.map((path: string) => resolve(path)),
  });
  await smoke.reload();
  assert.deepEqual(smoke.getExtensions().errors, [], "all package extensions must load through pi's real loader");
  assert.equal(smoke.getExtensions().extensions.length, manifest.pi.extensions.length);

  const model = getModel("anthropic", "claude-sonnet-4-5")!;
  assert.ok(model);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  // No request escapes the test: all agent streams and non-chat model calls are fakes.
  modelRuntime.hasConfiguredAuth = () => true;
  modelRuntime.streamSimple = () => { throw new Error("Unexpected live model request"); };

  const makeSession = async (visual: boolean, full: boolean) => {
    const observed: any[] = [];
    let readCalls = 0;
    let writeCalls = 0;
    const customTools: ToolDefinition[] = full ? [
      ...["search", "write"].map((action): ToolDefinition => ({
        name: `mcp__docs__${action}`, label: action, description: `Fixture ${action}`,
        exposure: "deferred", namespace: { name: "mcp__docs", description: "Fixture docs" },
        annotations: { readOnlyHint: true }, // hints must NOT authorize the write tool
        parameters: { type: "object", properties: {} } as any,
        outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } as any,
        execute: async () => {
          if (action === "search") readCalls++; else writeCalls++;
          return { content: [{ type: "text", text: "opaque text" }], structuredContent: { value: 42 }, details: { action } };
        },
      })),
    ] : [];
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: SettingsManager.inMemory(), noExtensions: true,
      noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: [
        ...(full ? [createCodemodeExtension(), createToolSearchExtension(), workflow] : []),
        (pi) => {
          if (visual) registerFocusToolRendering(pi);
          pi.on("tool_call", (event) => { observed.push({ ...event }); });
        },
      ],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd, agentDir, model, modelRuntime, resourceLoader, customTools,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        defaultTools: full ? ["+codemode", "+tool_search"] : undefined,
        compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
      }),
    });
    sessions.push(session);
    await session.bindExtensions({});
    session.extensionRunner.onError((error) => { throw new Error(`Extension failure: ${JSON.stringify(error)}`); });
    return { session, observed, counters: () => ({ readCalls, writeCalls }) };
  };

  const plain = await makeSession(false, false);
  const visual = await makeSession(true, false);
  assert.deepEqual(visual.session.getActiveToolNames(), plain.session.getActiveToolNames());
  assert.deepEqual(visual.session.getAllTools(), plain.session.getAllTools());
  assert.equal(visual.session.getActiveToolNames().includes("grep"), false, "rendering cannot activate optional tools");
  for (const tool of plain.session.agent.state.tools) {
    const counterpart = visual.session.agent.state.tools.find((value) => value.name === tool.name)!;
    assert.deepEqual(counterpart.parameters, tool.parameters);
    assert.deepEqual(counterpart.outputSchema, tool.outputSchema);
    assert.equal(counterpart.description, tool.description);
  }

  const { session, observed, counters } = await makeSession(true, true);
  const active = session.getActiveToolNames();
  const all = session.getAllTools();
  const prompt = session.systemPrompt;
  const toolDefinitions = session.agent.state.tools.map(({ name, description, parameters, outputSchema }) => ({ name, description, parameters, outputSchema }));
  let sequence = 0;
  const toolResults: any[] = [];
  session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "toolResult") toolResults.push(event.message);
  });
  const run = async (name: string, args: any) => {
    let requests = 0;
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      const content: any[] = requests++ === 0 ? [{ type: "toolCall", id: `fixture-${++sequence}`, name, arguments: args }] : [{ type: "text", text: "Fixture finished." }];
      const reply: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: content[0]?.type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
      stream.push({ type: "done", reason: reply.stopReason, message: reply });
      return stream;
    };
    await session.prompt("? Inspect the fixture only.");
    return toolResults.at(-1);
  };
  await run("write", { path: "direct.txt", content: "blocked" });
  assert.equal(existsSync(join(cwd, "direct.txt")), false);
  assert.equal(toolResults.at(-1).isError, true);
  await run("tool_search", { query: "docs search" });
  assert.equal(toolResults.at(-1).isError, true);
  const script = `
    const found = await searchTools("Fixture docs");
    text(found.map(t => t.name));
    text(await describeTool("mcp__docs__search"));
    text(await tools.read({ path: "fixture.txt" }));
    text(await tools.bash({ command: "printf safe" }));
    const attempts = await Promise.allSettled([
      tools.write({ path: "nested.txt", content: "blocked" }),
      tools.edit({ path: "fixture.txt", edits: [{ oldText: "fixture", newText: "changed" }] }),
      tools.bash({ command: "echo changed > unsafe.txt" }),
      tools.mcp__docs__write({})
    ]);
    text(attempts.map(a => a.status));
    text(await tools.mcp__docs__search({}));
  `;
  const result = await run("codemode", { code: script });
  const output = result.content.map((value: any) => value.text ?? "").join("\n");
  assert.match(output, /Script completed/);
  assert.match(output, /read-only fixture/);
  assert.match(output, /rejected.*rejected.*rejected.*rejected/);
  assert.match(output, /"value":42/, "native structuredContent reaches scripts, not the opaque text");
  assert.deepEqual(counters(), { readCalls: 1, writeCalls: 0 });
  assert.equal(readFileSync(join(cwd, "fixture.txt"), "utf8"), "read-only fixture");
  assert.equal(existsSync(join(cwd, "nested.txt")), false);
  assert.equal(existsSync(join(cwd, "unsafe.txt")), false);
  const nested = observed.filter((event) => event.parentToolCallId);
  for (const name of ["read", "bash", "mcp__docs__search"]) assert.ok(nested.some((event) => event.toolName === name));

  // Remove global authorization: even an annotated read-only registered MCP tool is blocked.
  writeFileSync(settingsPath, settings([]));
  const blocked = await run("codemode", { code: "text(await tools.mcp__docs__search({}));" });
  assert.match(blocked.content.map((value: any) => value.text ?? "").join("\n"), /not authorized/);
  assert.deepEqual(counters(), { readCalls: 1, writeCalls: 0 });

  // Full models.* stays reachable without tool_call. Fake calls demonstrate the boundary.
  const registry = session.extensionRunner.getModelRegistry();
  let classified = 0;
  let generated = 0;
  registry.getModelOfType = ((type: string, provider: string, id: string) => ({ type, provider, id })) as any;
  registry.classify = async () => { classified++; return { provider: "fake", model: "classifier", api: "typesafe-classifier", timestamp: Date.now(), answers: {}, stopReason: "stop" }; };
  registry.generateImages = async () => { generated++; return { provider: "fake", model: "image", api: "openai-images", timestamp: Date.now(), output: [], stopReason: "stop" }; };
  const before = observed.length;
  const models = await run("codemode", { code: `
    text(await models.classify({ provider: "fake", id: "classifier" }, { state: { privateData: "fixture" }, questions: { ok: { type: "bool", instructions: "Judge", criteria: { true: "yes", false: "no" } } } }));
    text(await models.generateImages({ provider: "fake", id: "image" }, { input: [{ type: "text", text: "fixture" }] }));
  ` });
  assert.match(models.content[0].text, /Script completed/);
  assert.equal(classified, 1);
  assert.equal(generated, 1);
  assert.deepEqual(observed.slice(before).map((event) => event.toolName), ["codemode"]);
  assert.deepEqual(session.getActiveToolNames(), active);
  assert.deepEqual(session.getAllTools(), all);
  assert.equal(session.systemPrompt, prompt, "workflow never changes the system prompt");
  assert.deepEqual(session.agent.state.tools.map(({ name, description, parameters, outputSchema }) => ({ name, description, parameters, outputSchema })), toolDefinitions);

  // Actual SDK abort while waiting for an assistant stream, without terminal input.
  const settled: boolean[] = [];
  session.subscribe((event) => { if (event.type === "agent_settled") settled.push(event.aborted); });
  await run("read", { path: "fixture.txt" });
  assert.equal(settled.at(-1), false);
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  session.agent.streamFunction = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    started();
    options?.signal?.addEventListener("abort", () => {
      const reply: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "aborted", timestamp: Date.now() };
      stream.push({ type: "error", reason: "aborted", error: reply });
    }, { once: true });
    return stream;
  };
  const pending = session.prompt("? Wait for cancellation.");
  await entered;
  await session.abort();
  await pending;
  assert.equal(settled.at(-1), true, "SDK abort propagates through native settled event");
  console.log("OK: pi 1.1 SDK loading, renderer invariants, Codemode gates/structured results/models, and native abort");
} finally {
  for (const session of sessions) session.dispose();
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  rmSync(root, { recursive: true, force: true });
}
