/**
 * Shared working-tip registry for Wow.
 *
 * Feature extensions own their own tip text and register it here. Visual layers
 * read the merged registry to present lightweight, UI-only tips while pi is
 * working. Tips are never written to session state or provider context.
 */

export interface WowTip {
  /** Stable id unique within the package. Prefer "feature-topic". */
  id: string;
  /** Owning feature/extension. Added by registerWowTips(). */
  feature: string;
  /** Short one-line text suitable for the Working message. */
  short: string;
  /** Optional longer explanation reserved for future guide surfaces. */
  detail?: string;
  /** Optional grouping hints for future selectors. */
  tags?: readonly string[];
  /** Higher priority tips appear earlier in the stable carousel order. */
  priority?: number;
}

export type WowTipInput = Omit<WowTip, "feature"> & { feature?: string };

interface WowTipsStore {
  tipsByFeature: Map<string, WowTip[]>;
}

const WOW_TIPS_STORE_KEY = Symbol.for("wow.tips.registry");

function getStore(): WowTipsStore {
  const globalStore = globalThis as any;
  const store = (globalStore[WOW_TIPS_STORE_KEY] ??= {
    tipsByFeature: new Map<string, WowTip[]>(),
  }) as Partial<WowTipsStore>;

  store.tipsByFeature ??= new Map<string, WowTip[]>();
  return store as WowTipsStore;
}

function normalizeTip(feature: string, tip: WowTipInput): WowTip | undefined {
  const id = tip.id.trim();
  const short = tip.short.replace(/\s+/g, " ").trim();
  if (!id || !short) return undefined;

  return {
    ...tip,
    id,
    feature,
    short,
    detail: tip.detail?.trim() || undefined,
    tags: tip.tags ? [...tip.tags] : undefined,
    priority: typeof tip.priority === "number" && Number.isFinite(tip.priority) ? tip.priority : undefined,
  };
}

/**
 * Register or replace all tips for a feature.
 *
 * Calling this repeatedly for the same feature is safe: the latest declaration
 * wins, which keeps hot reloads from duplicating tips.
 */
export function registerWowTips(feature: string, tips: readonly WowTipInput[]): () => void {
  const normalizedFeature = feature.trim();
  if (!normalizedFeature) return () => {};

  const normalizedTips = tips
    .map((tip) => normalizeTip(normalizedFeature, tip))
    .filter((tip): tip is WowTip => tip !== undefined);

  const store = getStore();
  store.tipsByFeature.set(normalizedFeature, normalizedTips);
  return () => {
    if (store.tipsByFeature.get(normalizedFeature) === normalizedTips) {
      store.tipsByFeature.delete(normalizedFeature);
    }
  };
}

export function clearWowTips(feature?: string): void {
  const store = getStore();
  if (feature) {
    store.tipsByFeature.delete(feature);
    return;
  }
  store.tipsByFeature.clear();
}

export function getWowTips(): WowTip[] {
  const tips = [...getStore().tipsByFeature.values()].flat();
  const seen = new Set<string>();

  return tips
    .filter((tip) => {
      if (seen.has(tip.id)) return false;
      seen.add(tip.id);
      return true;
    })
    .sort((a, b) => {
      const priority = (b.priority ?? 0) - (a.priority ?? 0);
      if (priority !== 0) return priority;
      const feature = a.feature.localeCompare(b.feature);
      return feature !== 0 ? feature : a.id.localeCompare(b.id);
    });
}
