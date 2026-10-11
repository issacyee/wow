// Regression tests for the discuss-mode interview prompt after adopting the
// grilling discipline (frontier/rounds, visible recommendations, verifiable
// completion criterion, anti-passivity, ungrillable escape hatch, scope guard).
//
// The prompt is a static constant string: it must stay byte-stable across calls
// and free of dynamic data so the provider prefix cache keeps hitting.
//
// Run from a checkout where dependencies resolve (node >= 22):
//   node --experimental-transform-types tests/discuss-prompt-invariants.test.ts
import { buildDiscussPrompt } from "../extensions/human-led-coding-workflow/prompts.ts";

let failures = 0;
function check(condition: unknown, label: string): void {
  if (condition) return;
  failures++;
  console.error(`FAIL: ${label}`);
}

const prompt = buildDiscussPrompt();

// ── Interview discipline ──

for (const [needle, label] of [
  ["design tree", "models the subject as a design tree"],
  ["frontier", "names the frontier concept"],
  ["rounds", "works in rounds"],
  ["recompute the frontier", "recomputes the frontier after each round"],
  ["wait for the human's answers", "waits for answers before the next round"],
  ["must not depend on each other", "keeps questions within a round independent"],
] as const) {
  check(prompt.includes(needle), `discuss prompt: ${label} ("${needle}")`);
}

// ── Visible recommendations ──

check(prompt.includes("➡️"), "discuss prompt: requires a visible ➡️ recommendation");
check(/answering "yes" accepts your recommendation/.test(prompt), 'discuss prompt: words questions so "yes" accepts the recommendation');
check(/same choices and the same recommendation as the hidden JSON/.test(prompt), "discuss prompt: visible questions must match the hidden JSON");
check(/must match the visible `➡️` recommendation/.test(prompt), "discuss prompt: JSON default must match the visible recommendation");
check(/`text` questions may state a visible `➡️` recommendation but must not define `default`/.test(prompt), "discuss prompt: text questions recommend without a default");

// The old rule forbade marking the recommendation in visible text; it must be gone.
check(!/Do not mark the recommended\/default option in visible text/.test(prompt), "old invisible-recommendation rule is removed");

// ── Verifiable completion criterion ──

check(/frontier is empty/.test(prompt), "discuss prompt: completion is defined by an empty frontier");
check(/nothing is left as a silent assumption/.test(prompt), "discuss prompt: completion forbids silent assumptions");
check(/wait for the human to confirm it/.test(prompt), "discuss prompt: requires human confirmation of shared understanding");
check(!prompt.includes("95%"), "discuss prompt: unverifiable 95% confidence criterion is removed");

// ── Anti-passivity and escape hatches ──

check(/unconditional agreement is a weak round/.test(prompt), "discuss prompt: names unconditional agreement as a weak round");
check(/human owns the scope/.test(prompt), "discuss prompt: keeps scope with the human");
check(/"I don't know" is a valid answer/.test(prompt), "discuss prompt: accepts I-don't-know answers");
check(/throwaway prototype/.test(prompt), "discuss prompt: offers a prototype escape hatch for ungrillable questions");
check(/scope is probably too large/.test(prompt), "discuss prompt: guards against runaway scope");
check(/Do not block a whole round on missing facts/.test(prompt), "discuss prompt: missing facts do not stall the whole round");

// ── Prefix-cache safety: static, byte-stable, no dynamic data ──

check(buildDiscussPrompt() === prompt, "discuss prompt: byte-stable across calls");
check(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(prompt), "discuss prompt: contains no ISO timestamp");
check(!/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}\b/.test(prompt), "discuss prompt: contains no UUID");
check(prompt.startsWith("[HLCW:DISCUSS]"), "discuss prompt: keeps its stable mode header");

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("OK: discuss prompt carries the grilling interview discipline and stays byte-stable");
