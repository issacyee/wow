// Regression: rendering is presentation-only and preserves native expansion/timing.
import assert from "node:assert/strict";
import { createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition, initTheme, type ExtensionAPI, type ToolRendererResolver, type ToolRenderers, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { registerFocusToolRendering } from "../extensions/wow-tui/tools.ts";

initTheme("dark");
let resolve!: ToolRendererResolver;
let registrations = 0;
registerFocusToolRendering(new Proxy({
  registerToolRenderer(resolver: ToolRendererResolver) { resolve = resolver; registrations++; },
}, {
  get(target, key) {
    assert.equal(key, "registerToolRenderer", `renderer must not access ${String(key)}`);
    return Reflect.get(target, key);
  },
}) as unknown as ExtensionAPI);
assert.equal(registrations, 1);
const theme: any = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, bold: (value: string) => value };
const args = { path: "deep/中文目录/very-long-file-name.ts", offset: 10, limit: 20, command: "printf hello", pattern: "中文.*very_long_pattern", edits: [{}, {}] };
const context = (outputPad = 1): any => ({
  args, toolCallId: "test", invalidate() {}, lastComponent: undefined, state: {}, cwd: process.cwd(),
  executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false,
  isError: false, durationMs: 1234, outputPad,
});
const result: any = { content: [{ type: "text", text: "result details 中文\nsecond line" }], details: { opaque: true }, structuredContent: { value: 42 } };
const options = { expanded: false, isPartial: false };

for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "webfetch", "codegraph_explore", "codegraph_node", "codegraph_search", "codegraph_callers", "codegraph_status"]) {
  for (const outputPad of [0, 1]) {
    const renderer = resolve(name, () => undefined)!;
    const ctx = context(outputPad);
    const call = renderer.renderCall!(args, theme, ctx);
    for (const width of [1, 2, 3, 8, 20, 40, 80]) {
      for (const line of call.render(width)) assert.ok(visibleWidth(line) <= width, `${name}: width=${width}`);
    }
    const line = call.render(80)[0]!;
    assert.equal(line.startsWith(" "), outputPad === 1, `${name}: outputPad=${outputPad}`);
    assert.deepEqual(renderer.renderResult!(result, options, theme, ctx).render(40), []);
    for (const expanded of [false, true]) {
      ctx.isError = !expanded;
      const rendered = renderer.renderResult!(result, { ...options, expanded }, theme, ctx);
      assert.match(rendered.render(40).join("\n"), /result details/);
      assert.equal(rendered.render(40)[1]!.indexOf("result"), outputPad, `${name}: result padding is applied once`);
      for (const width of [1, 2, 8, 20, 80]) {
        for (const row of rendered.render(width)) assert.ok(visibleWidth(row) <= width);
      }
    }
  }
}

const calls: any[] = [];
const results: any[] = [];
const nativeCall = new Text("native call", 0, 0);
const nativeResult = new Text("native result", 0, 0);
const native: ToolRenderers = {
  renderCall(input, _theme, ctx) {
    calls.push(ctx);
    assert.equal(input, args);
    assert.notEqual(ctx.state, main.state);
    return nativeCall;
  },
  renderResult(value, opts, _theme, ctx) {
    results.push(ctx);
    assert.equal(value, result);
    assert.equal(opts.isPartial, ctx.isPartial);
    return nativeResult;
  },
};
const main = context();
const wrapped = resolve("bash", () => native)!;
wrapped.renderCall!(args, theme, main);
assert.equal(calls.length, 1, "collapsed calls initialize native live timing");
assert.equal(calls[0].durationMs, 1234);
assert.equal(calls[0].outputPad, 1);
main.expanded = true;
assert.match(wrapped.renderCall!(args, theme, main).render(30)[0]!, /^ native call/);
assert.equal(calls[1].lastComponent, nativeCall);
assert.equal(calls[1].state, calls[0].state);
main.isPartial = true;
wrapped.renderResult!(result, { expanded: true, isPartial: true }, theme, main);
main.expanded = false;
main.isPartial = false;
assert.deepEqual(wrapped.renderResult!(result, options, theme, main).render(30), []);
assert.equal(results.length, 2, "collapsed final result must finalize already-created native live timers");
assert.equal(results[1].durationMs, 1234);
assert.equal(results[1].lastComponent, nativeResult);
assert.equal(results[1].state, calls[0].state);
main.isError = true;
assert.match(wrapped.renderResult!(result, options, theme, main).render(30)[0]!, /^ native result/);
const self = resolve("read", () => ({ ...native, renderShell: "self" }))!;
main.expanded = true;
assert.equal(self.renderCall!(args, theme, main), nativeCall, "no duplicate padding for self-framed renderers");
assert.equal(resolve("unknown", () => native), native, "unrelated tools retain downstream renderers");

// Use real pi tools too: no mutation of execution, outputSchema, or metadata.
const tools: ToolDefinition<any, any>[] = [createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition].map((create) => create(process.cwd()));
for (const tool of tools) {
  const snapshot = { ...tool };
  const renderer = resolve(tool.name, () => tool)!;
  const ctx = context(0);
  ctx.executionStarted = false;
  ctx.expanded = true;
  renderer.renderCall!(args, theme, ctx);
  const rendered = renderer.renderResult!(result, { ...options, expanded: true }, theme, ctx).render(80);
  const text = rendered.join("\n");
  const nativeContext = { ...ctx, state: {}, lastComponent: undefined };
  tool.renderCall!(args, theme, nativeContext);
  assert.deepEqual(rendered, tool.renderResult!(result, { ...options, expanded: true }, theme, nativeContext).render(80));
  if (tool.name === "bash") assert.match(text, /Took 1\.2s/, "native persisted duration is rendered");
  for (const width of [1, 2, 3, 8, 20, 80]) {
    for (const row of renderer.renderResult!(result, { ...options, expanded: true }, theme, ctx).render(width)) assert.ok(visibleWidth(row) <= width);
  }
  assert.deepEqual(tool, snapshot);
}
console.log("OK: renderer-only registration, native delegation/timing, padding, and narrow widths");
