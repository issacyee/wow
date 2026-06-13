/**
 * Footer billing adapter.
 *
 * This module is UI-only. It currently supports DeepSeek official account
 * balance and keeps generic billing display shapes for future providers. It
 * never injects billing details into the LLM context.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const BILLING_REFRESH_MS = 60_000;
const BILLING_TIMEOUT_MS = 10_000;
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const TOKENS_PER_MILLION = 1_000_000;

interface BalanceBillingPayload {
  kind: "balance";
  currency?: string;
  amount: number;
  sessionCost?: number;
  usdToCurrencyRate?: number;
}

interface QuotaBillingPayload {
  kind: "quota";
  used: number;
  limit: number;
  unit?: string;
}

interface UnlimitedBillingPayload {
  kind: "unlimited";
}

interface UnknownBillingPayload {
  kind: "unknown";
}

type BillingPayload = BalanceBillingPayload | QuotaBillingPayload | UnlimitedBillingPayload | UnknownBillingPayload;

type BillingData = BillingPayload;

type BillingSnapshot =
  | { status: "idle"; key: string }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; data: BillingData; stale: boolean }
  | { status: "error"; key: string };

interface DeepSeekPrice {
  inputMiss: number;
  inputHit: number;
  output: number;
}

interface DeepSeekSessionCosts {
  cny?: number;
  usd?: number;
}

const DEEPSEEK_CNY_PRICES: Record<string, DeepSeekPrice> = {
  "deepseek-v4-flash": { inputHit: 0.02, inputMiss: 1, output: 2 },
  "deepseek-v4-pro": { inputHit: 0.025, inputMiss: 3, output: 6 },
  // Legacy compatibility aliases documented by DeepSeek.
  "deepseek-chat": { inputHit: 0.02, inputMiss: 1, output: 2 },
  "deepseek-reasoner": { inputHit: 0.02, inputMiss: 1, output: 2 },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function modelKey(model: ExtensionContext["model"]): string {
  return `${model?.provider ?? "unknown"}/${model?.id ?? "unknown"}`;
}

function formatUsdCost(costUsd: number): string {
  return `$${safeNumber(costUsd).toFixed(3)}`;
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function trimFixed(value: number, digits: number): string {
  const fixed = safeNumber(value).toFixed(digits);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatCompactNumber(value: number): string {
  const n = safeNumber(value);
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${trimFixed(n / 1_000_000_000, 1)}B`;
  if (abs >= 1_000_000) return `${trimFixed(n / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `${trimFixed(n / 1_000, 1)}k`;
  return `${trimFixed(n, 0)}`;
}

function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case "USD":
      return "$";
    case "CNY":
    case "RMB":
    case "JPY":
      return "¥";
    case "EUR":
      return "€";
    case "GBP":
      return "£";
    case "KRW":
      return "₩";
    case "INR":
      return "₹";
    case "RUB":
      return "₽";
    default:
      return `${currency.toUpperCase()} `;
  }
}

function formatBalance(data: BalanceBillingPayload, sessionCostUsd: number): string {
  if (!data.currency) return formatCompactNumber(data.amount);

  const currency = data.currency.toUpperCase();
  const symbol = currencySymbol(currency);
  const sessionCost = data.sessionCost ?? (currency === "USD"
    ? safeNumber(sessionCostUsd)
    : data.usdToCurrencyRate ? safeNumber(sessionCostUsd) * data.usdToCurrencyRate : undefined);

  if (sessionCost === undefined || !Number.isFinite(sessionCost)) {
    throw new Error("Balance display requires sessionCost or conversion rate");
  }

  const sessionDigits = currency === "USD" ? 3 : 2;
  return `${symbol}${sessionCost.toFixed(sessionDigits)}/${data.amount.toFixed(2)}`;
}

function formatBillingData(data: BillingData, sessionCostUsd: number): string {
  switch (data.kind) {
    case "balance":
      return formatBalance(data, sessionCostUsd);
    case "quota":
      return `${formatCompactNumber(data.used)}/${formatCompactNumber(data.limit)}`;
    case "unlimited":
      return "∞";
    case "unknown":
      return "?";
  }
}

function deepSeekPriceForModel(modelId: string): DeepSeekPrice | undefined {
  if (DEEPSEEK_CNY_PRICES[modelId]) return DEEPSEEK_CNY_PRICES[modelId];
  if (modelId.includes("deepseek-v4-pro")) return DEEPSEEK_CNY_PRICES["deepseek-v4-pro"];
  if (modelId.includes("deepseek-v4-flash")) return DEEPSEEK_CNY_PRICES["deepseek-v4-flash"];
  return undefined;
}

function calculateDeepSeekSessionCosts(entries: any[]): DeepSeekSessionCosts {
  let cny = 0;
  let usd = 0;
  let sawCnyUsage = false;
  let sawUsdUsage = false;

  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || message.provider !== "deepseek") continue;

    const usage = message.usage;
    if (!usage) continue;

    const price = deepSeekPriceForModel(message.model ?? "");
    if (price) {
      const cacheHitInput = safeNumber(usage.cacheRead ?? 0);
      const cacheMissInput = safeNumber(usage.input ?? 0) + safeNumber(usage.cacheWrite ?? 0);
      const output = safeNumber(usage.output ?? 0);

      cny += (cacheHitInput / TOKENS_PER_MILLION) * price.inputHit;
      cny += (cacheMissInput / TOKENS_PER_MILLION) * price.inputMiss;
      cny += (output / TOKENS_PER_MILLION) * price.output;
      sawCnyUsage = true;
    }

    const usdCost = finiteNumber(usage.cost?.total);
    if (usdCost !== undefined) {
      usd += usdCost;
      sawUsdUsage = true;
    }
  }

  return {
    ...(sawCnyUsage ? { cny } : {}),
    ...(sawUsdUsage ? { usd } : {}),
  };
}

function withDeepSeekSessionCost(data: BillingData, ctx: ExtensionContext): BillingData {
  if (data.kind !== "balance" || !data.currency) return data;

  const currency = data.currency.toUpperCase();
  const costs = calculateDeepSeekSessionCosts(ctx.sessionManager.getBranch());
  const sessionCost = currency === "CNY"
    ? costs.cny ?? 0
    : currency === "USD"
      ? costs.usd ?? 0
      : undefined;
  return sessionCost === undefined ? data : { ...data, sessionCost };
}

function parseDeepSeekBalance(value: unknown): BalanceBillingPayload {
  if (!isObject(value)) throw new Error("DeepSeek balance response must be an object");
  const infos = Array.isArray(value.balance_infos) ? value.balance_infos : [];
  const cnyInfo = infos.find((info) => isObject(info) && String(info.currency ?? "").toUpperCase() === "CNY");
  const selected = cnyInfo ?? infos.find(isObject);
  if (!isObject(selected)) throw new Error("DeepSeek balance response has no balance info");

  const amount = finiteNumber(selected.total_balance);
  if (amount === undefined) throw new Error("DeepSeek balance response has no numeric total_balance");

  const currency = typeof selected.currency === "string" && selected.currency.trim()
    ? selected.currency.trim().toUpperCase()
    : "CNY";

  return {
    kind: "balance",
    currency,
    amount,
    ...(currency === "USD" ? { usdToCurrencyRate: 1 } : {}),
  };
}

async function fetchDeepSeekBilling(ctx: ExtensionContext, signal: AbortSignal): Promise<BillingData> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
  if (!apiKey) throw new Error("DeepSeek API key is not configured");

  const response = await fetch(DEEPSEEK_BALANCE_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`DeepSeek billing HTTP ${response.status}: ${response.statusText}`);
  }

  return parseDeepSeekBalance(await response.json());
}

function supportsBuiltInBilling(model: ExtensionContext["model"]): boolean {
  return model?.provider === "deepseek";
}

export interface BillingController {
  getDisplay(sessionCostUsd: number, model: ExtensionContext["model"]): string;
  dispose(): void;
}

export function createBillingController(ctx: ExtensionContext, onChange: () => void): BillingController {
  let snapshot: BillingSnapshot = supportsBuiltInBilling(ctx.model)
    ? { status: "loading", key: modelKey(ctx.model) }
    : { status: "idle", key: modelKey(ctx.model) };
  let currentKey = snapshot.key;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let abortController: AbortController | undefined;

  const refresh = async (model: ExtensionContext["model"]): Promise<void> => {
    if (!supportsBuiltInBilling(model)) {
      snapshot = { status: "idle", key: modelKey(model) };
      currentKey = snapshot.key;
      return;
    }
    if (inFlight) return;

    const key = modelKey(model);
    currentKey = key;
    inFlight = true;
    abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController?.abort(), BILLING_TIMEOUT_MS);

    try {
      const data = await fetchDeepSeekBilling(ctx, abortController.signal);
      if (currentKey === key) {
        snapshot = { status: "ready", key, data, stale: false };
        onChange();
      }
    } catch {
      if (currentKey === key) {
        snapshot = snapshot.status === "ready" && snapshot.key === key
          ? { ...snapshot, stale: true }
          : { status: "error", key };
        onChange();
      }
    } finally {
      clearTimeout(timeoutId);
      inFlight = false;
      abortController = undefined;
      if (currentKey !== key) void refresh(ctx.model);
    }
  };

  const ensureModel = (model: ExtensionContext["model"]): void => {
    const key = modelKey(model);
    if (key === currentKey) return;

    currentKey = key;
    snapshot = supportsBuiltInBilling(model)
      ? { status: "loading", key }
      : { status: "idle", key };
    abortController?.abort();
    void refresh(model);
  };

  void refresh(ctx.model);
  intervalId = setInterval(() => refresh(ctx.model), BILLING_REFRESH_MS);

  return {
    getDisplay(sessionCostUsd: number, model: ExtensionContext["model"]): string {
      ensureModel(model);

      try {
        switch (snapshot.status) {
          case "idle":
          case "loading":
          case "error":
            return formatUsdCost(sessionCostUsd);
          case "ready": {
            const data = model?.provider === "deepseek" ? withDeepSeekSessionCost(snapshot.data, ctx) : snapshot.data;
            return `${formatBillingData(data, sessionCostUsd)}${snapshot.stale ? "*" : ""}`;
          }
        }
      } catch {
        return formatUsdCost(sessionCostUsd);
      }
    },
    dispose(): void {
      if (intervalId) clearInterval(intervalId);
      abortController?.abort();
    },
  };
}
