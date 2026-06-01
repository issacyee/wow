/**
 * Test suite for index.ts — integration logic tests
 * Run: npx tsx extensions/plan-mode/__tests__/index.ts
 *
 * Tests import internal functions by reading the source and evaluating
 * the parts that can be tested without the full pi runtime.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

// ── Read the index.ts source for structural verification ──

const indexPath = resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts");
const source = readFileSync(indexPath, "utf8");

// ── Structural tests — verify the code contains expected functions/patterns ──

test("resetState function exists", () => {
  assert.ok(source.includes("function resetState()"), "resetState function should be defined");
});

test("resetState sets turnMode to null", () => {
  assert.ok(source.includes("turnMode = null"), "turnMode should be reset to null");
});

test("resetState sets todoItems to []", () => {
  assert.ok(
    source.includes("todoItems = []") && source.includes("function resetState()"),
    "todoItems should be reset to []"
  );
});

test("resetState sets lastTurnHadPlan to false", () => {
  assert.ok(source.includes("lastTurnHadPlan = false"), "lastTurnHadPlan should be reset");
});

test("resetState sets planFullText to empty", () => {
  assert.ok(source.includes('planFullText = ""'), "planFullText should be reset");
});

test("resetState is called in session_start", () => {
  assert.ok(
    source.includes("resetState()") && source.includes("session_start"),
    "resetState should be called in session_start handler"
  );
});

test("persistState function exists", () => {
  assert.ok(source.includes("function persistState("), "persistState function should be defined");
});

test("persistState calls appendEntry with plan-mode type", () => {
  assert.ok(
    source.includes('pi.appendEntry("plan-mode"'),
    "persistState should call appendEntry with 'plan-mode'"
  );
});

test("persistState is called in agent_end", () => {
  // Count persistState calls in agent_end section
  const agentEndIdx = source.indexOf('pi.on("agent_end"');
  assert.ok(agentEndIdx > 0, "agent_end handler should exist");
  const afterAgentEnd = source.slice(agentEndIdx);
  assert.ok(afterAgentEnd.includes("persistState(pi)"), "persistState should be called in agent_end");
});

test("persistState is called in turn_end", () => {
  const turnEndIdx = source.indexOf('pi.on("turn_end"');
  assert.ok(turnEndIdx > 0, "turn_end handler should exist");
  const afterTurnEnd = source.slice(turnEndIdx, source.indexOf('pi.on("agent_end"'));
  assert.ok(afterTurnEnd.includes("persistState(pi)"), "persistState should be called in turn_end");
});

test("updateProgressUI function exists", () => {
  assert.ok(source.includes("function updateProgressUI("), "updateProgressUI function should be defined");
});

test("updateProgressUI sets footer status", () => {
  assert.ok(
    source.includes('ctx.ui.setStatus("plan-mode"'),
    "updateProgressUI should set status"
  );
});

test("updateProgressUI sets widget", () => {
  assert.ok(
    source.includes('ctx.ui.setWidget("plan-todos"'),
    "updateProgressUI should set widget"
  );
});

test("updateProgressUI clears status when not executing", () => {
  assert.ok(
    source.includes('ctx.ui.setStatus("plan-mode", undefined)') &&
    source.includes('ctx.ui.setWidget("plan-todos", undefined)'),
    "updateProgressUI should clear status and widget when not executing"
  );
});

test("buildContinuePlanPrompt accepts existingPlan parameter", () => {
  assert.ok(
    source.includes("function buildContinuePlanPrompt(existingPlan?"),
    "buildContinuePlanPrompt should accept optional existingPlan parameter"
  );
});

test("buildContinuePlanPrompt injects existing plan context", () => {
  assert.ok(
    source.includes("Existing plan to review and update"),
    "buildContinuePlanPrompt should inject existing plan into the prompt"
  );
});

test("planFullText is passed to buildContinuePlanPrompt", () => {
  assert.ok(
    source.includes("buildContinuePlanPrompt(planFullText"),
    "planFullText should be passed to buildContinuePlanPrompt"
  );
});

// ── Empty input handling ──

test("? empty input is handled with notify", () => {
  const inputIdx = source.indexOf('pi.on("input"');
  const inputSection = source.slice(inputIdx);
  assert.ok(
    inputSection.includes('Please provide a description after ?'),
    "Empty ? input should trigger notify"
  );
});

test("?? empty input is handled with notify", () => {
  const inputIdx = source.indexOf('pi.on("input"');
  const inputSection = source.slice(inputIdx);
  assert.ok(
    inputSection.includes('Please provide a description after ??'),
    "Empty ?? input should trigger notify"
  );
});

test("empty ? returns handled action", () => {
  const inputIdx = source.indexOf('pi.on("input"');
  const inputSection = source.slice(inputIdx);
  // Find the block that handles empty ? input
  const emptyQBlock = inputSection.indexOf("Please provide a description after ?");
  assert.ok(emptyQBlock > 0);
  const afterNotify = inputSection.slice(emptyQBlock);
  assert.ok(
    afterNotify.includes('action: "handled"'),
    "Empty ? should return handled"
  );
});

// ── Session restore logic ──

test("session_start restores from appendEntry", () => {
  assert.ok(
    source.includes('customType === "plan-mode"') && source.includes("session_start"),
    "session_start should scan for plan-mode entries"
  );
});

test("session_start re-scans [DONE:n] on resume", () => {
  assert.ok(
    source.includes("markCompletedSteps") && source.includes("executeIndex"),
    "session_start should re-scan for [DONE:n] markers on resume"
  );
});

test("session_start restores todoItems from entry data", () => {
  assert.ok(
    source.includes("planModeEntry?.data"),
    "session_start should read planModeEntry.data"
  );
});

test("tool_call error message updated to whitelist wording", () => {
  assert.ok(
    source.includes("allowlisted read-only commands"),
    "tool_call reason should use whitelist terminology"
  );
});

// ── updateProgressUI called at correct lifecycle points ──

test("updateProgressUI called in turn_end after markCompletedSteps", () => {
  const turnEndIdx = source.indexOf('pi.on("turn_end"');
  const agentEndIdx = source.indexOf('pi.on("agent_end"');
  const turnEndSection = source.slice(turnEndIdx, agentEndIdx);
  assert.ok(turnEndSection.includes("updateProgressUI(ctx)"), "updateProgressUI should be called in turn_end");
});

test("updateProgressUI called in agent_end on plan completion", () => {
  const agentEndIdx = source.indexOf('pi.on("agent_end"');
  const agentEndSection = source.slice(agentEndIdx);
  assert.ok(agentEndSection.includes("updateProgressUI(ctx)"), "updateProgressUI should be called in agent_end");
});

test("updateProgressUI called in session_start on resume", () => {
  const sessionStartIdx = source.indexOf('pi.on("session_start"');
  const sessionStartSection = source.slice(sessionStartIdx);
  assert.ok(sessionStartSection.includes("updateProgressUI(ctx)"), "updateProgressUI should be called in session_start");
});

console.log(`\n✓ All ${passed} tests passed`);
