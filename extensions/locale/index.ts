/**
 * Locale — detect OS language and inject it into AI context
 *
 * The AI cannot query the OS locale itself. This extension detects the user's
 * OS language at runtime via Intl.DateTimeFormat and injects a language
 * instruction into every agent turn via before_agent_start, ensuring the AI
 * always responds in the user's language.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Locale detection ──

function detectLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "en-US";
  }
}

// ── Locale → human-readable language name ──

const LOCALE_MAP: Record<string, string> = {
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

function localeToDisplayName(locale: string): string {
  return LOCALE_MAP[locale] ?? LOCALE_MAP[locale.split("-")[0]] ?? "English";
}

function buildLanguageInstruction(): string {
  const locale = detectLocale();
  const displayName = localeToDisplayName(locale);
  return `[LANGUAGE] The user's OS language is ${displayName}. All your responses, including plans, explanations, and dialogue, must be written in ${displayName}.`;
}

// ── Extension entry ──

export default function localeExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (_event) => {
    const instruction = buildLanguageInstruction();
    return {
      message: {
        customType: "locale-instruction",
        content: instruction,
        display: false,
      },
    };
  });
}
