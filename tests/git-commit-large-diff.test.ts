// Regression test: staged diffs larger than Node.js' default execSync buffer
// must remain readable when the git-commit extension supplies its larger limit.
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execWithError } from "../extensions/wow/shell.ts";

const repo = mkdtempSync(join(tmpdir(), "wow-git-commit-test-"));
const quote = (value: string): string => `"${value.replaceAll('"', '\\"')}"`;
const git = (args: string): string => `git -C ${quote(repo)} ${args}`;

try {
  execSync(git("init --quiet"));

  const largeContent = Array.from(
    { length: 40_000 },
    (_, index) => `generated documentation line ${index.toString().padStart(5, "0")} with enough content to exceed the default buffer`,
  ).join("\n");
  writeFileSync(join(repo, "large.txt"), `${largeContent}\n`, "utf-8");
  execSync(git("add large.txt"));

  const defaultResult = execWithError(git("diff --cached"));
  if (defaultResult.errorCode !== "ENOBUFS") {
    throw new Error(`expected default buffer to fail with ENOBUFS, got ${defaultResult.errorCode ?? "success"}`);
  }

  const enlargedResult = execWithError(git("diff --cached"), {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (enlargedResult.exitCode !== 0) {
    throw new Error(`enlarged buffer failed: ${enlargedResult.stderr || enlargedResult.errorCode}`);
  }
  if (Buffer.byteLength(enlargedResult.stdout, "utf-8") <= 1024 * 1024) {
    throw new Error("fixture did not produce a diff larger than the default buffer");
  }

  console.log("OK: staged diff larger than 1MiB is readable with the git-commit buffer limit");
} finally {
  rmSync(repo, { recursive: true, force: true });
}
