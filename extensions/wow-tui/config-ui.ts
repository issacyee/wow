/**
 * Interactive configuration UI for global and project-level pi settings.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { modelsAreEqual, type Model } from "@earendil-works/pi-ai";
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
  getKeybindings,
  Key,
  matchesKey,
  parseKey,
  type KeyId,
  type KeybindingsConfig,
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
type ResourceAction = "add" | "remove" | "clear" | "list";
type KeybindingEditorAction = "replace" | "add" | "remove" | "disable" | "restore" | "back";
type MainAction = "model" | "thinking" | "common" | "resources" | "keybindings" | "reload";

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

function keybindingsPath(): string {
  return join(getAgentDir(), "keybindings.json");
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

function readKeybindingsConfig(): KeybindingsConfig {
  const raw = readJsonFile(keybindingsPath());
  const config: KeybindingsConfig = {};

  for (const [id, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      config[id] = value as KeyId;
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      config[id] = value as KeyId[];
    }
  }

  return config;
}

function writeKeybindingsConfig(config: KeybindingsConfig): void {
  writeJsonFile(keybindingsPath(), orderKeybindingsConfig(config));
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

function isJsonObject(value: any): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deletePathValue(settings: JsonObject, path: string[]): void {
  if (path.length === 0) return;

  const parents: Array<{ target: JsonObject; key: string }> = [];
  let target = settings;
  for (const key of path.slice(0, -1)) {
    const next = target[key];
    if (!isJsonObject(next)) return;
    parents.push({ target, key });
    target = next;
  }

  delete target[path[path.length - 1]!];

  for (let i = parents.length - 1; i >= 0; i--) {
    const { target: parent, key } = parents[i]!;
    const child = parent[key];
    if (isJsonObject(child) && Object.keys(child).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
}

function setPathValue(settings: JsonObject, path: string[], value: any): void {
  if (value === undefined) {
    deletePathValue(settings, path);
    return;
  }

  let target = settings;
  for (const key of path.slice(0, -1)) {
    if (!isJsonObject(target[key])) {
      target[key] = {};
    }
    target = target[key];
  }
  target[path[path.length - 1]!] = value;
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

function scopeLabel(scope: ConfigScope): string {
  return scope === "global" ? "global" : "project";
}

function hasOwnPath(settings: JsonObject, path: string[]): boolean {
  let target: any = settings;
  for (const key of path.slice(0, -1)) {
    if (!isJsonObject(target)) return false;
    target = target[key];
  }
  return isJsonObject(target) && Object.prototype.hasOwnProperty.call(target, path[path.length - 1]!);
}

function getPathValue(settings: JsonObject, path: string[]): any {
  let target: any = settings;
  for (const key of path) {
    if (!isJsonObject(target) && typeof target !== "object") return undefined;
    target = target?.[key];
  }
  return target;
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

function scopedCurrentValue(
  scope: ConfigScope,
  cwd: string,
  path: string[],
  effectiveValue: any,
): string {
  const scoped = readSettings(scope, cwd);
  const scopedValue = getPathValue(scoped, path);
  if (hasOwnPath(scoped, path)) return stringifyValue(scopedValue);

  if (scope === "project") {
    const global = readSettings("global", cwd);
    if (hasOwnPath(global, path)) return `↳ ${stringifyValue(getPathValue(global, path))} (inherited)`;
  }

  return `↳ ${stringifyValue(effectiveValue)} (built-in)`;
}

// ── Keybindings helpers ──────────────────────────────────────────────────

interface KeybindingActionInfo {
  id: string;
  description: string;
  defaultKeys: KeyId[];
  currentKeys: KeyId[];
  userKeys: KeyId[] | undefined;
  hasUserOverride: boolean;
}

function normalizeKeyList(value: unknown): KeyId[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const keys: KeyId[] = [];

  for (const item of raw) {
    if (typeof item !== "string" || seen.has(item)) continue;
    seen.add(item);
    keys.push(item as KeyId);
  }

  return keys;
}

function keyListDisplay(keys: KeyId[] | undefined): string {
  if (!keys || keys.length === 0) return "(none)";
  return keys.join(", ");
}

function keybindingDefinitions(): Record<string, { defaultKeys: KeyId | KeyId[]; description?: string }> {
  return ((getKeybindings() as any).definitions ?? {}) as Record<string, { defaultKeys: KeyId | KeyId[]; description?: string }>;
}

function keybindingIds(): string[] {
  return Object.keys(keybindingDefinitions()).sort((a, b) => a.localeCompare(b));
}

function orderKeybindingsConfig(config: KeybindingsConfig): JsonObject {
  const ordered: JsonObject = {};
  for (const id of keybindingIds()) {
    if (Object.prototype.hasOwnProperty.call(config, id)) ordered[id] = config[id];
  }

  for (const id of Object.keys(config).filter((key) => !Object.prototype.hasOwnProperty.call(ordered, key)).sort()) {
    ordered[id] = config[id];
  }

  return ordered;
}

function getKeybindingInfo(id: string, config: KeybindingsConfig = readKeybindingsConfig()): KeybindingActionInfo | undefined {
  const manager = getKeybindings();
  const definition = keybindingDefinitions()[id];
  if (!definition) return undefined;

  const hasUserOverride = Object.prototype.hasOwnProperty.call(config, id);
  const userKeys = hasUserOverride ? normalizeKeyList(config[id]) : undefined;

  return {
    id,
    description: definition.description ?? "",
    defaultKeys: normalizeKeyList(definition.defaultKeys),
    currentKeys: normalizeKeyList((manager as any).getKeys?.(id) ?? (hasUserOverride ? userKeys : definition.defaultKeys)),
    userKeys,
    hasUserOverride,
  };
}

function keybindingActionItems(config: KeybindingsConfig = readKeybindingsConfig()): SelectItem[] {
  return keybindingIds()
    .map((id) => getKeybindingInfo(id, config))
    .filter((info): info is KeybindingActionInfo => !!info)
    .map((info) => ({
      value: info.id,
      label: info.id,
      description: `${keyListDisplay(info.currentKeys)} · ${info.description || "No description"}${info.hasUserOverride ? " · overridden" : ""}`,
    }));
}

function effectiveBindingsWithOverride(actionId: string, keys: KeyId[] | undefined, config: KeybindingsConfig): Map<string, KeyId[]> {
  const bindings = new Map<string, KeyId[]>();

  for (const id of keybindingIds()) {
    const definition = keybindingDefinitions()[id];
    if (!definition) continue;
    const hasUserOverride = id === actionId || Object.prototype.hasOwnProperty.call(config, id);
    const rawKeys = id === actionId ? keys : hasUserOverride ? config[id] : definition.defaultKeys;
    bindings.set(id, normalizeKeyList(rawKeys));
  }

  return bindings;
}

function findKeyConflicts(actionId: string, keys: KeyId[], config: KeybindingsConfig): Array<{ key: KeyId; actionIds: string[] }> {
  const nextBindings = effectiveBindingsWithOverride(actionId, keys, config);
  const conflicts: Array<{ key: KeyId; actionIds: string[] }> = [];

  for (const key of keys) {
    const actionIds: string[] = [];
    for (const [id, boundKeys] of nextBindings) {
      if (id === actionId) continue;
      if (boundKeys.includes(key)) actionIds.push(id);
    }
    if (actionIds.length > 0) conflicts.push({ key, actionIds });
  }

  return conflicts;
}

function applyKeybindingsConfig(config: KeybindingsConfig): void {
  const manager = getKeybindings() as any;
  if (typeof manager.reload === "function") {
    manager.reload();
    return;
  }
  if (typeof manager.setUserBindings === "function") {
    manager.setUserBindings(config);
  }
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
    this.container.addChild(new Text(this.theme.fg("dim", "Type to filter • Backspace delete • Enter select • Esc back"), 1, 0));
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

class KeyCaptureDialog implements Component {
  private captured: KeyId | undefined;

  constructor(
    private title: string,
    private theme: any,
    private done: (value: KeyId | undefined) => void,
  ) {}

  render(width: number): string[] {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
    container.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.title)), 1, 0));
    container.addChild(new Spacer(1));

    if (this.captured) {
      container.addChild(new Text(`Captured: ${this.theme.fg("success", this.captured)}`, 1, 0));
      container.addChild(new Text(this.theme.fg("dim", "Enter confirm • Backspace retry • Esc cancel"), 1, 0));
    } else {
      container.addChild(new Text(this.theme.fg("warning", "Press the key combination to bind."), 1, 0));
      container.addChild(new Text(this.theme.fg("dim", "Special keys like Esc and Enter are captured first, then confirmed."), 1, 0));
    }

    container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
    return container.render(width);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.captured) {
      if (matchesKey(data, Key.enter)) {
        this.done(this.captured);
        return;
      }
      if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        this.captured = undefined;
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.done(undefined);
        return;
      }
    }

    const key = parseKey(data);
    if (key) this.captured = key as KeyId;
  }
}

async function captureKey(ctx: ExtensionCommandContext, title: string): Promise<KeyId | undefined> {
  if (ctx.mode !== "tui") {
    const raw = await ctx.ui.input(title, "ctrl+p");
    return raw?.trim() ? raw.trim() as KeyId : undefined;
  }

  return await ctx.ui.custom<KeyId | undefined>((tui, theme, _kb, done) => {
    const component = new KeyCaptureDialog(title, theme, done);
    return {
      render: (width: number) => component.render(width),
      invalidate: () => component.invalidate(),
      handleInput: (data: string) => {
        component.handleInput(data);
        tui.requestRender();
      },
    };
  });
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

function selectedSettingsItem(list: SettingsList): SettingItem | undefined {
  const state = list as any;
  const items = state.searchEnabled ? state.filteredItems : state.items;
  return Array.isArray(items) ? items[state.selectedIndex] : undefined;
}

async function showSettingsScreen(
  ctx: ExtensionCommandContext,
  title: string,
  items: SettingItem[],
  onChange: (id: string, newValue: string, list: SettingsList) => void | Promise<void>,
  onUnset: (id: string, list: SettingsList) => void | Promise<void>,
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

    const settingsListTheme = {
      ...getSettingsListTheme(),
      hint: (text: string) => theme.fg("dim", text.replace("Enter/Space to change · Esc to cancel", "Enter/Space change · Ctrl+U unset · Esc back")),
    };

    const settingsList = new SettingsList(
      items,
      Math.min(Math.max(items.length, 1), 12),
      settingsListTheme,
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
        if (!(settingsList as any).submenuComponent && matchesKey(data, Key.ctrl("u"))) {
          const item = selectedSettingsItem(settingsList);
          if (item) void onUnset(item.id, settingsList);
          tui.requestRender();
          return;
        }
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

function getScopedDefaultModel(scope: ConfigScope, cwd: string): { provider: string; id: string; label: string } | undefined {
  const settings = readSettings(scope, cwd);
  if (typeof settings.defaultProvider !== "string" || typeof settings.defaultModel !== "string") return undefined;
  return {
    provider: settings.defaultProvider,
    id: settings.defaultModel,
    label: `${settings.defaultProvider}/${settings.defaultModel}`,
  };
}

function clearDefaultModel(scope: ConfigScope, cwd: string): void {
  updateSettings(scope, cwd, (settings) => {
    deletePathValue(settings, ["defaultProvider"]);
    deletePathValue(settings, ["defaultModel"]);
  });
}

function clearDefaultThinking(scope: ConfigScope, cwd: string): void {
  setScopedValue(scope, cwd, ["defaultThinkingLevel"], undefined);
}

function notifyProjectModelOverrideForGlobal(scope: ConfigScope, ctx: ExtensionCommandContext): void {
  if (scope !== "global" || !ctx.isProjectTrusted()) return;
  try {
    const projectModel = getScopedDefaultModel("project", ctx.cwd);
    if (!projectModel) return;
    notify(ctx, `Current project overrides the default model with ${projectModel.label}. Clear it in /config:project for global changes to apply after reload/restart.`, "warning");
  } catch {
    // Ignore unreadable project settings while configuring global scope.
  }
}

function notifyProjectThinkingOverrideForGlobal(scope: ConfigScope, ctx: ExtensionCommandContext): void {
  if (scope !== "global" || !ctx.isProjectTrusted()) return;
  try {
    const project = readSettings("project", ctx.cwd);
    if (!THINKING_LEVELS.includes(project.defaultThinkingLevel)) return;
    notify(ctx, `Current project overrides the default thinking level with ${project.defaultThinkingLevel}. Clear it in /config:project for global changes to apply after reload/restart.`, "warning");
  } catch {
    // Ignore unreadable project settings while configuring global scope.
  }
}

async function applyModel(scope: ConfigScope, pi: ExtensionAPI, ctx: ExtensionCommandContext, model: Model<any>): Promise<void> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return;

  if (scope === "global") {
    const ok = await pi.setModel(model);
    if (!ok) {
      notify(ctx, `No configured auth for ${modelLabel(model)}`, "error");
      return;
    }
    notify(ctx, `Global default model set to ${modelLabel(model)}`, "info");
    notifyProjectModelOverrideForGlobal(scope, ctx);
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

async function unsetModel(scope: ConfigScope, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return;

  const previous = getScopedDefaultModel(scope, ctx.cwd);
  clearDefaultModel(scope, ctx.cwd);

  if (scope === "project") {
    const inherited = getScopedDefaultModel("global", ctx.cwd);
    if (inherited) {
      ctx.modelRegistry.refresh();
      const model = ctx.modelRegistry.find(inherited.provider, inherited.id);
      if (model) {
        const ok = await pi.setModel(model);
        if (ok) {
          notify(ctx, `Project default model override cleared${previous ? ` (${previous.label})` : ""}; inherited global model ${inherited.label} applied now.`, "info");
          return;
        }
        notify(ctx, `Project default model override cleared, but inherited global model ${inherited.label} could not be applied: missing auth.`, "warning");
        return;
      }
      notify(ctx, `Project default model override cleared, but inherited global model ${inherited.label} is not available in the current registry.`, "warning");
      return;
    }

    notify(ctx, `Project default model override cleared${previous ? ` (${previous.label})` : ""}. Reload or restart may be required to use pi's default model resolution.`, "info");
    return;
  }

  notify(ctx, `Global default model cleared${previous ? ` (${previous.label})` : ""}. Reload or restart may be required to use pi's default model resolution.`, "info");
  notifyProjectModelOverrideForGlobal(scope, ctx);
}

async function applyThinking(scope: ConfigScope, pi: ExtensionAPI, ctx: ExtensionCommandContext, level: ThinkingLevel): Promise<void> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return;

  if (scope === "global") {
    pi.setThinkingLevel(level);
    notify(ctx, `Global default thinking level set to ${level}`, "info");
    notifyProjectThinkingOverrideForGlobal(scope, ctx);
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

async function unsetThinking(scope: ConfigScope, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return;

  const settings = readSettings(scope, ctx.cwd);
  const previous = THINKING_LEVELS.includes(settings.defaultThinkingLevel) ? settings.defaultThinkingLevel : undefined;
  clearDefaultThinking(scope, ctx.cwd);

  if (scope === "project") {
    const global = readSettings("global", ctx.cwd);
    if (THINKING_LEVELS.includes(global.defaultThinkingLevel)) {
      pi.setThinkingLevel(global.defaultThinkingLevel);
      notify(ctx, `Project default thinking override cleared${previous ? ` (${previous})` : ""}; inherited global thinking level ${global.defaultThinkingLevel} applied now.`, "info");
      return;
    }

    notify(ctx, `Project default thinking override cleared${previous ? ` (${previous})` : ""}. Reload or restart may be required to use pi's default thinking resolution.`, "info");
    return;
  }

  notify(ctx, `Global default thinking level cleared${previous ? ` (${previous})` : ""}. Reload or restart may be required to use pi's default thinking resolution.`, "info");
  notifyProjectThinkingOverrideForGlobal(scope, ctx);
}

interface ConfigModelItem {
  provider: string;
  id: string;
  model: Model<any>;
}

function findConfiguredDefaultModel(scope: ConfigScope, cwd: string, ctx: ExtensionCommandContext): Model<any> | undefined {
  const scoped = getScopedDefaultModel(scope, cwd);
  if (scoped) return ctx.modelRegistry.find(scoped.provider, scoped.id);

  if (scope === "project") {
    const global = getScopedDefaultModel("global", cwd);
    if (global) return ctx.modelRegistry.find(global.provider, global.id);
  }

  return undefined;
}

function modelDefaultDisplay(scope: ConfigScope, cwd: string): string {
  const scoped = getScopedDefaultModel(scope, cwd);
  if (scoped) return scoped.label;

  if (scope === "project") {
    const global = getScopedDefaultModel("global", cwd);
    if (global) return `↳ ${global.label} (inherited)`;
  }

  return "↳ (built-in)";
}

class ConfigModelSelector implements Component, Focusable {
  private container = new Container();
  private input = new Input();
  private allModels: ConfigModelItem[];
  private filteredModels: ConfigModelItem[];
  private selectedIndex = 0;
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
    models: Model<any>[],
    private currentDefault: Model<any> | undefined,
    private currentDefaultText: string,
    private scope: ConfigScope,
    private theme: any,
    private onSelect: (model: Model<any>) => Promise<void>,
    private onUnset: () => Promise<void>,
    private done: () => void,
  ) {
    this.allModels = this.sortModels(models.map((model) => ({ provider: model.provider, id: model.id, model })));
    this.filteredModels = this.allModels;
    const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentDefault, item.model));
    if (currentIndex >= 0) this.selectedIndex = currentIndex;
    this.input.onSubmit = () => this.selectCurrent();
    this.input.onEscape = () => this.done();
    this.rebuild();
  }

  private sortModels(models: ConfigModelItem[]): ConfigModelItem[] {
    return [...models].sort((a, b) => {
      const aIsCurrent = modelsAreEqual(this.currentDefault, a.model);
      const bIsCurrent = modelsAreEqual(this.currentDefault, b.model);
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      const provider = a.provider.localeCompare(b.provider);
      return provider !== 0 ? provider : a.id.localeCompare(b.id);
    });
  }

  private filterModels(): void {
    const query = this.input.getValue().trim();
    this.filteredModels = query
      ? fuzzyFilter(this.allModels, query, ({ id, provider, model }) => `${id} ${provider} ${provider}/${id} ${model.name ?? ""}`)
      : this.allModels;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
    this.rebuild();
  }

  private selectCurrent(): void {
    const selected = this.filteredModels[this.selectedIndex];
    if (!selected) return;
    void this.onSelect(selected.model).finally(() => this.done());
  }

  private unsetCurrentScope(): void {
    void this.onUnset().finally(() => this.done());
  }

  private rebuild(): void {
    this.container.clear();
    this.container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
    this.container.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.title)), 1, 0));
    this.container.addChild(new Text(this.theme.fg("dim", `Scope: ${scopeLabel(this.scope)} · Current default: ${this.currentDefaultText}`), 1, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.input);
    this.container.addChild(new Spacer(1));

    const maxVisible = 10;
    const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible));
    const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredModels[i];
      if (!item) continue;
      const selected = i === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
      const modelText = selected ? this.theme.fg("accent", item.id) : item.id;
      const providerBadge = this.theme.fg("muted", `[${item.provider}]`);
      const checkmark = modelsAreEqual(this.currentDefault, item.model) ? this.theme.fg("success", " ✓") : "";
      this.container.addChild(new Text(`${prefix}${modelText} ${providerBadge}${checkmark}`, 0, 0));
    }

    if (startIndex > 0 || endIndex < this.filteredModels.length) {
      this.container.addChild(new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`), 0, 0));
    }

    if (this.filteredModels.length === 0) {
      this.container.addChild(new Text(this.theme.fg("warning", "  No matching models"), 0, 0));
    } else {
      const selected = this.filteredModels[this.selectedIndex];
      this.container.addChild(new Spacer(1));
      this.container.addChild(new Text(this.theme.fg("muted", `  Model Name: ${selected?.model.name ?? selected?.id ?? ""}`), 0, 0));
    }

    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(this.theme.fg("dim", `Enter set · Ctrl+U unset ${scopeLabel(this.scope)} · Esc back`), 1, 0));
    this.container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (matchesKey(data, Key.ctrl("u"))) {
      this.unsetCurrentScope();
      return;
    }
    if (kb.matches(data, "tui.select.up")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
      this.rebuild();
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
      this.rebuild();
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      this.selectCurrent();
      return;
    }
    if (kb.matches(data, "tui.select.cancel")) {
      this.done();
      return;
    }

    this.input.handleInput(data);
    this.filterModels();
  }
}

function effectiveThinkingLevel(scope: ConfigScope, cwd: string): ThinkingLevel | undefined {
  const scoped = readSettings(scope, cwd).defaultThinkingLevel;
  if (THINKING_LEVELS.includes(scoped)) return scoped;

  if (scope === "project") {
    const global = readSettings("global", cwd).defaultThinkingLevel;
    if (THINKING_LEVELS.includes(global)) return global;
  }

  return undefined;
}

function thinkingDefaultDisplay(scope: ConfigScope, cwd: string): string {
  const scoped = readSettings(scope, cwd).defaultThinkingLevel;
  if (THINKING_LEVELS.includes(scoped)) return scoped;

  if (scope === "project") {
    const global = readSettings("global", cwd).defaultThinkingLevel;
    if (THINKING_LEVELS.includes(global)) return `↳ ${global} (inherited)`;
  }

  return "↳ (built-in)";
}

class ConfigThinkingSelector implements Component {
  private container = new Container();
  private selectedIndex = 0;

  constructor(
    private title: string,
    private currentDefault: ThinkingLevel | undefined,
    private currentDefaultText: string,
    private scope: ConfigScope,
    private theme: any,
    private onSelect: (level: ThinkingLevel) => Promise<void>,
    private onUnset: () => Promise<void>,
    private done: () => void,
  ) {
    const currentIndex = currentDefault ? THINKING_LEVELS.indexOf(currentDefault) : -1;
    if (currentIndex >= 0) this.selectedIndex = currentIndex;
    this.rebuild();
  }

  private selectCurrent(): void {
    const level = THINKING_LEVELS[this.selectedIndex];
    if (!level) return;
    void this.onSelect(level).finally(() => this.done());
  }

  private unsetCurrentScope(): void {
    void this.onUnset().finally(() => this.done());
  }

  private rebuild(): void {
    this.container.clear();
    this.container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
    this.container.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.title)), 1, 0));
    this.container.addChild(new Text(this.theme.fg("dim", `Scope: ${scopeLabel(this.scope)} · Current default: ${this.currentDefaultText}`), 1, 0));
    this.container.addChild(new Spacer(1));

    for (let i = 0; i < THINKING_LEVELS.length; i++) {
      const level = THINKING_LEVELS[i]!;
      const selected = i === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
      const text = selected ? this.theme.fg("accent", level) : level;
      const checkmark = this.currentDefault === level ? this.theme.fg("success", " ✓") : "";
      this.container.addChild(new Text(`${prefix}${text}${checkmark}`, 0, 0));
    }

    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(this.theme.fg("dim", `Enter set · Ctrl+U unset ${scopeLabel(this.scope)} · Esc back`), 1, 0));
    this.container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (matchesKey(data, Key.ctrl("u"))) {
      this.unsetCurrentScope();
      return;
    }
    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? THINKING_LEVELS.length - 1 : this.selectedIndex - 1;
      this.rebuild();
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === THINKING_LEVELS.length - 1 ? 0 : this.selectedIndex + 1;
      this.rebuild();
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      this.selectCurrent();
      return;
    }
    if (kb.matches(data, "tui.select.cancel")) {
      this.done();
    }
  }
}

async function showModelSettings(scope: ConfigScope, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return;
  if (ctx.mode !== "tui") {
    notify(ctx, "Model config UI requires TUI mode", "error");
    return;
  }

  ctx.modelRegistry.refresh();
  const models = ctx.modelRegistry.getAvailable();
  if (models.length === 0) {
    notify(ctx, "No authenticated models available. Use /login first.", "warning");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const component = new ConfigModelSelector(
      `${settingLabel(scope)} Model`,
      models,
      findConfiguredDefaultModel(scope, ctx.cwd, ctx),
      modelDefaultDisplay(scope, ctx.cwd),
      scope,
      theme,
      (model) => applyModel(scope, pi, ctx, model),
      () => unsetModel(scope, pi, ctx),
      () => done(undefined),
    );

    return {
      render: (width: number) => component.render(width),
      invalidate: () => component.invalidate(),
      handleInput: (data: string) => {
        component.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

async function showThinkingSettings(scope: ConfigScope, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return;
  if (ctx.mode !== "tui") {
    notify(ctx, "Thinking config UI requires TUI mode", "error");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const component = new ConfigThinkingSelector(
      `${settingLabel(scope)} Thinking Level`,
      effectiveThinkingLevel(scope, ctx.cwd),
      thinkingDefaultDisplay(scope, ctx.cwd),
      scope,
      theme,
      (level) => applyThinking(scope, pi, ctx, level),
      () => unsetThinking(scope, pi, ctx),
      () => done(undefined),
    );

    return {
      render: (width: number) => component.render(width),
      invalidate: () => component.invalidate(),
      handleInput: (data: string) => {
        component.handleInput(data);
        tui.requestRender();
      },
    };
  });
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
  const cv = (path: string[], effectiveValue: any) => scopedCurrentValue(scope, ctx.cwd, path, effectiveValue);

  const items: SettingItem[] = [
    {
      id: "theme",
      label: "Theme",
      description: "Theme name. Built-ins include dark and light; custom themes may also be available.",
      currentValue: cv(["theme"], effectiveManager.getTheme() ?? "dark"),
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
      currentValue: cv(["transport"], effectiveManager.getTransport()),
      values: [...TRANSPORTS],
    },
    {
      id: "steeringMode",
      label: "Steering mode",
      description: "How queued steering messages are delivered while the agent is streaming.",
      currentValue: cv(["steeringMode"], effectiveManager.getSteeringMode()),
      values: [...QUEUE_MODES],
    },
    {
      id: "followUpMode",
      label: "Follow-up mode",
      description: "How queued follow-up messages are delivered after the agent stops.",
      currentValue: cv(["followUpMode"], effectiveManager.getFollowUpMode()),
      values: [...QUEUE_MODES],
    },
    {
      id: "hideThinkingBlock",
      label: "Hide thinking",
      description: "Hide thinking blocks in assistant output.",
      currentValue: cv(["hideThinkingBlock"], effectiveManager.getHideThinkingBlock()),
      values: ["true", "false"],
    },
    {
      id: "quietStartup",
      label: "Quiet startup",
      description: "Hide verbose startup resource listing.",
      currentValue: cv(["quietStartup"], effectiveManager.getQuietStartup()),
      values: ["true", "false"],
    },
    {
      id: "collapseChangelog",
      label: "Collapse changelog",
      description: "Show condensed changelog after updates.",
      currentValue: cv(["collapseChangelog"], effectiveManager.getCollapseChangelog()),
      values: ["true", "false"],
    },
    {
      id: "enableInstallTelemetry",
      label: "Install telemetry",
      description: "Send anonymous install/update telemetry. Global setting only.",
      currentValue: cv(["enableInstallTelemetry"], effectiveManager.getEnableInstallTelemetry()),
      values: ["true", "false"],
    },
    {
      id: "defaultProjectTrust",
      label: "Default project trust",
      description: "Fallback trust behavior when no saved trust decision exists. Global setting only.",
      currentValue: cv(["defaultProjectTrust"], effectiveManager.getDefaultProjectTrust()),
      values: [...DEFAULT_PROJECT_TRUST_VALUES],
    },
    {
      id: "doubleEscapeAction",
      label: "Double escape",
      description: "Action for pressing Escape twice with empty editor.",
      currentValue: cv(["doubleEscapeAction"], effectiveManager.getDoubleEscapeAction()),
      values: [...DOUBLE_ESCAPE_ACTIONS],
    },
    {
      id: "treeFilterMode",
      label: "Tree filter",
      description: "Default filter mode for /tree.",
      currentValue: cv(["treeFilterMode"], effectiveManager.getTreeFilterMode()),
      values: [...TREE_FILTER_MODES],
    },
    {
      id: "compaction.enabled",
      label: "Auto compact",
      description: "Automatically compact context when it gets too large.",
      currentValue: cv(["compaction", "enabled"], compactionSettings.enabled),
      values: ["true", "false"],
    },
    {
      id: "compaction.reserveTokens",
      label: "Compact reserve",
      description: "Tokens reserved for model response during compaction.",
      currentValue: cv(["compaction", "reserveTokens"], compactionSettings.reserveTokens),
      submenu: (_current, done) => inputSubmenu("Compaction reserve tokens", numericValue(settings.compaction?.reserveTokens, compactionSettings.reserveTokens), done, ctx.ui.theme),
    },
    {
      id: "compaction.keepRecentTokens",
      label: "Compact recent",
      description: "Recent tokens kept unsummarized during compaction.",
      currentValue: cv(["compaction", "keepRecentTokens"], compactionSettings.keepRecentTokens),
      submenu: (_current, done) => inputSubmenu("Compaction keep recent tokens", numericValue(settings.compaction?.keepRecentTokens, compactionSettings.keepRecentTokens), done, ctx.ui.theme),
    },
    {
      id: "branchSummary.reserveTokens",
      label: "Branch reserve",
      description: "Tokens reserved for branch summarization.",
      currentValue: cv(["branchSummary", "reserveTokens"], branchSummarySettings.reserveTokens),
      submenu: (_current, done) => inputSubmenu("Branch summary reserve tokens", numericValue(settings.branchSummary?.reserveTokens, branchSummarySettings.reserveTokens), done, ctx.ui.theme),
    },
    {
      id: "branchSummary.skipPrompt",
      label: "Branch skip prompt",
      description: "Skip summarize-branch prompt on tree navigation.",
      currentValue: cv(["branchSummary", "skipPrompt"], branchSummarySettings.skipPrompt),
      values: ["true", "false"],
    },
    {
      id: "retry.enabled",
      label: "Retry enabled",
      description: "Enable automatic agent-level retry on transient errors.",
      currentValue: cv(["retry", "enabled"], retrySettings.enabled),
      values: ["true", "false"],
    },
    {
      id: "retry.maxRetries",
      label: "Retry max",
      description: "Maximum agent-level retry attempts.",
      currentValue: cv(["retry", "maxRetries"], retrySettings.maxRetries),
      submenu: (_current, done) => inputSubmenu("Retry max retries", numericValue(settings.retry?.maxRetries, retrySettings.maxRetries), done, ctx.ui.theme),
    },
    {
      id: "retry.baseDelayMs",
      label: "Retry delay",
      description: "Base delay in milliseconds for agent-level exponential backoff.",
      currentValue: cv(["retry", "baseDelayMs"], retrySettings.baseDelayMs),
      submenu: (_current, done) => inputSubmenu("Retry base delay ms", numericValue(settings.retry?.baseDelayMs, retrySettings.baseDelayMs), done, ctx.ui.theme),
    },
    {
      id: "retry.provider.timeoutMs",
      label: "Provider timeout",
      description: "Provider request timeout in milliseconds. Empty clears override.",
      currentValue: cv(["retry", "provider", "timeoutMs"], providerRetrySettings.timeoutMs),
      submenu: (_current, done) => inputSubmenu("Provider timeout ms", settings.retry?.provider?.timeoutMs === undefined ? "" : String(settings.retry.provider.timeoutMs), done, ctx.ui.theme),
    },
    {
      id: "retry.provider.maxRetries",
      label: "Provider retries",
      description: "Provider/SDK retry attempts. Empty clears override.",
      currentValue: cv(["retry", "provider", "maxRetries"], providerRetrySettings.maxRetries),
      submenu: (_current, done) => inputSubmenu("Provider max retries", settings.retry?.provider?.maxRetries === undefined ? "" : String(settings.retry.provider.maxRetries), done, ctx.ui.theme),
    },
    {
      id: "retry.provider.maxRetryDelayMs",
      label: "Provider delay cap",
      description: "Max server-requested retry delay in milliseconds.",
      currentValue: cv(["retry", "provider", "maxRetryDelayMs"], providerRetrySettings.maxRetryDelayMs),
      submenu: (_current, done) => inputSubmenu("Provider max retry delay ms", numericValue(settings.retry?.provider?.maxRetryDelayMs, providerRetrySettings.maxRetryDelayMs), done, ctx.ui.theme),
    },
    {
      id: "httpIdleTimeoutMs",
      label: "HTTP idle timeout",
      description: "HTTP header/body idle timeout in milliseconds. 0 disables.",
      currentValue: cv(["httpIdleTimeoutMs"], effectiveManager.getHttpIdleTimeoutMs()),
      submenu: (_current, done) => inputSubmenu("HTTP idle timeout ms", numericValue(settings.httpIdleTimeoutMs, effectiveManager.getHttpIdleTimeoutMs()), done, ctx.ui.theme),
    },
    {
      id: "websocketConnectTimeoutMs",
      label: "WebSocket timeout",
      description: "WebSocket connect timeout in milliseconds. Empty clears override.",
      currentValue: cv(["websocketConnectTimeoutMs"], effectiveManager.getWebSocketConnectTimeoutMs()),
      submenu: (_current, done) => inputSubmenu("WebSocket connect timeout ms", settings.websocketConnectTimeoutMs === undefined ? "" : String(settings.websocketConnectTimeoutMs), done, ctx.ui.theme),
    },
    {
      id: "terminal.showImages",
      label: "Show images",
      description: "Render images inline when terminal supports it.",
      currentValue: cv(["terminal", "showImages"], effectiveManager.getShowImages()),
      values: ["true", "false"],
    },
    {
      id: "terminal.imageWidthCells",
      label: "Image width",
      description: "Preferred inline image width in terminal cells.",
      currentValue: cv(["terminal", "imageWidthCells"], effectiveManager.getImageWidthCells()),
      values: ["60", "80", "120"],
    },
    {
      id: "terminal.clearOnShrink",
      label: "Clear on shrink",
      description: "Clear empty rows when rendered content shrinks.",
      currentValue: cv(["terminal", "clearOnShrink"], effectiveManager.getClearOnShrink()),
      values: ["true", "false"],
    },
    {
      id: "terminal.showTerminalProgress",
      label: "Terminal progress",
      description: "Show OSC 9;4 progress indicators in terminal tab bar.",
      currentValue: cv(["terminal", "showTerminalProgress"], effectiveManager.getShowTerminalProgress()),
      values: ["true", "false"],
    },
    {
      id: "images.autoResize",
      label: "Auto-resize images",
      description: "Resize large images before sending to providers.",
      currentValue: cv(["images", "autoResize"], effectiveManager.getImageAutoResize()),
      values: ["true", "false"],
    },
    {
      id: "images.blockImages",
      label: "Block images",
      description: "Prevent images from being sent to providers.",
      currentValue: cv(["images", "blockImages"], effectiveManager.getBlockImages()),
      values: ["true", "false"],
    },
    {
      id: "showHardwareCursor",
      label: "Hardware cursor",
      description: "Show terminal hardware cursor for IME positioning.",
      currentValue: cv(["showHardwareCursor"], effectiveManager.getShowHardwareCursor()),
      values: ["true", "false"],
    },
    {
      id: "editorPaddingX",
      label: "Editor padding",
      description: "Horizontal editor padding, 0-3.",
      currentValue: cv(["editorPaddingX"], effectiveManager.getEditorPaddingX()),
      values: ["0", "1", "2", "3"],
    },
    {
      id: "autocompleteMaxVisible",
      label: "Autocomplete max",
      description: "Max visible autocomplete items, 3-20.",
      currentValue: cv(["autocompleteMaxVisible"], effectiveManager.getAutocompleteMaxVisible()),
      values: ["3", "5", "7", "10", "15", "20"],
    },
    {
      id: "enableSkillCommands",
      label: "Skill commands",
      description: "Register skills as /skill:name commands.",
      currentValue: cv(["enableSkillCommands"], effectiveManager.getEnableSkillCommands()),
      values: ["true", "false"],
    },
    {
      id: "warnings.anthropicExtraUsage",
      label: "Anthropic warning",
      description: "Warn when Anthropic subscription auth may use paid extra usage.",
      currentValue: cv(["warnings", "anthropicExtraUsage"], effectiveManager.getWarnings().anthropicExtraUsage ?? true),
      values: ["true", "false"],
    },
    {
      id: "shellPath",
      label: "Shell path",
      description: "Custom bash shell path. Empty clears override.",
      currentValue: cv(["shellPath"], effectiveManager.getShellPath()),
      submenu: (_current, done) => inputSubmenu("Shell path", textValue(settings.shellPath, effectiveManager.getShellPath() ?? ""), done, ctx.ui.theme),
    },
    {
      id: "shellCommandPrefix",
      label: "Shell prefix",
      description: "Command prefix prepended to every bash command. Empty clears override.",
      currentValue: cv(["shellCommandPrefix"], effectiveManager.getShellCommandPrefix()),
      submenu: (_current, done) => inputSubmenu("Shell command prefix", textValue(settings.shellCommandPrefix, effectiveManager.getShellCommandPrefix() ?? ""), done, ctx.ui.theme),
    },
    {
      id: "sessionDir",
      label: "Session dir",
      description: "Custom session directory. Empty clears override.",
      currentValue: cv(["sessionDir"], effectiveManager.getSessionDir()),
      submenu: (_current, done) => inputSubmenu("Session directory", textValue(settings.sessionDir, effectiveManager.getSessionDir() ?? ""), done, ctx.ui.theme),
    },
    {
      id: "markdown.codeBlockIndent",
      label: "Code indent",
      description: "Indentation string for markdown code blocks.",
      currentValue: cv(["markdown", "codeBlockIndent"], effectiveManager.getCodeBlockIndent()),
      submenu: (_current, done) => inputSubmenu("Markdown code block indent", textValue(settings.markdown?.codeBlockIndent, effectiveManager.getCodeBlockIndent()), done, ctx.ui.theme),
    },
    {
      id: "npmCommand",
      label: "NPM command",
      description: "Comma-separated argv used for package-manager operations. Empty clears override.",
      currentValue: cv(["npmCommand"], effectiveManager.getNpmCommand()),
      submenu: (_current, done) => inputSubmenu("NPM command argv", arrayToText(settings.npmCommand ?? effectiveManager.getNpmCommand()), done, ctx.ui.theme),
    },
    {
      id: "enabledModels",
      label: "Enabled models",
      description: "Comma-separated model patterns for Ctrl+P cycling. Empty clears this scope's override.",
      currentValue: cv(["enabledModels"], undefined),
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

function refreshCommonListValue(scope: ConfigScope, ctx: ExtensionCommandContext, id: string, list: SettingsList): void {
  const item = commonItems(scope, ctx).find((candidate) => candidate.id === id);
  if (item) list.updateValue(id, item.currentValue);
}

async function showCommonSettings(scope: ConfigScope, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    notify(ctx, "Common settings UI requires TUI mode", "error");
    return;
  }
  if (scope === "project" && !ensureProjectWritable(ctx)) return;

  const saveValue = async (id: string, value: any, rawValue: string, list: SettingsList, unset: boolean) => {
    const path = id.split(".");
    setScopedValue(scope, ctx.cwd, path, value);
    refreshCommonListValue(scope, ctx, id, list);

    if (id === "theme" && value !== undefined) {
      const result = ctx.ui.setTheme(rawValue);
      if (!result.success) notify(ctx, result.error ?? `Failed to apply theme ${rawValue}`, "warning");
    }
    if (id === "theme" && value === undefined) {
      notify(ctx, "Theme override cleared. Reload or restart may be required to apply the inherited theme.", "info");
      return;
    }
    if (id === "terminal.clearOnShrink" && value !== undefined) {
      notify(ctx, "clearOnShrink saved; it applies after reload or restart.", "info");
    }
    if (id === "showHardwareCursor" && value !== undefined) {
      notify(ctx, "showHardwareCursor saved; it applies after reload or restart.", "info");
    }

    notify(ctx, unset || value === undefined
      ? `${id} override cleared. Reload may be required for the current session to observe it.`
      : `${id} saved. Reload may be required for the current session to observe it.`, "info");
  };

  await showSettingsScreen(
    ctx,
    `${settingLabel(scope)} Common Settings`,
    commonItems(scope, ctx),
    async (id, newValue, list) => {
      await saveValue(id, parseCommonValue(id, newValue), newValue, list, false);
    },
    async (id, list) => {
      await saveValue(id, undefined, "", list, true);
    },
  );
}

// ── Keybindings manager ──────────────────────────────────────────────────

async function confirmKeybindingConflicts(
  ctx: ExtensionCommandContext,
  actionId: string,
  keys: KeyId[],
  config: KeybindingsConfig,
): Promise<boolean> {
  const conflicts = findKeyConflicts(actionId, keys, config);
  if (conflicts.length === 0) return true;

  const message = conflicts
    .map((conflict) => `${conflict.key}: ${conflict.actionIds.join(", ")}`)
    .join("\n");
  return await ctx.ui.confirm("Keybinding conflict", `These keys are already used by other actions:\n\n${message}\n\nSave anyway?`);
}

async function saveKeybindingOverride(
  ctx: ExtensionCommandContext,
  actionId: string,
  keys: KeyId[] | undefined,
  options: { restore?: boolean; skipConflictCheck?: boolean } = {},
): Promise<boolean> {
  const config = readKeybindingsConfig();

  if (!options.restore && !options.skipConflictCheck && keys && !(await confirmKeybindingConflicts(ctx, actionId, keys, config))) {
    return false;
  }

  if (options.restore) delete config[actionId];
  else config[actionId] = keys ?? [];

  writeKeybindingsConfig(config);
  applyKeybindingsConfig(config);
  return true;
}

function keybindingEditorOptions(info: KeybindingActionInfo): SettingOption<KeybindingEditorAction>[] {
  return [
    { value: "replace", label: "Replace keys", description: "Capture one key and replace all bindings for this action" },
    { value: "add", label: "Add key", description: "Capture one more key for this action" },
    { value: "remove", label: "Remove key", description: info.currentKeys.length > 0 ? keyListDisplay(info.currentKeys) : "No keys to remove" },
    { value: "disable", label: "Disable action", description: "Save an empty key list for this action" },
    { value: "restore", label: "Restore default", description: `Default: ${keyListDisplay(info.defaultKeys)}` },
    { value: "back", label: "Back", description: "Choose another action" },
  ];
}

async function showKeybindingActionEditor(ctx: ExtensionCommandContext, actionId: string): Promise<void> {
  while (true) {
    const config = readKeybindingsConfig();
    const info = getKeybindingInfo(actionId, config);
    if (!info) {
      notify(ctx, `Unknown keybinding action: ${actionId}`, "error");
      return;
    }

    const title = `${actionId} · ${keyListDisplay(info.currentKeys)}`;
    const selected = await selectOption<KeybindingEditorAction>(ctx, title, keybindingEditorOptions(info));
    if (!selected || selected === "back") return;

    if (selected === "replace") {
      const key = await captureKey(ctx, `Replace ${actionId}`);
      if (!key) continue;
      if (await saveKeybindingOverride(ctx, actionId, [key])) {
        notify(ctx, `${actionId} set to ${key}`, "info");
      }
      continue;
    }

    if (selected === "add") {
      const key = await captureKey(ctx, `Add key for ${actionId}`);
      if (!key) continue;
      const nextKeys = normalizeKeyList([...info.currentKeys, key]);
      if (await saveKeybindingOverride(ctx, actionId, nextKeys)) {
        notify(ctx, `${actionId} keys: ${keyListDisplay(nextKeys)}`, "info");
      }
      continue;
    }

    if (selected === "remove") {
      if (info.currentKeys.length === 0) {
        notify(ctx, `${actionId} has no keys to remove`, "warning");
        continue;
      }
      const key = await selectOption<KeyId>(ctx, `Remove key from ${actionId}`, info.currentKeys.map((currentKey) => ({
        value: currentKey,
        label: currentKey,
      })));
      if (!key) continue;
      const nextKeys = info.currentKeys.filter((currentKey) => currentKey !== key);
      if (await saveKeybindingOverride(ctx, actionId, nextKeys, { skipConflictCheck: true })) {
        notify(ctx, `${actionId} keys: ${keyListDisplay(nextKeys)}`, "info");
      }
      continue;
    }

    if (selected === "disable") {
      const ok = await ctx.ui.confirm("Disable action?", `Save an empty key list for ${actionId}?`);
      if (!ok) continue;
      if (await saveKeybindingOverride(ctx, actionId, [], { skipConflictCheck: true })) {
        notify(ctx, `${actionId} disabled`, "info");
      }
      continue;
    }

    if (selected === "restore") {
      if (await saveKeybindingOverride(ctx, actionId, undefined, { restore: true, skipConflictCheck: true })) {
        notify(ctx, `${actionId} restored to default: ${keyListDisplay(info.defaultKeys)}`, "info");
      }
    }
  }
}

async function showKeybindingSettings(ctx: ExtensionCommandContext): Promise<void> {
  while (true) {
    const selected = await selectItem(ctx, "Global Keybindings", keybindingActionItems());
    if (!selected) return;
    await showKeybindingActionEditor(ctx, selected);
  }
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
      { value: "clear", label: "Unset entries", description: "Remove this resource array from this scope's settings" },
      { value: "list", label: "List entries", description: entries.length > 0 ? entries.map(entryToLabel).join(" | ") : "No entries" },
    ]);

    if (!selected) return false;

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
      const ok = await ctx.ui.confirm(`Unset ${field}?`, `Remove the ${field} array from ${settingLabel(scope).toLowerCase()} settings?`);
      if (!ok) continue;
      setResourceEntries(scope, ctx, field, []);
      notify(ctx, `Unset ${field}`, "info");
      return await maybeReload(ctx);
    }
  }
}

async function showResources(scope: ConfigScope, ctx: ExtensionCommandContext): Promise<boolean> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return false;

  while (true) {
    const selected = await selectOption<ResourceField>(ctx, `${settingLabel(scope)} Resource Paths`, RESOURCE_FIELDS.map((field) => ({
      value: field,
      label: field,
      description: `${getResourceEntries(scope, ctx, field).length} entries · ${resourceDescription(field)}`,
    })));

    if (!selected) return false;
    if (await showResourceField(scope, ctx, selected)) return true;
  }
}

// ── Main menu ────────────────────────────────────────────────────────────

async function showMainMenu(scope: ConfigScope, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (scope === "project" && !ensureProjectWritable(ctx)) return;

  while (true) {
    const currentModel = modelDefaultDisplay(scope, ctx.cwd);
    const currentThinking = thinkingDefaultDisplay(scope, ctx.cwd);
    const mainItems: SettingOption<MainAction>[] = [
      { value: "model", label: "Model", description: `Default model: ${currentModel} · Enter set · Ctrl+U unset` },
      { value: "thinking", label: "Thinking level", description: `Default thinking: ${currentThinking} · Enter set · Ctrl+U unset` },
      { value: "common", label: "Common settings", description: "Theme, transport, queues, retry, compaction, terminal, editor, shell, resources" },
      { value: "resources", label: "Resource paths", description: "extensions, skills, prompts, themes, packages" },
    ];

    if (scope === "global") {
      mainItems.push({ value: "keybindings", label: "Keybindings", description: "Edit global keyboard shortcuts interactively" });
    }

    mainItems.push({ value: "reload", label: "Reload", description: "Reload keybindings, extensions, skills, prompts, and themes" });

    const selected = await selectOption<MainAction>(ctx, `${settingLabel(scope)} Config`, mainItems);

    if (!selected) return;

    switch (selected) {
      case "model":
        await showModelSettings(scope, pi, ctx);
        break;
      case "thinking":
        await showThinkingSettings(scope, pi, ctx);
        break;
      case "common":
        await showCommonSettings(scope, ctx);
        break;
      case "resources":
        if (await showResources(scope, ctx)) return;
        break;
      case "keybindings":
        await showKeybindingSettings(ctx);
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
