// Regression test: the footer's right-aligned model label must include the
// model provider next to the model id (`model [provider] • thinking`), keeping
// pi's own model selection list format (`deepseek-flash [deepseek] · default`)
// so sessions that switch between providers stay identifiable at a glance.
//
// Run from a checkout where @earendil-works/* resolves (node >= 22):
//   node --experimental-transform-types tests/footer-model-display.test.ts
import { renderModelDisplay } from "../extensions/wow-tui/footer.ts";
import { DEFAULT_WOW_THEME_FALLBACKS } from "../extensions/wow-tui/palette.ts";

// The fallback theme keeps text untouched so assertions compare plain strings.
const theme: any = { fg: (_name: string, text: string) => text };

let failures = 0;
function check(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) return;
  failures++;
  console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

check(
  renderModelDisplay(theme, { provider: "deepseek", id: "deepseek-flash" }, "max"),
  "deepseek-flash [deepseek] • max",
  "model with provider badge and thinking level",
);
check(
  renderModelDisplay(theme, { provider: "zai", id: "glm-5.2" }, undefined),
  "glm-5.2 [zai]",
  "model with provider badge without thinking level",
);
check(
  renderModelDisplay(theme, { provider: "zai", id: "glm-5.2" }, "off"),
  "glm-5.2 [zai]",
  "thinking off stays hidden",
);
check(
  renderModelDisplay(theme, { id: "glm-5.2" }, "high"),
  "glm-5.2 • high",
  "missing provider falls back to the bare model id",
);
check(renderModelDisplay(theme, undefined, "high"), "no-model • high", "missing model falls back to no-model");
check(renderModelDisplay(theme, {}, undefined), "no-model", "empty model info falls back to no-model");

// The provider label is themeable through the Wow theme vars contract.
check(
  Object.prototype.hasOwnProperty.call(DEFAULT_WOW_THEME_FALLBACKS, "footer.provider"),
  true,
  "footer.provider is a supported Wow theme token",
);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("OK: footer model label matches pi's model list format (model [provider] • thinking)");
