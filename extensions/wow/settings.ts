/**
 * Shared settings.json reader for Wow extensions.
 *
 * Reads raw pi settings.json values (outside the framework SettingsManager)
 * with project-then-global resolution, so logic extensions can read custom
 * Wow keys without importing TUI code.
 *
 * Path rules mirror `wow-tui/config-ui.ts`:
 *   - global:  getAgentDir()/settings.json
 *   - project: cwd/.pi/settings.json
 *
 * Resolution: project overrides global. Missing or malformed files yield
 * `undefined`; this layer never throws, to protect the LLM flow.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Path helpers (must match wow-tui/config-ui.ts) ──

function globalSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

function readJsonFile(path: string): Record<string, any> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const content = readFileSync(path, "utf-8").trim();
    if (!content) return undefined;
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, any>;
  } catch {
    return undefined;
  }
}

function getPathValue(obj: Record<string, any> | undefined, path: string[]): any {
  let target: any = obj;
  for (const key of path) {
    if (target === null || typeof target !== "object" || Array.isArray(target)) return undefined;
    target = target[key];
  }
  return target;
}

/**
 * Read a Wow setting by dotted path, resolving project scope first then global.
 * Returns `undefined` when unset in both scopes or when files are missing/malformed.
 */
export function readWowSetting(path: string[], options?: { cwd?: string }): unknown {
  const cwd = options?.cwd ?? process.cwd();
  const project = readJsonFile(projectSettingsPath(cwd));
  if (project !== undefined) {
    const projectValue = getPathValue(project, path);
    if (projectValue !== undefined) return projectValue;
  }
  const global = readJsonFile(globalSettingsPath());
  if (global !== undefined) {
    const globalValue = getPathValue(global, path);
    if (globalValue !== undefined) return globalValue;
  }
  return undefined;
}
