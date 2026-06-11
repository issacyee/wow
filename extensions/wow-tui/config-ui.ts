/**
 * Interactive configuration UI for global and project-level pi settings.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  getAgentDir,
  getSettingsListTheme,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
  type Component,
} from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────

type ConfigScope = "global" | "project";
type JsonObject = Record<string, any>;
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type TransportSetting = "auto" | "sse" | "websocket" | "websocket-cached";
type ResourceField = "extensions" | "skills" | "prompts" | "themes" | "packages";
type ResourceAction = "add" | "remove" | "clear" | "list" | "back";
type MainAction = "model" | "thinking" | "common" | "resources" | "reload" | "exit";

interface SettingOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
}

interface GlobalDefaultSnapshot {
  defaultProvider: string | undefined;
  hasDefaultProvider: boolean;
  defaultModel: string | undefined;
  hasDefaultModel: boolean;
  defaultThinkingLevel: ThinkingLevel | undefined;
  hasDefaultThinkingLevel: boolean;
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TRANSPORTS: TransportSetting[] = ["auto", "sse", "websocket", "websocket-cached"];
const QUEUE_MODES = ["one-at-a-time", "all"] as const;
const DEFAULT_PROJECT_TRUST_VALUES = ["ask", "always", "never"] as const;
const DOUBLE_ESCAPE_ACTIONS = ["tree", "fork", "none"] as const;
const TREE_FILTER_MODES = ["default", "no-tools", "user-only", "labeled-only", "all"] as const;
const RESOURCE_FIELDS: ResourceField[] = ["extensions", "skills", "prompts", "themes", "packages"];
const GLOBAL_WRITE_SETTLE_MS = 120;
const GLOBAL_WRITE_TIMEOUT_MS = 1000;

// ── Settings file helpers ────────────────────────────────────────────────

function settingsPath(scope: ConfigScope, cwd: string): string {
  return scope === "global"
    ? join(getAgentDir(), "settings.json")
    : join(cwd, ".pi", "settings.json");
}

function readJsonFile(path: string): JsonObject {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return {};
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as JsonObject;
}

function writeJsonFile(path: string, value: JsonObject): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readSettings(scope: ConfigScope, cwd: string): JsonObject {
  return readJsonFile(settingsPath(scope, cwd));
}

function writeSettings(scope: ConfigScope, cwd: string, value: JsonObject): void {
  writeJsonFile(settingsPath(scope, cwd), value);
}

function updateSettings(scope: ConfigScope, cwd: string, update: (settings: JsonObject) => void): JsonObject {
  const settings = readSettings(scope, cwd);
  update(settings);
  writeSettings(scope, cwd, settings);
  return settings;
}

function setPathValue(settings: JsonObject, path: string[], value: any): void {
  let target = settings;
  for (const key of path.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
      target[key] = {};
    }
    target = target[key];
  }
  const last = path[path.length - 1]!;
  if (value === undefined) {
    delete target[last];
  } else {
    target[last] = value;
  }
}

function setScopedValue(scope: ConfigScope, cwd: string, path: string[], value: any): void {
  updateSettings(scope, cwd, (settings) => setPathValue(settings, path, value));
}

function snapshotGlobalDefaults(cwd: string): GlobalDefaultSnapshot {
  const global = readSettings("global", cwd);
  return {
    defaultProvider: typeof global.defaultProvider === "string" ? global.defaultProvider : undefined,
    hasDefaultProvider: Object.prototype.hasOwnProperty.call(global, "defaultProvider"),
    defaultModel: typeof global.defaultModel === "string" ? global.defaultModel : undefined,
    hasDefaultModel: Object.prototype.hasOwnProperty.call(global, "defaultModel"),
    defaultThinkingLevel: THINKING_LEVELS.includes(global.defaultThinkingLevel) ? global.defaultThinkingLevel : undefined,
    hasDefaultThinkingLevel: Object.prototype.hasOwnProperty.call(global, "defaultThinkingLevel"),
  };
}

function restoreGlobalDefaults(cwd: string, snapshot: GlobalDefaultSnapshot): void {
  updateSettings("global", cwd, (settings) => {
    if (snapshot.hasDefaultProvider) settings.defaultProvider = snapshot.defaultProvider;
    else delete settings.defaultProvider;

    if (snapshot.hasDefaultModel) settings.defaultModel = snapshot.defaultModel;
    else delete settings.defaultModel;

    if (snapshot.hasDefaultThinkingLevel) settings.defaultThinkingLevel = snapshot.defaultThinkingLevel;
    else delete settings.defaultThinkingLevel;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGlobalWrite(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < GLOBAL_WRITE_TIMEOUT_MS) {
    if (predicate()) return;
    await sleep(50);
  }
}

async function restoreGlobalDefaultsAfterSideEffect(
  cwd: string,
  snapshot: GlobalDefaultSnapshot,
  predicate: () => boolean,
): Promise<void> {
  await waitForGlobalWrite(predicate);
  restoreGlobalDefaults(cwd, snapshot);
  await sleep(GLOBAL_WRITE_SETTLE_MS);
  restoreGlobalDefaults(cwd, snapshot);
  setTimeout(() => {
    try {
      restoreGlobalDefaults(cwd, snapshot);
    } catch {
      // Best-effort race guard for pi's async global write side effect.
    }
  }, GLOBAL_WRITE_SETTLE_MS * 4);
}

function stringifyValue(value: any): string {
  if (value === undefined) return "(unset)";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.length}] ${value.join(", ")}`;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

function settingLabel(scope: ConfigScope): string {
  return scope === "global" ? "Global" : "Project";
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else console.log(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureProjectWritable(ctx: ExtensionCommandContext): boolean {
  if (ctx.isProjectTrusted()) return true;
  notify(ctx, "Project is not trusted. Run /trust, restart pi, then use /config:project again.", "error");
  return false;
}

function currentScopedSettings(scope: ConfigScope, ctx: ExtensionCommandContext): JsonObject {
  return readSettings(scope, ctx.cwd);
}

// ── Reusable UI components ───────────────────────────────────────────────

function createSelectTheme(theme: any) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

class SearchableSelect implements Component {
  private container = new Container();
  private search = "";
  private list: SelectList;

  constructor(
    private title: string,
    private items: SelectItem[],
    private theme: any,
    private done: (value: string | null) => void,
  ) {
    this.list = this.createList(this.items);
    this.rebuild();
  }

  private createList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), createSelectTheme(this.theme), {
      minPrimaryColumnWidth: 28,
      maxPrimaryColumnWidth: 56,
    });
    list.onSelect = (item) => this.done(item.value);
    list.onCancel = () => this.done(null);
    return list;
  }

  private applySearch(): void {
    const query = this.search.trim();
    const filtered = query
      ? fuzzyFilter(this.items, query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`)
      : this.items;
    this.list = this.createList(filtered);
  }

  private rebuild(): void {
    this.container.clear();
    this.container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
    this.container.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.title)), 1, 0));
    this.container.addChild(new Text(this.theme.fg("dim", `Search: ${this.search || "(type to filter)"}`), 1, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.list);
    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(this.theme.fg("dim", "Type to filter • Backspace delete • Enter select • Esc cancel"), 1, 0));
    this.container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.backspace)) {
      this.search = this.search.slice(0, -1);
      this.applySearch();
      this.rebuild();
      return;
    }

    if (matchesKey(data, Key.delete)) {
      this.search = "";
      this.applySearch();
      this.rebuild();
      return;
    }

    if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.search += data;
      this.applySearch();
      this.rebuild();
      return;
    }

    this.list.handleInput(data);
  }
}

class InlineInputDialog implements Component, Focusable {
  private container = new Container();
  private input = new Input();
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    private title: string,
    prefill: string,
    private theme: any,
    private done: (value: string | undefined) => void,
  ) {
    this.input.setValue(prefill);
    this.input.onSubmit = (value) => this.done(value);
    this.input.onEscape = () => this.done(undefined);
    this.rebuild();
  }

  private rebuild(): void {
    this.container.clear();
    this.container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
    this.container.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.title)), 1, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.input);
    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(this.theme.fg("dim", "Enter save • Esc cancel"), 1, 0));
    this.container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }
}

async function selectItem(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
): Promise<string | undefined> {
  if (items.length === 0) return undefined;

  if (ctx.mode !== "tui") {
    const selected = await ctx.ui.select(title, items.map((item) => item.label));
    return items.find((item) => item.label === selected)?.value;
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const component = new SearchableSelect(title, items, theme, done);
    return {
      render: (width: number) => component.render(width),
      invalidate: () => component.invalidate(),
      handleInput: (data: string) => {
        component.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return result ?? undefined;
}

async function selectOption<T extends string>(
  ctx: ExtensionCommandContext,
  title: string,
  options: SettingOption<T>[],
): Promise<T | undefined> {
  const selected = await selectItem(ctx, title, options.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  })));
  return selected as T | undefined;
}

async function showSettingsScreen(
  ctx: ExtensionCommandContext,
  title: string,
  items: SettingItem[],
  onChange: (id: string, newValue: string, list: SettingsList) => void | Promise<void>,
): Promise<void> {
  if (ctx.mode !== "tui") {
    notify(ctx, `${title} requires TUI mode`, "error");
    return;
  }

  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Spacer(1));

    const settingsList = new SettingsList(
      items,
      Math.min(Math.max(items.length, 1), 12),
      getSettingsListTheme(),
      (id, newValue) => {
        void onChange(id, newValue, settingsList);
      },
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(settingsList);
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

// ── Model / thinking ────────────────────────────────────────────────────

function modelLabel(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

async function selectModel(ctx: ExtensionCommandContext): Promise<Model<any> | undefined> {
  ctx.modelRegistry.refresh();
  const models = ctx.modelRegistry.getAvailable();
  if (models.length === 0) {
    notify(ctx, "No authenticated models available. Use /login first.", "warning");
    return undefined;
  }

  const sorted = [...models].sort((a, b) => modelLabel(a).localeCompare(modelLabel(b)));
  const selected = await selectItem(ctx, "Select Model", sorted.map((model) => ({
    value: modelLabel(model),
    label: model.id,
    description: `${model.provider}${model.name && model.name !== model.id ? ` · ${model.name}` : ""}`,
  })));
  if (!selected) return undefined;

  const slash = selected.indexOf("/");
  const provider = selected.slice(0, slash);
  const id = selected.slice(slash + 1);
  return ctx.modelRegistry.find(provider, id);
}

async function applyModel(scope: ConfigScope, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return;

  const model = await selectModel(ctx);
  if (!model) return;

  if (scope === "global") {
    const ok = await pi.setModel(model);
    if (!ok) {
      notify(ctx, `No configured auth for ${modelLabel(model)}`, "error");
      return;
    }
    notify(ctx, `Global default model set to ${modelLabel(model)}`, "info");
    return;
  }

  const snapshot = snapshotGlobalDefaults(ctx.cwd);
  setScopedValue("project", ctx.cwd, ["defaultProvider"], model.provider);
  setScopedValue("project", ctx.cwd, ["defaultModel"], model.id);

  const ok = await pi.setModel(model);
  await restoreGlobalDefaultsAfterSideEffect(ctx.cwd, snapshot, () => {
    const global = readSettings("global", ctx.cwd);
    return global.defaultProvider === model.provider && global.defaultModel === model.id;
  });

  if (!ok) {
    notify(ctx, `Saved project model, but current session could not switch: missing auth for ${modelLabel(model)}`, "warning");
    return;
  }
  notify(ctx, `Project default model set to ${modelLabel(model)} and applied now`, "info");
}

async function applyThinking(scope: ConfigScope, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return;

  const current = pi.getThinkingLevel();
  const level = await selectOption(ctx, "Select Thinking Level", THINKING_LEVELS.map((value) => ({
    value,
    label: value === current ? `${value} (current)` : value,
  })));
  if (!level) return;

  if (scope === "global") {
    pi.setThinkingLevel(level);
    notify(ctx, `Global default thinking level set to ${level}`, "info");
    return;
  }

  const snapshot = snapshotGlobalDefaults(ctx.cwd);
  setScopedValue("project", ctx.cwd, ["defaultThinkingLevel"], level);
  pi.setThinkingLevel(level);
  await sleep(GLOBAL_WRITE_SETTLE_MS);
  restoreGlobalDefaults(ctx.cwd, snapshot);
  setTimeout(() => {
    try {
      restoreGlobalDefaults(ctx.cwd, snapshot);
    } catch {
      // Best-effort race guard for pi's async global write side effect.
    }
  }, GLOBAL_WRITE_SETTLE_MS * 4);
  notify(ctx, `Project default thinking level set to ${level} and applied now`, "info");
}

// ── Common settings ─────────────────────────────────────────────────────

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numericValue(value: unknown, fallback: number): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : String(fallback);
}

function commonItems(scope: ConfigScope, ctx: ExtensionCommandContext): SettingItem[] {
  const settings = currentScopedSettings(scope, ctx);
  const effectiveManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: scope === "project" && ctx.isProjectTrusted(),
  });
  const retrySettings = effectiveManager.getRetrySettings();
  const providerRetrySettings = effectiveManager.getProviderRetrySettings();
  const compactionSettings = effectiveManager.getCompactionSettings();
  const branchSummarySettings = effectiveManager.getBranchSummarySettings();

  const items: SettingItem[] = [
    {
      id: "theme",
      label: "Theme",
      description: "Theme name. Built-ins include dark and light; custom themes may also be available.",
      currentValue: stringifyValue(settings.theme ?? effectiveManager.getTheme()),
      submenu: (_current, done) => {
        const themes = ctx.ui.getAllThemes().map((theme) => ({
          value: theme.name,
          label: theme.name,
          description: theme.path ?? "built-in",
        }));
        return selectSubmenu("Select Theme", themes, done, ctx.ui.theme);
      },
    },
    {
      id: "transport",
      label: "Transport",
      description: "Preferred provider transport.",
      currentValue: String(settings.transport ?? effectiveManager.getTransport()),
      values: [...TRANSPORTS],
    },
    {
      id: "steeringMode",
      label: "Steering mode",
      description: "How queued steering messages are delivered while the agent is streaming.",
      currentValue: String(settings.steeringMode ?? effectiveManager.getSteeringMode()),
      values: [...QUEUE_MODES],
    },
    {
      id: "followUpMode",
      label: "Follow-up mode",
      description: "How queued follow-up messages are delivered after the agent stops.",
      currentValue: String(settings.followUpMode ?? effectiveManager.getFollowUpMode()),
      values: [...QUEUE_MODES],
    },
    {
      id: "hideThinkingBlock",
      label: "Hide thinking",
      description: "Hide thinking blocks in assistant output.",
      currentValue: String(settings.hideThinkingBlock ?? effectiveManager.getHideThinkingBlock()),
      values: ["true", "false"],
    },
    {
      id: "quietStartup",
      label: "Quiet startup",
      description: "Hide verbose startup resource listing.",
      currentValue: String(settings.quietStartup ?? effectiveManager.getQuietStartup()),
      values: ["true", "false"],
    },
    {
      id: "collapseChangelog",
      label: "Collapse changelog",
      description: "Show condensed changelog after updates.",
      currentValue: String(settings.collapseChangelog ?? effectiveManager.getCollapseChangelog()),
      values: ["true", "false"],
    },
    {
      id: "enableInstallTelemetry",
      label: "Install telemetry",
      description: "Send anonymous install/update telemetry. Global setting only.",
      currentValue: String(settings.enableInstallTelemetry ?? effectiveManager.getEnableInstallTelemetry()),
      values: ["true", "false"],
    },
    {
      id: "defaultProjectTrust",
      label: "Default project trust",
      description: "Fallback trust behavior when no saved trust decision exists. Global setting only.",
      currentValue: String(settings.defaultProjectTrust ?? effectiveManager.getDefaultProjectTrust()),
      values: [...DEFAULT_PROJECT_TRUST_VALUES],
    },
    {
      id: "doubleEscapeAction",
      label: "Double escape",
      description: "Action for pressing Escape twice with empty editor.",
      currentValue: String(settings.doubleEscapeAction ?? effectiveManager.getDoubleEscapeAction()),
      values: [...DOUBLE_ESCAPE_ACTIONS],
    },
    {
      id: "treeFilterMode",
      label: "Tree filter",
      description: "Default filter mode for /tree.",
      currentValue: String(settings.treeFilterMode ?? effectiveManager.getTreeFilterMode()),
      values: [...TREE_FILTER_MODES],
    },
    {
      id: "compaction.enabled",
      label: "Auto compact",
      description: "Automatically compact context when it gets too large.",
      currentValue: String(settings.compaction?.enabled ?? compactionSettings.enabled),
      values: ["true", "false"],
    },
    {
      id: "compaction.reserveTokens",
      label: "Compact reserve",
      description: "Tokens reserved for model response during compaction.",
      currentValue: numericValue(settings.compaction?.reserveTokens, compactionSettings.reserveTokens),
      submenu: (_current, done) => inputSubmenu("Compaction reserve tokens", numericValue(settings.compaction?.reserveTokens, compactionSettings.reserveTokens), done, ctx.ui.theme),
    },
    {
      id: "compaction.keepRecentTokens",
      label: "Compact recent",
      description: "Recent tokens kept unsummarized during compaction.",
      currentValue: numericValue(settings.compaction?.keepRecentTokens, compactionSettings.keepRecentTokens),
      submenu: (_current, done) => inputSubmenu("Compaction keep recent tokens", numericValue(settings.compaction?.keepRecentTokens, compactionSettings.keepRecentTokens), done, ctx.ui.theme),
    },
    {
      id: "branchSummary.reserveTokens",
      label: "Branch reserve",
      description: "Tokens reserved for branch summarization.",
      currentValue: numericValue(settings.branchSummary?.reserveTokens, branchSummarySettings.reserveTokens),
      submenu: (_current, done) => inputSubmenu("Branch summary reserve tokens", numericValue(settings.branchSummary?.reserveTokens, branchSummarySettings.reserveTokens), done, ctx.ui.theme),
    },
    {
      id: "branchSummary.skipPrompt",
      label: "Branch skip prompt",
      description: "Skip summarize-branch prompt on tree navigation.",
      currentValue: String(settings.branchSummary?.skipPrompt ?? branchSummarySettings.skipPrompt),
      values: ["true", "false"],
    },
    {
      id: "retry.enabled",
      label: "Retry enabled",
      description: "Enable automatic agent-level retry on transient errors.",
      currentValue: String(settings.retry?.enabled ?? retrySettings.enabled),
      values: ["true", "false"],
    },
    {
      id: "retry.maxRetries",
      label: "Retry max",
      description: "Maximum agent-level retry attempts.",
      currentValue: numericValue(settings.retry?.maxRetries, retrySettings.maxRetries),
      submenu: (_current, done) => inputSubmenu("Retry max retries", numericValue(settings.retry?.maxRetries, retrySettings.maxRetries), done, ctx.ui.theme),
    },
    {
      id: "retry.baseDelayMs",
      label: "Retry delay",
      description: "Base delay in milliseconds for agent-level exponential backoff.",
      currentValue: numericValue(settings.retry?.baseDelayMs, retrySettings.baseDelayMs),
      submenu: (_current, done) => inputSubmenu("Retry base delay ms", numericValue(settings.retry?.baseDelayMs, retrySettings.baseDelayMs), done, ctx.ui.theme),
    },
    {
      id: "retry.provider.timeoutMs",
      label: "Provider timeout",
      description: "Provider request timeout in milliseconds. Empty clears override.",
      currentValue: stringifyValue(settings.retry?.provider?.timeoutMs ?? providerRetrySettings.timeoutMs),
      submenu: (_current, done) => inputSubmenu("Provider timeout ms", settings.retry?.provider?.timeoutMs === undefined ? "" : String(settings.retry.provider.timeoutMs), done, ctx.ui.theme),
    },
    {
      id: "retry.provider.maxRetries",
      label: "Provider retries",
      description: "Provider/SDK retry attempts. Empty clears override.",
      currentValue: stringifyValue(settings.retry?.provider?.maxRetries ?? providerRetrySettings.maxRetries),
      submenu: (_current, done) => inputSubmenu("Provider max retries", settings.retry?.provider?.maxRetries === undefined ? "" : String(settings.retry.provider.maxRetries), done, ctx.ui.theme),
    },
    {
      id: "retry.provider.maxRetryDelayMs",
      label: "Provider delay cap",
      description: "Max server-requested retry delay in milliseconds.",
      currentValue: numericValue(settings.retry?.provider?.maxRetryDelayMs, providerRetrySettings.maxRetryDelayMs),
      submenu: (_current, done) => inputSubmenu("Provider max retry delay ms", numericValue(settings.retry?.provider?.maxRetryDelayMs, providerRetrySettings.maxRetryDelayMs), done, ctx.ui.theme),
    },
    {
      id: "httpIdleTimeoutMs",
      label: "HTTP idle timeout",
      description: "HTTP header/body idle timeout in milliseconds. 0 disables.",
      currentValue: numericValue(settings.httpIdleTimeoutMs, effectiveManager.getHttpIdleTimeoutMs()),
      submenu: (_current, done) => inputSubmenu("HTTP idle timeout ms", numericValue(settings.httpIdleTimeoutMs, effectiveManager.getHttpIdleTimeoutMs()), done, ctx.ui.theme),
    },
    {
      id: "websocketConnectTimeoutMs",
      label: "WebSocket timeout",
      description: "WebSocket connect timeout in milliseconds. Empty clears override.",
      currentValue: stringifyValue(settings.websocketConnectTimeoutMs ?? effectiveManager.getWebSocketConnectTimeoutMs()),
      submenu: (_current, done) => inputSubmenu("WebSocket connect timeout ms", settings.websocketConnectTimeoutMs === undefined ? "" : String(settings.websocketConnectTimeoutMs), done, ctx.ui.theme),
    },
    {
      id: "terminal.showImages",
      label: "Show images",
      description: "Render images inline when terminal supports it.",
      currentValue: String(settings.terminal?.showImages ?? effectiveManager.getShowImages()),
      values: ["true", "false"],
    },
    {
      id: "terminal.imageWidthCells",
      label: "Image width",
      description: "Preferred inline image width in terminal cells.",
      currentValue: String(settings.terminal?.imageWidthCells ?? effectiveManager.getImageWidthCells()),
      values: ["60", "80", "120"],
    },
    {
      id: "terminal.clearOnShrink",
      label: "Clear on shrink",
      description: "Clear empty rows when rendered content shrinks.",
      currentValue: String(settings.terminal?.clearOnShrink ?? effectiveManager.getClearOnShrink()),
      values: ["true", "false"],
    },
    {
      id: "terminal.showTerminalProgress",
      label: "Terminal progress",
      description: "Show OSC 9;4 progress indicators in terminal tab bar.",
      currentValue: String(settings.terminal?.showTerminalProgress ?? effectiveManager.getShowTerminalProgress()),
      values: ["true", "false"],
    },
    {
      id: "images.autoResize",
      label: "Auto-resize images",
      description: "Resize large images before sending to providers.",
      currentValue: String(settings.images?.autoResize ?? effectiveManager.getImageAutoResize()),
      values: ["true", "false"],
    },
    {
      id: "images.blockImages",
      label: "Block images",
      description: "Prevent images from being sent to providers.",
      currentValue: String(settings.images?.blockImages ?? effectiveManager.getBlockImages()),
      values: ["true", "false"],
    },
    {
      id: "showHardwareCursor",
      label: "Hardware cursor",
      description: "Show terminal hardware cursor for IME positioning.",
      currentValue: String(settings.showHardwareCursor ?? effectiveManager.getShowHardwareCursor()),
      values: ["true", "false"],
    },
    {
      id: "editorPaddingX",
      label: "Editor padding",
      description: "Horizontal editor padding, 0-3.",
      currentValue: numericValue(settings.editorPaddingX, effectiveManager.getEditorPaddingX()),
      values: ["0", "1", "2", "3"],
    },
    {
      id: "autocompleteMaxVisible",
      label: "Autocomplete max",
      description: "Max visible autocomplete items, 3-20.",
      currentValue: numericValue(settings.autocompleteMaxVisible, effectiveManager.getAutocompleteMaxVisible()),
      values: ["3", "5", "7", "10", "15", "20"],
    },
    {
      id: "enableSkillCommands",
      label: "Skill commands",
      description: "Register skills as /skill:name commands.",
      currentValue: String(settings.enableSkillCommands ?? effectiveManager.getEnableSkillCommands()),
      values: ["true", "false"],
    },
    {
      id: "warnings.anthropicExtraUsage",
      label: "Anthropic warning",
      description: "Warn when Anthropic subscription auth may use paid extra usage.",
      currentValue: String(settings.warnings?.anthropicExtraUsage ?? effectiveManager.getWarnings().anthropicExtraUsage ?? true),
      values: ["true", "false"],
    },
    {
      id: "shellPath",
      label: "Shell path",
      description: "Custom bash shell path. Empty clears override.",
      currentValue: stringifyValue(settings.shellPath ?? effectiveManager.getShellPath()),
      submenu: (_current, done) => inputSubmenu("Shell path", textValue(settings.shellPath, effectiveManager.getShellPath() ?? ""), done, ctx.ui.theme),
    },
    {
      id: "shellCommandPrefix",
      label: "Shell prefix",
      description: "Command prefix prepended to every bash command. Empty clears override.",
      currentValue: stringifyValue(settings.shellCommandPrefix ?? effectiveManager.getShellCommandPrefix()),
      submenu: (_current, done) => inputSubmenu("Shell command prefix", textValue(settings.shellCommandPrefix, effectiveManager.getShellCommandPrefix() ?? ""), done, ctx.ui.theme),
    },
    {
      id: "sessionDir",
      label: "Session dir",
      description: "Custom session directory. Empty clears override.",
      currentValue: stringifyValue(settings.sessionDir ?? effectiveManager.getSessionDir()),
      submenu: (_current, done) => inputSubmenu("Session directory", textValue(settings.sessionDir, effectiveManager.getSessionDir() ?? ""), done, ctx.ui.theme),
    },
    {
      id: "markdown.codeBlockIndent",
      label: "Code indent",
      description: "Indentation string for markdown code blocks.",
      currentValue: stringifyValue(settings.markdown?.codeBlockIndent ?? effectiveManager.getCodeBlockIndent()),
      submenu: (_current, done) => inputSubmenu("Markdown code block indent", textValue(settings.markdown?.codeBlockIndent, effectiveManager.getCodeBlockIndent()), done, ctx.ui.theme),
    },
    {
      id: "npmCommand",
      label: "NPM command",
      description: "Comma-separated argv used for package-manager operations. Empty clears override.",
      currentValue: stringifyValue(settings.npmCommand ?? effectiveManager.getNpmCommand()),
      submenu: (_current, done) => inputSubmenu("NPM command argv", arrayToText(settings.npmCommand ?? effectiveManager.getNpmCommand()), done, ctx.ui.theme),
    },
    {
      id: "enabledModels",
      label: "Enabled models",
      description: "Comma-separated model patterns for Ctrl+P cycling. Empty clears this scope's override.",
      currentValue: stringifyValue(settings.enabledModels),
      submenu: (_current, done) => inputSubmenu("Enabled model patterns", arrayToText(settings.enabledModels), done, ctx.ui.theme),
    },
  ];

  return scope === "global"
    ? items
    : items.filter((item) => !["enableInstallTelemetry", "defaultProjectTrust"].includes(item.id));
}

function selectSubmenu<T extends string>(
  title: string,
  options: SettingOption<T>[],
  done: (selectedValue?: string) => void,
  theme: any,
): Component {
  const component = new SearchableSelect(title, options.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  })), theme, (value) => done(value ?? undefined));
  return component;
}

function arrayToText(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => String(item)).join(", ") : "";
}

function parseDelimitedList(text: string | undefined): string[] | undefined {
  const items = (text ?? "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function inputSubmenu(
  title: string,
  prefill: string,
  done: (selectedValue?: string) => void,
  theme: any,
): Component {
  return new InlineInputDialog(title, prefill, theme, done);
}

function parseInteger(value: string, allowEmpty = false): number | undefined {
  const trimmed = value.trim();
  if (!trimmed && allowEmpty) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function parseOptionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? value : undefined;
}

function parseCommonValue(id: string, value: string): any {
  switch (id) {
    case "hideThinkingBlock":
    case "quietStartup":
    case "collapseChangelog":
    case "enableInstallTelemetry":
    case "branchSummary.skipPrompt":
    case "retry.enabled":
    case "terminal.showImages":
    case "terminal.clearOnShrink":
    case "terminal.showTerminalProgress":
    case "images.autoResize":
    case "images.blockImages":
    case "showHardwareCursor":
    case "enableSkillCommands":
    case "warnings.anthropicExtraUsage":
    case "compaction.enabled":
      return value === "true";

    case "compaction.reserveTokens":
    case "compaction.keepRecentTokens":
    case "branchSummary.reserveTokens":
    case "retry.maxRetries":
    case "retry.baseDelayMs":
    case "retry.provider.maxRetryDelayMs":
    case "httpIdleTimeoutMs":
    case "terminal.imageWidthCells":
    case "editorPaddingX":
    case "autocompleteMaxVisible":
      return parseInteger(value);

    case "retry.provider.timeoutMs":
    case "retry.provider.maxRetries":
    case "websocketConnectTimeoutMs":
      return parseInteger(value, true);

    case "shellPath":
    case "shellCommandPrefix":
    case "sessionDir":
    case "markdown.codeBlockIndent":
      return parseOptionalString(value);

    case "npmCommand":
    case "enabledModels":
      return parseDelimitedList(value);

    default:
      return value;
  }
}

async function showCommonSettings(scope: ConfigScope, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    notify(ctx, "Common settings UI requires TUI mode", "error");
    return;
  }
  if (scope === "project" && !ensureProjectWritable(ctx)) return;

  await showSettingsScreen(ctx, `${settingLabel(scope)} Common Settings`, commonItems(scope, ctx), async (id, newValue, list) => {
    const path = id.split(".");
    const parsed = parseCommonValue(id, newValue);
    setScopedValue(scope, ctx.cwd, path, parsed);
    list.updateValue(id, stringifyValue(parsed));

    if (id === "theme") {
      const result = ctx.ui.setTheme(newValue);
      if (!result.success) notify(ctx, result.error ?? `Failed to apply theme ${newValue}`, "warning");
    }
    if (id === "terminal.clearOnShrink") {
      notify(ctx, "clearOnShrink saved; it applies after reload or restart.", "info");
    }
    if (id === "showHardwareCursor") {
      notify(ctx, "showHardwareCursor saved; it applies after reload or restart.", "info");
    }

    if (id !== "theme") {
      notify(ctx, `${id} saved. Reload may be required for the current session to observe it.`, "info");
    }

  });
}

// ── Resource path/source manager ─────────────────────────────────────────

function resourceDescription(field: ResourceField): string {
  switch (field) {
    case "extensions": return "Extra extension files/directories/globs.";
    case "skills": return "Extra skill files/directories.";
    case "prompts": return "Extra prompt template files/directories.";
    case "themes": return "Extra theme JSON files/directories.";
    case "packages": return "Pi package sources such as npm:, git:, https:, ssh:, or local paths.";
  }
}

function getResourceEntries(scope: ConfigScope, ctx: ExtensionCommandContext, field: ResourceField): any[] {
  const value = readSettings(scope, ctx.cwd)[field];
  return Array.isArray(value) ? value : [];
}

function setResourceEntries(scope: ConfigScope, ctx: ExtensionCommandContext, field: ResourceField, entries: any[]): void {
  setScopedValue(scope, ctx.cwd, [field], entries.length > 0 ? entries : undefined);
}

function entryToLabel(entry: any): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.source === "string") return `${entry.source} ${JSON.stringify(entry)}`;
  return JSON.stringify(entry);
}

async function maybeReload(ctx: ExtensionCommandContext): Promise<boolean> {
  if (!ctx.hasUI) return false;
  const ok = await ctx.ui.confirm("Resources changed", "Reload extensions, skills, prompts, and themes now?");
  if (!ok) return false;
  await ctx.reload();
  return true;
}

async function showResourceField(scope: ConfigScope, ctx: ExtensionCommandContext, field: ResourceField): Promise<boolean> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return false;

  while (true) {
    const entries = getResourceEntries(scope, ctx, field);
    const selected = await selectOption<ResourceAction>(ctx, `${settingLabel(scope)} ${field}`, [
      { value: "add", label: "Add entry", description: resourceDescription(field) },
      { value: "remove", label: "Remove entry", description: entries.length > 0 ? `${entries.length} configured` : "No entries" },
      { value: "clear", label: "Clear entries", description: "Remove this field from settings" },
      { value: "list", label: "List entries", description: entries.length > 0 ? entries.map(entryToLabel).join(" | ") : "No entries" },
      { value: "back", label: "Back" },
    ]);

    if (!selected || selected === "back") return false;

    if (selected === "list") {
      notify(ctx, entries.length > 0 ? entries.map(entryToLabel).join("\n") : `No ${field} entries`, "info");
      continue;
    }

    if (selected === "add") {
      const input = await ctx.ui.input(`Add ${field} entry`, field === "packages" ? "npm:@scope/pkg or git:host/user/repo" : "path or glob");
      const trimmed = input?.trim();
      if (!trimmed) continue;
      setResourceEntries(scope, ctx, field, [...entries, trimmed]);
      notify(ctx, `Added ${field}: ${trimmed}`, "info");
      return await maybeReload(ctx);
    }

    if (selected === "remove") {
      if (entries.length === 0) {
        notify(ctx, `No ${field} entries to remove`, "warning");
        continue;
      }
      const value = await selectItem(ctx, `Remove ${field} entry`, entries.map((entry, index) => ({
        value: String(index),
        label: entryToLabel(entry),
      })));
      if (value === undefined) continue;
      const index = Number.parseInt(value, 10);
      const next = entries.filter((_entry, i) => i !== index);
      setResourceEntries(scope, ctx, field, next);
      notify(ctx, `Removed ${field} entry`, "info");
      return await maybeReload(ctx);
    }

    if (selected === "clear") {
      const ok = await ctx.ui.confirm(`Clear ${field}?`, `Remove all ${field} entries from ${settingLabel(scope).toLowerCase()} settings?`);
      if (!ok) continue;
      setResourceEntries(scope, ctx, field, []);
      notify(ctx, `Cleared ${field}`, "info");
      return await maybeReload(ctx);
    }
  }
}

async function showResources(scope: ConfigScope, ctx: ExtensionCommandContext): Promise<boolean> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return false;

  while (true) {
    const selected = await selectOption<ResourceField | "back">(ctx, `${settingLabel(scope)} Resource Paths`, [
      ...RESOURCE_FIELDS.map((field) => ({
        value: field,
        label: field,
        description: `${getResourceEntries(scope, ctx, field).length} entries · ${resourceDescription(field)}`,
      })),
      { value: "back", label: "Back" },
    ]);

    if (!selected || selected === "back") return false;
    if (await showResourceField(scope, ctx, selected)) return true;
  }
}

// ── Main menu ────────────────────────────────────────────────────────────

async function showMainMenu(scope: ConfigScope, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return;

  while (true) {
    const settings = readSettings(scope, ctx.cwd);
    const currentModel = settings.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider}/${settings.defaultModel}`
      : "(unset)";
    const selected = await selectOption<MainAction>(ctx, `${settingLabel(scope)} Config`, [
      { value: "model", label: "Model", description: `Default model: ${currentModel}` },
      { value: "thinking", label: "Thinking level", description: `Default thinking: ${settings.defaultThinkingLevel ?? "(unset)"}` },
      { value: "common", label: "Common settings", description: "Theme, transport, queues, retry, compaction, terminal, editor, shell, resources" },
      { value: "resources", label: "Resource paths", description: "extensions, skills, prompts, themes, packages" },
      { value: "reload", label: "Reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
      { value: "exit", label: "Exit" },
    ]);

    if (!selected || selected === "exit") return;

    switch (selected) {
      case "model":
        await applyModel(scope, pi, ctx);
        break;
      case "thinking":
        await applyThinking(scope, pi, ctx);
        break;
      case "common":
        await showCommonSettings(scope, ctx);
        break;
      case "resources":
        if (await showResources(scope, ctx)) return;
        break;
      case "reload":
        await ctx.reload();
        return;
    }
  }
}

// ── Extension registration ───────────────────────────────────────────────

async function runConfigCommand(scope: ConfigScope, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  try {
    await showMainMenu(scope, pi, ctx);
  } catch (error) {
    notify(ctx, `Config ${scope} failed: ${errorMessage(error)}`, "error");
  }
}

export function registerConfigUI(pi: ExtensionAPI): void {
  pi.registerCommand("config:global", {
    description: "Configure global pi settings interactively",
    handler: async (_args, ctx) => {
      await runConfigCommand("global", pi, ctx);
    },
  });

  pi.registerCommand("config:project", {
    description: "Configure project pi settings interactively",
    handler: async (_args, ctx) => {
      await runConfigCommand("project", pi, ctx);
    },
  });
}
