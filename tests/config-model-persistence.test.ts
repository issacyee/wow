// Regression test: /config:global model and thinking selections must persist to
// the global settings.json so new pi sessions resolve them at startup. The
// extension `pi.setModel`/`pi.setThinkingLevel` APIs only affect the running
// session, so the config UI has to write the settings file itself.
//
// Also covers: global scope must not persist a model that has no auth, project
// scope writes project overrides without touching global defaults, and
// unrelated settings keys survive both writes.
//
// Run from a checkout where @earendil-works/* resolves (node >= 22):
//   node --experimental-transform-types tests/config-model-persistence.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "wow-config-model-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(cwd, ".pi"), { recursive: true });

const globalPath = join(agentDir, "settings.json");
const projectPath = join(cwd, ".pi", "settings.json");

writeFileSync(
  globalPath,
  `${JSON.stringify({ defaultProvider: "zai", defaultModel: "glm-5.2", theme: "Viego" }, null, 2)}\n`,
  "utf-8",
);

// The config UI resolves the global settings path through pi's getAgentDir().
process.env.PI_CODING_AGENT_DIR = agentDir;

const { applyModel, applyThinking } = await import("../extensions/wow-tui/config-ui.ts");

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function fakePi(hasAuth = true): any {
  return {
    setModel: async () => hasAuth,
    setThinkingLevel: () => {},
  };
}

function fakeContext(trusted = true): any {
  return {
    cwd,
    hasUI: false,
    ui: { notify: () => {} },
    isProjectTrusted: () => trusted,
    modelRegistry: { find: () => undefined, refresh: () => {} },
  };
}

function model(provider: string, id: string): any {
  return { provider, id };
}

let failures = 0;
function check(condition: unknown, message: string): void {
  if (condition) return;
  failures++;
  console.error(`FAIL: ${message}`);
}

// 1. Global model selection persists to the global settings file.
await applyModel("global", fakePi(), fakeContext(), model("deepseek", "deepseek-flash"));
let global = readJson(globalPath);
check(
  global.defaultProvider === "deepseek" && global.defaultModel === "deepseek-flash",
  `global default model not persisted: ${JSON.stringify(global)}`,
);
check(global.theme === "Viego", "unrelated global settings must be preserved");

// 2. Global model selection without auth must not become the default.
await applyModel("global", fakePi(false), fakeContext(), model("openai", "gpt-5"));
global = readJson(globalPath);
check(
  global.defaultProvider === "deepseek" && global.defaultModel === "deepseek-flash",
  `missing-auth model must not be persisted: ${JSON.stringify(global)}`,
);

// 3. Global thinking selection persists to the global settings file.
await applyThinking("global", fakePi(), fakeContext(), "high");
global = readJson(globalPath);
check(global.defaultThinkingLevel === "high", `global thinking level not persisted: ${JSON.stringify(global)}`);

// 4. Project selections write project overrides and leave global defaults alone.
await applyModel("project", fakePi(), fakeContext(), model("anthropic", "claude-sonnet-4-5"));
await applyThinking("project", fakePi(), fakeContext(), "low");
const project = readJson(projectPath);
check(
  project.defaultProvider === "anthropic" && project.defaultModel === "claude-sonnet-4-5",
  `project model override not persisted: ${JSON.stringify(project)}`,
);
check(project.defaultThinkingLevel === "low", `project thinking override not persisted: ${JSON.stringify(project)}`);
global = readJson(globalPath);
check(
  global.defaultProvider === "deepseek" && global.defaultModel === "deepseek-flash",
  `project writes must not touch the global default model: ${JSON.stringify(global)}`,
);
check(
  global.defaultThinkingLevel === "high",
  `project writes must not touch the global thinking level: ${JSON.stringify(global)}`,
);

rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("OK: config model/thinking persistence scoped and applied correctly");
