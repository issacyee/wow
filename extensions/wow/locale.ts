/**
 * Locale utilities — detect OS language and build language instructions
 *
 * Unified locale detection and language mapping shared by locale-aware
 * extensions and local UI/template helpers.
 */

// ── Locale detection ──

/** Detect the full OS locale string (e.g. "zh-CN", "en-US") */
export function detectLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "en-US";
  }
}

/** Detect the primary language subtag from OS locale (e.g. "zh", "en") */
export function detectPrimaryLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.split("-")[0];
  } catch {
    return "en";
  }
}

// ── Locale → human-readable language name ──

export const LOCALE_MAP: Record<string, string> = {
  "zh": "中文",
  "zh-CN": "中文（简体）",
  "zh-Hans": "中文（简体）",
  "zh-TW": "中文（繁體）",
  "zh-HK": "中文（繁體）",
  "zh-Hant": "中文（繁體）",
  "en": "English",
  "en-US": "English",
  "en-GB": "English (UK)",
  "ja": "日本語",
  "ja-JP": "日本語",
  "ko": "한국어",
  "ko-KR": "한국어",
  "fr": "Français",
  "fr-FR": "Français",
  "de": "Deutsch",
  "de-DE": "Deutsch",
  "ru": "Русский",
  "ru-RU": "Русский",
  "es": "Español",
  "es-ES": "Español",
  "pt": "Português",
  "pt-BR": "Português (Brasil)",
  "it": "Italiano",
  "it-IT": "Italiano",
  "vi": "Tiếng Việt",
  "vi-VN": "Tiếng Việt",
  "th": "ไทย",
  "th-TH": "ไทย",
};

/**
 * Script subtag → default region tag, used when a locale carries a script but
 * no region (e.g. `zh-Hans` → `zh-CN`). Keeps the locale table keys stable.
 */
const SCRIPT_DEFAULT_REGION: Record<string, string> = {
  hans: "CN",
  hant: "TW",
};

/**
 * Normalize a BCP-47 locale so the locale table can distinguish regional
 * variants (e.g. Simplified vs Traditional Chinese) regardless of whether the
 * runtime emits a script subtag.
 *
 * Examples:
 *   zh-Hans-CN → zh-CN
 *   zh-Hant-TW → zh-TW
 *   zh-Hans    → zh-CN
 *   zh-Hant    → zh-TW
 *   en-US      → en-US
 *   zh         → zh
 */
function normalizeLocale(locale: string): string {
  if (!locale) return locale;
  const parts = locale.split("-").filter(Boolean);
  if (parts.length === 0) return locale;

  const lang = parts[0].toLowerCase();
  if (parts.length === 1) return lang;

  const second = parts[1];
  // A 4-letter second subtag is a script code (e.g. Hans, Hant).
  if (second.length === 4) {
    // lang-script-region → lang-region
    if (parts.length >= 3 && parts[2]) {
      return `${lang}-${parts[2].toUpperCase()}`;
    }
    // lang-script (no region) → lang-defaultRegion
    const defaultRegion = SCRIPT_DEFAULT_REGION[second.toLowerCase()];
    if (defaultRegion) return `${lang}-${defaultRegion}`;
    return lang;
  }

  // lang-region → normalize case to match LOCALE_MAP keys
  return `${lang}-${second.toUpperCase()}`;
}

/** Map a locale string to a human-readable language display name. */
export function localeToDisplayName(locale: string): string {
  const normalized = normalizeLocale(locale);
  return LOCALE_MAP[normalized] ?? LOCALE_MAP[normalized.split("-")[0]] ?? "English";
}

/**
 * Build the OS-locale language instruction for the system prompt.
 *
 * This is a hard directive that names the target language explicitly, so the
 * model does not have to infer the user's language from each turn (which is
 * unreliable when inputs mix natural language with English code/paths/commands).
 *
 * Prefix-cache note: on a single machine the detected OS locale is stable
 * across turns, so the produced string is byte-stable within a session and the
 * system-prompt prefix cache is unaffected. Per-turn locale probing is not used.
 */
export function buildLanguageInstruction(): string {
  const locale = detectLocale();
  const displayName = localeToDisplayName(locale);
  return (
    `[LANGUAGE] The user's OS language is ${displayName}. ` +
    `All your responses, including plans, explanations, and dialogue, must be written in ${displayName}. ` +
    `For technical identifiers, code, paths, commands, and commit messages, keep the original language and exact spelling.`
  );
}
