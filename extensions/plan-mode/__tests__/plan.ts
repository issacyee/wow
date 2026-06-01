/**
 * Test suite for plan.ts — plan item extraction and progress tracking
 * Run: npx tsx extensions/plan-mode/__tests__/plan.ts
 */

import assert from "node:assert/strict";
import {
  cleanStepText,
  extractPlanItems,
  extractDoneSteps,
  markCompletedSteps,
  hasReadyMarker,
  detectPrimaryLocale,
  ACTION_MARKER,
  type TodoItem,
} from "../plan.ts";

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

// ── cleanStepText — truncation threshold ──

test("text under 80 chars is not truncated", () => {
  const text = "A".repeat(79);
  const result = cleanStepText(text);
  assert.equal(result.length, 79);
});

test("text at exactly 80 chars is not truncated", () => {
  const text = "A".repeat(80);
  const result = cleanStepText(text);
  assert.equal(result.length, 80);
});

test("text over 80 chars is truncated to 80 with ellipsis (77 + ...)", () => {
  const text = "A".repeat(100);
  const result = cleanStepText(text);
  assert.equal(result.length, 80);
  assert.ok(result.endsWith("..."));
});

test("text over old threshold of 55 is NOT truncated anymore", () => {
  const text = "A".repeat(60);
  const result = cleanStepText(text);
  assert.equal(result.length, 60);
});

// ── cleanStepText — markdown stripping ──

test("bold markdown is stripped", () => {
  const result = cleanStepText("**Action** description");
  assert.ok(!result.includes("**"));
  assert.ok(result.includes("Action"));
});

test("code backticks are stripped", () => {
  const result = cleanStepText("Edit `file.ts` module");
  assert.ok(!result.includes("`"));
});

test("em-dash is stripped", () => {
  const result = cleanStepText("— description text");
  assert.ok(!result.startsWith("—"));
  assert.ok(result.startsWith("D"));
});

// ── cleanStepText — locale prefix stripping ──

test("capitalizes first letter", () => {
  const result = cleanStepText("update the config file");
  // "Update the " is stripped by the verb-removal regex, leaving "config file" → "Config file"
  assert.ok(result.startsWith("C"));
});

test("capitalizes first letter (no verb prefix)", () => {
  const result = cleanStepText("refactor the module");
  assert.ok(result.startsWith("R"));
});

// ── extractPlanItems — relaxed length threshold ──

test("short text (3 chars) is extracted (was blocked before)", () => {
  const message = `Ready to go?\n1. Add foo\n`;
  const items = extractPlanItems(message);
  assert.ok(items.length >= 1);
  // "Add foo" = 7 chars, cleaned may be shorter but should still be extracted
});

test("text starting with backtick is NOT blocked (was blocked before)", () => {
  const message = `Ready to go?\n1. \`path/to/file\` update config\n2. Edit module\n`;
  const items = extractPlanItems(message);
  assert.ok(items.length >= 1, `Expected >= 1 items, got ${items.length}`);
});

test("text starting with dash is NOT blocked (was blocked before)", () => {
  const message = `Ready to go?\n1. - Remove old code\n2. Fix bug\n`;
  const items = extractPlanItems(message);
  assert.ok(items.length >= 1, `Expected >= 1 items, got ${items.length}`);
});

test("text starting with / IS still blocked (slash commands)", () => {
  const message = `Ready to go?\n1. /quit this thing\n2. Real step here\n`;
  const items = extractPlanItems(message);
  // First item should be skipped, second should be extracted
  assert.ok(items.length === 1, `Expected 1 item, got ${items.length}`);
  assert.ok(items[0].text.includes("Real step"));
});

test("normal plan extraction works", () => {
  const message = `Ready to go?\n1. Read the config file\n2. Update the module\n3. Run tests\n`;
  const items = extractPlanItems(message);
  assert.equal(items.length, 3);
  assert.equal(items[0].step, 1);
  assert.equal(items[1].step, 2);
  assert.equal(items[2].step, 3);
  assert.ok(!items[0].completed);
  assert.ok(!items[1].completed);
  assert.ok(!items[2].completed);
});

test("plan with parenthesized numbers works", () => {
  const message = `Ready to go?\n1) First step\n2) Second step\n`;
  const items = extractPlanItems(message);
  assert.equal(items.length, 2);
});

// ── extractPlanItems — fallback to ## header ──

test("falls back to ## header without Ready to go? marker", () => {
  const message = `## 计划: Test\n1. Do thing one\n2. Do thing two\n---\nSome other content`;
  const items = extractPlanItems(message);
  assert.ok(items.length >= 1, `Expected >= 1 items, got ${items.length}`);
});

// ── hasReadyMarker ──

test("detects Ready to go? marker", () => {
  assert.ok(hasReadyMarker("Some text\n\nReady to go?"));
});

test("detects marker case-insensitively", () => {
  assert.ok(hasReadyMarker("ready to Go?"));
});

test("no marker returns false", () => {
  assert.ok(!hasReadyMarker("Some text without marker"));
});

// ── ACTION_MARKER constant ──

test("ACTION_MARKER is 'Ready to go?'", () => {
  assert.equal(ACTION_MARKER, "Ready to go?");
});

// ── extractDoneSteps ──

test("extracts single [DONE:1]", () => {
  const steps = extractDoneSteps("Completed step 1. [DONE:1]");
  assert.deepEqual(steps, [1]);
});

test("extracts multiple [DONE:n] markers", () => {
  const steps = extractDoneSteps("Done with 1 [DONE:1] and 3 [DONE:3]");
  assert.deepEqual(steps, [1, 3]);
});

test("extracts markers case-insensitively", () => {
  const steps = extractDoneSteps("[done:2] and [DONE:4]");
  assert.deepEqual(steps, [2, 4]);
});

test("returns empty array for no markers", () => {
  const steps = extractDoneSteps("No markers here");
  assert.deepEqual(steps, []);
});

// ── markCompletedSteps ──

test("marks completed steps", () => {
  const items: TodoItem[] = [
    { step: 1, text: "First", completed: false },
    { step: 2, text: "Second", completed: false },
    { step: 3, text: "Third", completed: false },
  ];
  const count = markCompletedSteps("Done [DONE:1] and [DONE:3]", items);
  assert.equal(count, 2);
  assert.ok(items[0].completed);
  assert.ok(!items[1].completed);
  assert.ok(items[2].completed);
});

test("does not double-count already completed steps", () => {
  const items: TodoItem[] = [
    { step: 1, text: "First", completed: true },
  ];
  const count = markCompletedSteps("[DONE:1]", items);
  assert.equal(count, 0);
});

test("returns 0 for no matching steps", () => {
  const items: TodoItem[] = [
    { step: 1, text: "First", completed: false },
  ];
  const count = markCompletedSteps("[DONE:5]", items);
  assert.equal(count, 0);
});

// ── detectPrimaryLocale ──

test("returns a non-empty string", () => {
  const locale = detectPrimaryLocale();
  assert.ok(locale.length > 0);
});

console.log(`\n✓ All ${passed} tests passed`);
