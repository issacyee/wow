/**
 * CodeGraph output truncation helpers.
 *
 * Tool results sent to the LLM must stay bounded for prefix-cache safety.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_CODEGRAPH_CONTEXT_OUTPUT_SIZE = 32 * 1024;

export interface TruncatedOutput {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
}

export async function truncateCodeGraphOutput(output: string): Promise<TruncatedOutput> {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes <= MAX_CODEGRAPH_CONTEXT_OUTPUT_SIZE) {
    return { text: output, truncated: false };
  }

  const dir = await mkdtemp(join(tmpdir(), "pi-codegraph-"));
  const fullOutputPath = join(dir, "output.txt");
  await writeFile(fullOutputPath, output, "utf8");

  const marker = `\n\n[codegraph output truncated: ${MAX_CODEGRAPH_CONTEXT_OUTPUT_SIZE} bytes of ${bytes} bytes.\nFull output saved to: ${fullOutputPath}]`;
  const headBudget = Math.max(0, MAX_CODEGRAPH_CONTEXT_OUTPUT_SIZE - Buffer.byteLength(marker, "utf8"));
  const head = new TextDecoder().decode(Buffer.from(output, "utf8").subarray(0, headBudget));

  return { text: head + marker, truncated: true, fullOutputPath };
}
