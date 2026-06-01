/**
 * HTML conversion utilities
 *
 * Zero-dependency HTML → Markdown/Text conversion using regex.
 * Extracted from the webfetch tool for reuse across extensions.
 */

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
 * Convert HTML to a simplified Markdown-like format.
 * Handles headings, paragraphs, lists, links, emphasis, code blocks, and tables.
 */
export function convertHTMLToMarkdown(html: string): string {
  // Remove content inside blacklisted tags
  let md = html.replace(
    new RegExp(`<(${[...STRIP_TAGS].join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"),
    "",
  );

  // Self-closing / void elements → newline
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Headings
  md = md.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, content: string) => {
    const text = stripTags(content);
    return `\n${"#".repeat(Number(level))} ${text}\n`;
  });

  // Paragraphs and divs
  md = md.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
  md = md.replace(/<div\b[^>]*>([\s\S]*?)<\/div>/gi, "\n$1\n");

  // Lists
  md = md.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, content: string) => {
    return `- ${stripTags(content).trim()}\n`;
  });
  md = md.replace(/<\/?[uo]l\b[^>]*>/gi, "\n");

  // Links
  md = md.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Bold / italic
  md = md.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  md = md.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

  // Inline code
  md = md.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Pre/code blocks
  md = md.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, content: string) => {
    const code = stripTags(content).trim();
    return `\n\`\`\`\n${code}\n\`\`\`\n`;
  });

  // Table cells — simple row/column separation
  md = md.replace(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi, " $1 |");
  md = md.replace(/<\/tr>/gi, "\n");

  // Remove all remaining tags
  md = stripTags(md);

  // Decode HTML entities
  md = md
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Clean up whitespace
  md = md.replace(/[ \t]+/g, " ");
  md = md.replace(/\n{3,}/g, "\n\n");
  md = md.trim();

  return md;
}

/** Check if a MIME type is a raster image (not SVG) */
export function isRasterImage(mime: string): boolean {
  return mime.startsWith("image/") && !mime.includes("svg");
}
