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

/** Map a locale string to a human-readable language display name */
export function localeToDisplayName(locale: string): string {
  return LOCALE_MAP[locale] ?? LOCALE_MAP[locale.split("-")[0]] ?? "English";
}

/** Build the legacy locale-specific instruction string. Prefer buildStableLanguagePolicy() for LLM context. */
export function buildLanguageInstruction(): string {
  const locale = detectLocale();
  const displayName = localeToDisplayName(locale);
  return `[LANGUAGE] The user's OS language is ${displayName}. All your responses, including plans, explanations, and dialogue, must be written in ${displayName}.`;
}

/**
 * Build a byte-stable language policy for the system prompt.
 *
 * Prefix-cache rule: do not inject OS locale names into every turn. A generic
 * same-language policy stays identical across turns and still follows the user.
 */
export function buildStableLanguagePolicy(): string {
  return [
    "[LANGUAGE]",
    "Reply in the same language the user is using.",
    "For technical identifiers, code, paths, commands, and commit messages, keep the original language and exact spelling.",
  ].join("\n");
}
