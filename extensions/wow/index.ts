/**
 * Wow — Foundational extension
 *
 * This extension serves as the shared utility layer for all other extensions
 * in the wow pi package. It bundles common, reusable functions:
 *
 *   locale.ts    — OS language detection and language instruction builder
 *   renderer.ts  — Focus-style dim rendering for custom tools
 *   paths.ts     — Path shortening and OSC 8 hyperlink creation
 *   html.ts      — HTML → Markdown/Text conversion
 *   shell.ts     — Synchronous command execution wrappers
 *   safe.ts      — Read-only bash command safety checks
 *
 * The entry itself is a no-op — it registers nothing and has no side effects.
 * Other extensions import utilities directly from the sub-modules:
 *
 *   import { detectPrimaryLocale } from "../wow/locale.ts";
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Re-export all public APIs for convenience
export {
  detectLocale,
  detectPrimaryLocale,
  localeToDisplayName,
  buildLanguageInstruction,
  buildStableLanguagePolicy,
  LOCALE_MAP,
} from "./locale.ts";

export {
  AdaptiveLine,
  AdaptiveLines,
  AdaptiveToolLine,
  createFocusRenderCall,
  focusRenderCall,
  focusRenderResult,
  type AdaptiveLineBuilder,
  type AdaptiveLineStyler,
  type AdaptiveLinesBuilder,
  type AdaptiveLinesOptions,
} from "./renderer.ts";

export {
  fitCommand,
  fitEnd,
  fitMiddle,
  fitPath,
  fitUrl,
  linkPathAdaptive,
  linkUrlAdaptive,
  shortenPath,
  linkPath,
  shortenCommand,
} from "./paths.ts";

export {
  STRIP_TAGS,
  extractTextFromHTML,
  convertHTMLToMarkdown,
  stripTags,
  isRasterImage,
} from "./html.ts";

export {
  execOrNull,
  execWithError,
} from "./shell.ts";

export {
  isSafeCommand,
} from "./safe.ts";

// ── Extension entry (no-op) ──

export default function wowExtension(_pi: ExtensionAPI): void {
  // No registration needed — this extension is a pure utility layer.
  // Other extensions import from ./wow/ sub-modules directly.
}
