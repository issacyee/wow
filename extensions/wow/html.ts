/**
 * HTML conversion utilities
 *
 * HTML → Markdown conversion powered by node-html-markdown (AST-based).
 * Plain text extraction and tag stripping remain lightweight regex.
 */

import { NodeHtmlMarkdown } from "node-html-markdown";

/** Lazy singleton instance of NodeHtmlMarkdown */
let _nhm: NodeHtmlMarkdown | null = null;

function getNhm(): NodeHtmlMarkdown {
  if (!_nhm) {
    _nhm = new NodeHtmlMarkdown({
      bulletMarker: "-",
      codeFence: "```",
      emDelimiter: "*",
      strongDelimiter: "**",
      maxConsecutiveNewlines: 2,
      useLinkReferenceDefinitions: false,
    });
  }
  return _nhm;
}

/** Tags whose content should be completely removed */
export const STRIP_TAGS = new Set([
  "script", "style", "noscript", "iframe", "object", "embed",
  "head", "meta", "link", "svg",
]);

/**
 * Extract plain text from HTML, stripping all tags and collapsing whitespace.
 * Removes content inside script/style/noscript/etc. elements.
 */
export function extractTextFromHTML(html: string): string {
  // Remove content inside blacklisted tags
  let text = html.replace(
    new RegExp(`<(${[...STRIP_TAGS].join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"),
    "",
  );
  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();
  return text;
}

/** Strip all HTML tags from a string */
export function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/**
 * Convert HTML to Markdown using node-html-markdown (AST-based).
 * Handles nested elements, complex tables, code blocks, lists, links, etc.
 */
export function convertHTMLToMarkdown(html: string): string {
  // Pre-strip blacklisted tags to avoid processing script/style content
  let sanitized = html.replace(
    new RegExp(`<(${[...STRIP_TAGS].join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"),
    "",
  );

  // Translate using node-html-markdown
  const md = getNhm().translate(sanitized);

  // Decode remaining common HTML entities (node-html-markdown handles most,
  // but some edge cases may slip through depending on the input)
  const decoded = md
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  return decoded.trim();
}

/** Check if a MIME type is a raster image (not SVG) */
export function isRasterImage(mime: string): boolean {
  return mime.startsWith("image/") && !mime.includes("svg");
}
