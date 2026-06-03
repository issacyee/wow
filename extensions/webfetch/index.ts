/**
 * WebFetch Tool — fetch web content and convert to markdown/text/html
 *
 * Ported from opencode's built-in webfetch tool. Uses Node.js native fetch.
 * HTML conversion powered by node-html-markdown (AST-based).
 *
 * Parameters:
 *   url     — The URL to fetch content from (required)
 *   format  — "markdown" (default), "text", or "html"
 *   timeout — Optional timeout in seconds (max 120)
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { createFocusRenderCall, focusRenderResult } from "../wow/renderer.ts";
import {
  extractTextFromHTML,
  convertHTMLToMarkdown,
  isRasterImage,
} from "../wow/html.ts";

// ── Constants ──

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB fetch limit
const MAX_CONTEXT_OUTPUT_SIZE = 32 * 1024; // 32KB sent back to the LLM
const DEFAULT_TIMEOUT = 30 * 1000; // 30 seconds
const MAX_TIMEOUT = 120 * 1000; // 2 minutes

// ── Output truncation ──

async function truncateForContext(output: string): Promise<{ text: string; truncated: boolean; fullOutputPath?: string }> {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes <= MAX_CONTEXT_OUTPUT_SIZE) {
    return { text: output, truncated: false };
  }

  const dir = await mkdtemp(join(tmpdir(), "pi-webfetch-"));
  const fullOutputPath = join(dir, "output.txt");
  await writeFile(fullOutputPath, output, "utf8");

  const marker = `\n\n[webfetch output truncated: ${MAX_CONTEXT_OUTPUT_SIZE} bytes of ${bytes} bytes.\nFull output saved to: ${fullOutputPath}]`;
  const headBudget = Math.max(0, MAX_CONTEXT_OUTPUT_SIZE - Buffer.byteLength(marker, "utf8"));
  const head = new TextDecoder().decode(Buffer.from(output, "utf8").subarray(0, headBudget));

  return { text: head + marker, truncated: true, fullOutputPath };
}

// ── Tool definition ──

const webfetchTool = defineTool({
  name: "webfetch",
  label: "WebFetch",
  description: [
    "Fetches content from a specified URL.",
    "Takes a URL and optional format as input.",
    "Fetches the URL content, converts to requested format (markdown by default).",
    "Returns the content in the specified format.",
    "Use this tool when you need to retrieve and analyze web content.",
    "",
    "Usage notes:",
    '  - The URL must be a fully-formed valid URL starting with http:// or https://',
    '  - Format options: "markdown" (default), "text", or "html"',
    "  - This tool is read-only and does not modify any files",
    "  - Results are truncated to 32KB in LLM context; full output is saved to a temp file when truncated",
  ].join("\n"),
  promptSnippet: "Fetch web content from a URL and return as markdown, text, or html",
  promptGuidelines: [
    "Use webfetch when you need to retrieve and read web page content, documentation, or any URL.",
    "webfetch converts HTML to markdown by default for optimal readability.",
  ],
  parameters: Type.Object({
    url: Type.String({ description: "The URL to fetch content from" }),
    format: StringEnum(["text", "markdown", "html"] as const, {
      description: 'The format to return the content in. Defaults to "markdown".',
      default: "markdown",
    }),
    timeout: Type.Optional(
      Type.Number({ description: "Optional timeout in seconds (max 120)" }),
    ),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
    // Validate URL scheme
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://");
    }

    const timeoutMs = Math.min(
      (params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000,
      MAX_TIMEOUT,
    );

    // Build Accept header based on requested format
    let acceptHeader: string;
    switch (params.format) {
      case "markdown":
        acceptHeader =
          "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
        break;
      case "text":
        acceptHeader =
          "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
        break;
      case "html":
        acceptHeader =
          "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
        break;
      default:
        acceptHeader =
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
    }

    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      Accept: acceptHeader,
      "Accept-Language": "en-US,en;q=0.9",
    };

    // Create abort signal with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Also forward parent signal if provided
    if (signal) {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(params.url, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error("Request timed out");
      }
      throw err;
    }

    // Retry with honest UA if blocked by Cloudflare bot detection
    if (
      response.status === 403 &&
      response.headers.get("cf-mitigated") === "challenge"
    ) {
      const retryHeaders = { ...headers, "User-Agent": "opencode" };
      try {
        response = await fetch(params.url, {
          method: "GET",
          headers: retryHeaders,
          signal: controller.signal,
          redirect: "follow",
        });
      } catch (err: any) {
        if (err.name === "AbortError") {
          throw new Error("Request timed out");
        }
        throw err;
      }
    }

    clearTimeout(timeoutId);

    // Check HTTP status
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check content length
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5MB limit)");
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 5MB limit)");
    }

    const contentType = response.headers.get("content-type") || "";
    const mime = contentType.split(";")[0]?.trim().toLowerCase() || "";

    // Handle raster image responses
    if (isRasterImage(mime)) {
      const base64Content = Buffer.from(arrayBuffer).toString("base64");
      return {
        content: [
          {
            type: "text" as const,
            text: `Image fetched: ${params.url} (${contentType})`,
          },
        ],
        details: {
          url: params.url,
          contentType,
          imageBase64: `data:${mime};base64,${base64Content}`,
        },
      };
    }

    const content = new TextDecoder().decode(arrayBuffer);

    // Handle content based on requested format and actual content type
    let output: string;
    switch (params.format) {
      case "markdown":
        if (contentType.includes("text/html")) {
          output = convertHTMLToMarkdown(content);
        } else {
          output = content;
        }
        break;
      case "text":
        if (contentType.includes("text/html")) {
          output = extractTextFromHTML(content);
        } else {
          output = content;
        }
        break;
      case "html":
        output = content;
        break;
      default:
        output = content;
    }

    const truncated = await truncateForContext(output);

    return {
      content: [{ type: "text" as const, text: truncated.text }],
      details: {
        url: params.url,
        contentType,
        format: params.format,
        truncated: truncated.truncated,
        fullOutputPath: truncated.fullOutputPath,
      },
    };
  },

  renderShell: "self",
  renderCall: createFocusRenderCall("webfetch"),
  renderResult: focusRenderResult,
});

// ── Extension entry ──

export default function (pi: ExtensionAPI): void {
  pi.registerTool(webfetchTool);
}
