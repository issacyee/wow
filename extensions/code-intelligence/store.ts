import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureLocalDirectoryGitignore } from "../wow/gitignore.ts";
import { hashDependencyFiles } from "../wow/git.ts";
import type { CodeIntelligenceArtifact, ReviewArtifact, UnderstandingArtifact } from "./types.ts";

const STORE_VERSION = 1;

interface StoreIndex {
  version: 1;
  currentUnderstanding?: string;
  currentReview?: string;
  understandingByScope: Record<string, string>;
  reviewByKey: Record<string, string>;
}

function emptyIndex(): StoreIndex {
  return { version: STORE_VERSION, understandingByScope: {}, reviewByKey: {} };
}

export function artifactId(kind: "understanding" | "review", key: string): string {
  return `${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

export function storageDirectory(root: string): string {
  return join(root, ".pi", "wow", "code-intelligence");
}

function artifactsDirectory(root: string): string {
  return join(storageDirectory(root), "artifacts");
}

function indexPath(root: string): string {
  return join(storageDirectory(root), "index.json");
}

function readJson<T>(path: string): T | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return value && typeof value === "object" ? value as T : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function ensureStorage(root: string): void {
  const dir = storageDirectory(root);
  mkdirSync(artifactsDirectory(root), { recursive: true });
  ensureLocalDirectoryGitignore(dir, {
    comment: "Wow code-intelligence cache. Keep this .gitignore, ignore generated artifacts.",
  });
}

function loadIndex(root: string): StoreIndex {
  const value = readJson<StoreIndex>(indexPath(root));
  if (!value || value.version !== STORE_VERSION) return emptyIndex();
  value.understandingByScope ??= {};
  value.reviewByKey ??= {};
  return value;
}

function saveIndex(root: string, index: StoreIndex): void {
  ensureStorage(root);
  writeJson(indexPath(root), index);
}

export function saveArtifact(root: string, artifact: CodeIntelligenceArtifact, cacheKey?: string): void {
  ensureStorage(root);
  writeJson(join(artifactsDirectory(root), `${artifact.id}.json`), artifact);
  const index = loadIndex(root);
  if (artifact.kind === "understanding") {
    index.currentUnderstanding = artifact.id;
    index.understandingByScope[artifact.scope] = artifact.id;
  } else {
    index.currentReview = artifact.id;
    if (cacheKey) index.reviewByKey[cacheKey] = artifact.id;
  }
  saveIndex(root, index);
}

export function loadArtifact(root: string, id: string | undefined): CodeIntelligenceArtifact | undefined {
  if (!id) return undefined;
  return readJson<CodeIntelligenceArtifact>(join(artifactsDirectory(root), `${id}.json`));
}

export function loadCurrentUnderstanding(root: string): UnderstandingArtifact | undefined {
  const artifact = loadArtifact(root, loadIndex(root).currentUnderstanding);
  return artifact?.kind === "understanding" ? artifact : undefined;
}

export function loadUnderstanding(root: string, scope: string): UnderstandingArtifact | undefined {
  const artifact = loadArtifact(root, loadIndex(root).understandingByScope[scope]);
  return artifact?.kind === "understanding" ? artifact : undefined;
}

export function loadCurrentReview(root: string): ReviewArtifact | undefined {
  const artifact = loadArtifact(root, loadIndex(root).currentReview);
  return artifact?.kind === "review" ? artifact : undefined;
}

export function loadReview(root: string, cacheKey: string): ReviewArtifact | undefined {
  const artifact = loadArtifact(root, loadIndex(root).reviewByKey[cacheKey]);
  return artifact?.kind === "review" ? artifact : undefined;
}

export function refreshUnderstandingStaleness(root: string, artifact: UnderstandingArtifact): UnderstandingArtifact {
  let changed = false;
  const sections = artifact.sections.map((section) => {
    const fingerprint = hashDependencyFiles(root, section.dependencies);
    const stale = !!section.dependencyFingerprint && section.dependencyFingerprint !== fingerprint;
    if (stale !== !!section.stale) changed = true;
    return { ...section, stale, dependencyFingerprint: section.dependencyFingerprint ?? fingerprint };
  });
  if (!changed) return artifact;
  return { ...artifact, sections, updatedAt: Date.now() };
}

export function listArtifacts(root: string): CodeIntelligenceArtifact[] {
  const dir = artifactsDirectory(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson<CodeIntelligenceArtifact>(join(dir, name)))
    .filter((value): value is CodeIntelligenceArtifact => !!value)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
