/*
 * Local code understanding and independent review commands.
 *
 * Full artifacts stay outside the main provider context. Only explicit
 * :promote commands send a compact note back to the main coding session.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Message, Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLanguageInstruction } from "../wow/locale.ts";
import { collectLocalChanges, findGitRoot, hashDependencyFiles } from "../wow/git.ts";
import { readWowSetting } from "../wow/settings.ts";
import { ensureLocalDirectoryGitignore } from "../wow/gitignore.ts";
import { runCodeGraph } from "../codegraph/runner.ts";
import {
  FOLLOW_UP_SYSTEM_PROMPT,
  PROMOTE_SYSTEM_PROMPT,
  REVIEW_SCHEMA_VERSION,
  REVIEW_SYSTEM_PROMPT,
  UNDERSTANDING_SCHEMA_VERSION,
  UNDERSTANDING_SYSTEM_PROMPT,
  followUpPrompt,
  reviewUserPrompt,
  understandingUserPrompt,
} from "./prompts.ts";
import {
  clearCodeIntelligenceState,
  getActiveReview,
  getActiveUnderstanding,
  setActiveArtifact,
  setCodeIntelligencePhase,
} from "./state.ts";
import {
  artifactId,
  loadCurrentReview,
  loadCurrentUnderstanding,
  loadReview,
  loadUnderstanding,
  refreshUnderstandingStaleness,
  saveArtifact,
} from "./store.ts";
import {
  CODE_INTELLIGENCE_DISPLAY_TYPE,
  CODE_INTELLIGENCE_PROMOTED_TYPE,
  type CodeIntelligenceArtifact,
  type CodeIntelligenceDisplayDetails,
  type CodeIntelligencePromotedDetails,
  type EvidenceItem,
  type EvidenceStatus,
  type FindingDisposition,
  type FindingSeverity,
  type ReviewArtifact,
  type ReviewFinding,
  type UnderstandingArtifact,
  type UnderstandingSection,
} from "./types.ts";

const MAX_PROJECT_CONTEXT_CHARS = 22_000;
const MAX_SEMANTIC_CONTEXT_CHARS = 28_000;
const MAX_FOLLOW_UP_EVIDENCE_CHARS = 16_000;
const MAX_CONTEXT_FILE_CHARS = 8_000;
const VALID_EVIDENCE = new Set<EvidenceStatus>(["FACT", "INFERENCE", "UNKNOWN", "CONFLICT"]);
const VALID_SEVERITIES = new Set<FindingSeverity>(["critical", "high", "medium", "low", "info"]);
const VALID_DISPOSITIONS = new Set<FindingDisposition>(["open", "accepted", "fix-requested", "deferred", "needs-evidence"]);

type ReviewerModel = Model<any>;

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated]`;
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else console.log(text);
}

function textMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function extractText(response: any): string {
  return (Array.isArray(response?.content) ? response.content : [])
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

function parseJsonObject(text: string): Record<string, any> {
  const clean = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to balanced-object extraction.
  }
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = JSON.parse(clean.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  throw new Error("The reviewer did not return a valid JSON object.");
}

function strings(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, limit);
}

function evidence(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item: any) => ({
    status: VALID_EVIDENCE.has(item?.status) ? item.status : "UNKNOWN",
    claim: typeof item?.claim === "string" ? item.claim : "Unspecified claim",
    locations: strings(item?.locations, 30),
    basis: typeof item?.basis === "string" ? item.basis : "No basis supplied",
  }));
}

function sections(value: unknown, root: string): UnderstandingSection[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map((item: any, index) => {
    const dependencies = strings(item?.dependencies, 200)
      .map((path) => path.replace(/\\/g, "/"))
      .filter((path) => !path.startsWith("../"));
    return {
      id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `section-${index + 1}`,
      title: typeof item?.title === "string" ? item.title : `Section ${index + 1}`,
      summary: typeof item?.summary === "string" ? item.summary : "",
      details: strings(item?.details),
      evidence: evidence(item?.evidence),
      dependencies,
      dependencyFingerprint: hashDependencyFiles(root, dependencies),
      stale: false,
    };
  });
}

function findings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item: any, index) => ({
    id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `K-${index + 1}`,
    severity: VALID_SEVERITIES.has(item?.severity) ? item.severity : "medium",
    confidence: ["high", "medium", "low"].includes(item?.confidence) ? item.confidence : "low",
    status: VALID_EVIDENCE.has(item?.status) ? item.status : "UNKNOWN",
    title: typeof item?.title === "string" ? item.title : "Untitled finding",
    claim: typeof item?.claim === "string" ? item.claim : "",
    requirement: typeof item?.requirement === "string" ? item.requirement : undefined,
    evidence: strings(item?.evidence),
    locations: strings(item?.locations),
    impact: typeof item?.impact === "string" ? item.impact : "Unknown impact",
    counterexample: typeof item?.counterexample === "string" ? item.counterexample : undefined,
    suggestedFix: typeof item?.suggestedFix === "string" ? item.suggestedFix : undefined,
    suggestedValidation: typeof item?.suggestedValidation === "string" ? item.suggestedValidation : undefined,
    disposition: "open",
  }));
}

function parseModelSetting(value: unknown): { provider: string; id: string } | undefined {
  if (typeof value === "string") {
    const slash = value.indexOf("/");
    if (slash > 0 && slash < value.length - 1) return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
  }
  if (value && typeof value === "object") {
    const provider = (value as any).provider;
    const id = (value as any).id ?? (value as any).model;
    if (typeof provider === "string" && typeof id === "string") return { provider, id };
  }
  return undefined;
}

async function reviewerModel(ctx: ExtensionCommandContext): Promise<{ model: ReviewerModel; isolation: string } | undefined> {
  await ctx.modelRegistry.refresh();
  const configured = parseModelSetting(readWowSetting(["wow", "codeIntelligence", "reviewerModel"], { cwd: ctx.cwd }));
  if (configured) {
    const model = ctx.modelRegistry.find(configured.provider, configured.id);
    if (!model) {
      notify(ctx, `Configured reviewer model not found: ${configured.provider}/${configured.id}`, "warning");
    } else {
      const same = ctx.model?.provider === model.provider && ctx.model?.id === model.id;
      return {
        model,
        isolation: same ? "Same model + independent context" : "Different model + independent context",
      };
    }
  }
  if (!ctx.model) {
    notify(ctx, "No model selected and no wow.codeIntelligence.reviewerModel configured.", "error");
    return undefined;
  }
  return { model: ctx.model, isolation: "Same model + independent context (configured reviewer unavailable)" };
}

async function standalone(
  ctx: ExtensionCommandContext,
  systemPrompt: string,
  userPrompt: string,
  forced?: { model: ReviewerModel; isolation: string },
): Promise<{ text: string; model: ReviewerModel; isolation: string } | undefined> {
  const selected = forced ?? await reviewerModel(ctx);
  if (!selected) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selected.model);
  if (!auth.ok || !auth.apiKey) {
    notify(ctx, auth.ok ? `No API key for ${selected.model.provider}` : auth.error, "error");
    return undefined;
  }

  const response = await complete(
    selected.model,
    { systemPrompt: `${systemPrompt}\n\n${buildLanguageInstruction()}`, messages: [textMessage(userPrompt)] },
    { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
  );
  if (response.stopReason === "aborted") {
    notify(ctx, "Code-intelligence request cancelled.", "info");
    return undefined;
  }
  const text = extractText(response);
  if (!text) throw new Error("The model produced no text response.");
  return { text, model: selected.model, isolation: selected.isolation };
}

function projectFiles(root: string, directory = root, depth = 0): string[] {
  if (depth > 3) return [];
  const ignored = new Set([".git", ".codegraph", ".pi", "node_modules", "dist", "build", "coverage", ".next", ".venv", "vendor"]);
  const result: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return result;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 120)) {
    if (ignored.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).replace(/\\/g, "/") || ".";
    result.push(`${"  ".repeat(depth)}${entry.isDirectory() ? `${path}/` : path}`);
    if (entry.isDirectory()) result.push(...projectFiles(root, absolute, depth + 1));
    if (result.length >= 600) break;
  }
  return result;
}

function readContextFile(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return clip(readFileSync(path, "utf-8"), MAX_CONTEXT_FILE_CHARS);
  } catch {
    return undefined;
  }
}

function projectContext(root: string, ctx: ExtensionCommandContext): string {
  const contextFiles = ctx.getSystemPromptOptions().contextFiles ?? [];
  const sections = [
    `Repository root: ${root}`,
    `Tree (bounded depth):\n${projectFiles(root).join("\n")}`,
  ];
  for (const item of contextFiles) {
    const path = typeof item === "string" ? item : (item as any)?.path;
    const content = typeof item === "object" && typeof (item as any)?.content === "string"
      ? (item as any).content
      : typeof path === "string" ? readContextFile(path) : undefined;
    if (path && content) sections.push(`${path}:\n${clip(content, MAX_CONTEXT_FILE_CHARS)}`);
  }
  for (const name of ["README.md", "README.zh-CN.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"] as const) {
    const content = readContextFile(join(root, name));
    if (content) sections.push(`${name}:\n${content}`);
  }
  return clip(sections.join("\n\n"), MAX_PROJECT_CONTEXT_CHARS);
}

async function ensureSemanticContext(root: string, scope: string, signal?: AbortSignal): Promise<{ text: string; status: UnderstandingArtifact["codeGraph"] }> {
  let initialized = false;
  if (!existsSync(join(root, ".codegraph"))) {
    const init = await runCodeGraph(["init"], { cwd: root, timeoutSeconds: 120, signal });
    if (init.exitCode !== 0) return { text: clip(`${init.stderr}\n${init.stdout}`, 4_000), status: "degraded" };
    ensureLocalDirectoryGitignore(join(root, ".codegraph"), {
      comment: "CodeGraph data files are local to each machine. Keep this .gitignore, ignore generated contents.",
    });
    initialized = true;
  }
  await runCodeGraph(["sync"], { cwd: root, timeoutSeconds: 60, signal });
  const query = scope === "."
    ? "Explain this project's architecture, modules, entry points, lifecycle, key flows, extension points, tests, risks, and a recommended reading path."
    : `Explain the scope ${scope}: responsibility, boundaries, callers, consumers, key symbols/state, control and data flow, invariants, impact, risks, and reading path.`;
  const explored = await runCodeGraph(["explore", query], { cwd: root, timeoutSeconds: 120, signal });
  if (explored.exitCode !== 0) return { text: clip(`${explored.stderr}\n${explored.stdout}`, 4_000), status: "degraded" };
  return { text: clip(explored.stdout, MAX_SEMANTIC_CONTEXT_CHARS), status: initialized ? "initialized" : "available" };
}

async function reviewSemanticContext(root: string, scope: string, files: string[], signal?: AbortSignal): Promise<string> {
  if (!existsSync(join(root, ".codegraph"))) return "[CodeGraph index unavailable; review uses diff/project evidence only]";
  await runCodeGraph(["sync"], { cwd: root, timeoutSeconds: 60, signal });
  const fileList = files.slice(0, 80).join(", ");
  const query = `Review impact context for local changes in scope ${scope}. Changed files: ${fileList}. Identify callers, consumers, contracts, data/state flow, and likely blast radius. Do not assess test results.`;
  const explored = await runCodeGraph(["explore", query], { cwd: root, timeoutSeconds: 120, signal });
  return explored.exitCode === 0
    ? clip(explored.stdout, MAX_SEMANTIC_CONTEXT_CHARS)
    : `[CodeGraph review context degraded]\n${clip(`${explored.stderr}\n${explored.stdout}`, 4_000)}`;
}

async function resolveUnderstandScope(args: string, ctx: ExtensionCommandContext): Promise<{ scope: string; scopeKind: "project" | "module" } | undefined> {
  const explicit = args.trim();
  if (explicit) return { scope: explicit, scopeKind: explicit === "." ? "project" : "module" };
  if (!ctx.hasUI) return { scope: ".", scopeKind: "project" };
  const choice = await ctx.ui.select("Understand scope", ["Whole project", "Module / path / symbol / feature"]);
  if (!choice) return undefined;
  if (choice === "Whole project") return { scope: ".", scopeKind: "project" };
  const scope = await ctx.ui.input("Module, path, symbol, or feature", "extensions/codegraph or authentication flow");
  return scope?.trim() ? { scope: scope.trim(), scopeKind: "module" } : undefined;
}

function displayArtifact(pi: ExtensionAPI, artifact: CodeIntelligenceArtifact, options: { cached?: boolean; followUp?: boolean } = {}): void {
  const details: CodeIntelligenceDisplayDetails = { version: 1, artifact, ...options };
  pi.sendMessage({
    customType: CODE_INTELLIGENCE_DISPLAY_TYPE,
    content: artifact.summary,
    display: true,
    details,
  }, { triggerTurn: false });
}

function latestPlanAndRequirements(ctx: ExtensionCommandContext): string {
  const branch = ctx.sessionManager.getBranch() as any[];
  const sections: string[] = [];
  const recentUserRequirements: string[] = [];
  let foundPlan = false;
  for (let i = branch.length - 1; i >= 0 && sections.join("\n").length < 16_000; i--) {
    const entry = branch[i];
    if (!foundPlan && entry?.type === "custom" && entry.customType === "human-led-coding-workflow") {
      const plan = entry.data?.planFullText;
      if (typeof plan === "string" && plan.trim()) {
        sections.push(`Active/recent HLCW plan:\n${clip(plan, 10_000)}`);
        foundPlan = true;
      }
    }
    if (recentUserRequirements.length < 6 && entry?.type === "message" && entry.message?.role === "user") {
      const content = entry.message.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("\n")
          : "";
      if (text.trim()) recentUserRequirements.unshift(clip(text.trim(), 2_500));
    }
  }
  if (recentUserRequirements.length > 0) {
    sections.push(`Recent user requirement context:\n${recentUserRequirements.map((text, index) => `${index + 1}. ${text}`).join("\n\n")}`);
  }
  const options = ctx.getSystemPromptOptions();
  for (const file of options.contextFiles ?? []) {
    const path = typeof file === "string" ? file : (file as any)?.path;
    const content = typeof file === "object" ? (file as any)?.content : undefined;
    if (path && content) sections.push(`${path}:\n${clip(String(content), 5_000)}`);
  }
  return clip(sections.join("\n\n"), 18_000);
}

function modelLabel(model: ReviewerModel): string {
  return `${model.provider}/${model.id}`;
}

async function runUnderstand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const requested = await resolveUnderstandScope(args, ctx);
  if (!requested) return;
  const root = findGitRoot(ctx.cwd) ?? ctx.cwd;
  const cached = loadUnderstanding(root, requested.scope);
  if (cached) {
    const refreshed = refreshUnderstandingStaleness(root, cached);
    const hasStale = refreshed.sections.some((section) => section.stale);
    if (!hasStale) {
      setActiveArtifact(refreshed);
      displayArtifact(pi, refreshed, { cached: true });
      notify(ctx, `Reused cached understanding for ${requested.scope}.`, "info");
      return;
    }
  }

  setCodeIntelligencePhase("understanding", requested.scope);
  notify(ctx, `Building understanding for ${requested.scope}...`, "info");
  try {
    const semantic = await ensureSemanticContext(root, requested.scope, ctx.signal);
    const result = await standalone(
      ctx,
      UNDERSTANDING_SYSTEM_PROMPT,
      understandingUserPrompt({
        ...requested,
        projectContext: projectContext(root, ctx),
        semanticContext: semantic.text,
        previous: cached ? refreshUnderstandingStaleness(root, cached) : undefined,
      }),
    );
    if (!result) return;
    const raw = parseJsonObject(result.text);
    const now = Date.now();
    const artifact: UnderstandingArtifact = {
      version: 1,
      id: artifactId("understanding", `${requested.scope}\0${Date.now()}\0${UNDERSTANDING_SCHEMA_VERSION}`),
      kind: "understanding",
      scope: requested.scope,
      scopeKind: requested.scopeKind,
      title: typeof raw.title === "string" ? raw.title : `Understanding: ${requested.scope}`,
      summary: typeof raw.summary === "string" ? raw.summary : "",
      sections: sections(raw.sections, root),
      readingPath: Array.isArray(raw.readingPath) ? raw.readingPath.slice(0, 50).map((item: any) => ({
        target: typeof item?.target === "string" ? item.target : "",
        reason: typeof item?.reason === "string" ? item.reason : "",
      })).filter((item: any) => item.target) : [],
      unknowns: strings(raw.unknowns),
      codeGraph: semantic.status,
      childIds: cached?.childIds ?? [],
      fingerprint: createHash("sha256").update(JSON.stringify(sections(raw.sections, root).map((item) => item.dependencyFingerprint))).digest("hex"),
      model: modelLabel(result.model),
      createdAt: cached?.createdAt ?? now,
      updatedAt: now,
    };
    saveArtifact(root, artifact);
    setActiveArtifact(artifact);
    displayArtifact(pi, artifact);
  } catch (error: any) {
    notify(ctx, `Understanding failed: ${error?.message ?? String(error)}`, "error");
  } finally {
    setCodeIntelligencePhase("idle");
  }
}

async function askAboutArtifact(
  pi: ExtensionAPI,
  kind: "understanding" | "review",
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const root = findGitRoot(ctx.cwd) ?? ctx.cwd;
  const artifact: CodeIntelligenceArtifact | undefined = kind === "understanding"
    ? getActiveUnderstanding() ?? loadCurrentUnderstanding(root)
    : getActiveReview() ?? loadCurrentReview(root);
  if (!artifact) {
    notify(ctx, `No current ${kind} artifact. Run /${kind === "understanding" ? "understand" : "review"} first.`, "warning");
    return;
  }
  let question = args.trim();
  if (!question && ctx.hasUI) question = (await ctx.ui.input(`Ask about ${artifact.title}`, "Question"))?.trim() ?? "";
  if (!question) {
    notify(ctx, `Usage: /${kind === "understanding" ? "understand" : "review"}:ask <question>`, "info");
    return;
  }

  setCodeIntelligencePhase("asking", artifact.scope);
  try {
    const semantic = kind === "understanding"
      ? (await ensureSemanticContext(root, `${artifact.scope}: ${question}`, ctx.signal)).text
      : "";
    const result = await standalone(ctx, FOLLOW_UP_SYSTEM_PROMPT, followUpPrompt(artifact, question, clip(semantic, MAX_FOLLOW_UP_EVIDENCE_CHARS)));
    if (!result) return;
    pi.sendMessage({
      customType: CODE_INTELLIGENCE_DISPLAY_TYPE,
      content: result.text,
      display: true,
      details: { version: 1, artifact, followUp: true } satisfies CodeIntelligenceDisplayDetails,
    }, { triggerTurn: false });

    if (artifact.kind === "understanding") {
      const childScope = `${artifact.scope} :: ${clip(question, 160)}`;
      const now = Date.now();
      const dependencies = [...result.text.matchAll(/`([^`]+)`/g)]
        .map((match) => match[1]!.replace(/:\d+(?::\d+)?$/, "").replace(/\\/g, "/"))
        .filter((path) => existsSync(join(root, path)));
      const child: UnderstandingArtifact = {
        ...artifact,
        id: artifactId("understanding", `${childScope}\0${now}`),
        scope: childScope,
        scopeKind: "module",
        title: question,
        summary: result.text,
        sections: [{
          id: "follow-up",
          title: question,
          summary: result.text,
          details: [],
          evidence: [],
          dependencies,
          dependencyFingerprint: hashDependencyFiles(root, dependencies),
          stale: false,
        }],
        readingPath: [],
        unknowns: [],
        parentId: artifact.id,
        childIds: [],
        fingerprint: createHash("sha256").update(result.text).digest("hex"),
        model: modelLabel(result.model),
        createdAt: now,
        updatedAt: now,
      };
      const parent: UnderstandingArtifact = {
        ...artifact,
        childIds: [...new Set([...artifact.childIds, child.id])],
        updatedAt: now,
      };
      saveArtifact(root, parent);
      saveArtifact(root, child);
      setActiveArtifact(child);
    }
  } catch (error: any) {
    notify(ctx, `Follow-up failed: ${error?.message ?? String(error)}`, "error");
  } finally {
    setCodeIntelligencePhase("idle");
  }
}

async function runReview(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const scope = args.trim() || ".";
  const changes = collectLocalChanges(ctx.cwd, scope === "." ? undefined : scope);
  if (!changes) {
    notify(ctx, "Unable to establish a Git HEAD/worktree baseline for review.", "error");
    return;
  }
  if (changes.files.length === 0) {
    notify(ctx, `No staged, unstaged, or untracked changes found in scope: ${scope}`, "info");
    return;
  }
  const selected = await reviewerModel(ctx);
  if (!selected) return;
  const model = modelLabel(selected.model);
  const cacheKey = createHash("sha256").update([
    changes.fingerprint,
    scope,
    model,
    REVIEW_SCHEMA_VERSION,
    latestPlanAndRequirements(ctx),
  ].join("\0")).digest("hex");
  const cached = loadReview(changes.root, cacheKey);
  if (cached) {
    setActiveArtifact(cached);
    displayArtifact(pi, cached, { cached: true });
    notify(ctx, "Reused cached review: code fingerprint unchanged.", "info");
    return;
  }

  setCodeIntelligencePhase("reviewing", scope);
  notify(ctx, `Reviewing ${changes.files.length} local changed file(s) with ${model}...`, "info");
  try {
    const semantic = await reviewSemanticContext(changes.root, scope, changes.files.map((file) => file.path), ctx.signal);
    const result = await standalone(
      ctx,
      REVIEW_SYSTEM_PROMPT,
      reviewUserPrompt({
        scope,
        requirements: latestPlanAndRequirements(ctx),
        projectContext: `${projectContext(changes.root, ctx)}\n\nSemantic impact evidence:\n${semantic}`,
        changedFiles: changes.files.map((file) => `${file.status} ${file.path}`),
        diff: changes.diffExcerpt,
        truncated: changes.truncated,
      }),
      selected,
    );
    if (!result) return;
    const raw = parseJsonObject(result.text);
    const now = Date.now();
    const artifact: ReviewArtifact = {
      version: 1,
      id: artifactId("review", cacheKey),
      kind: "review",
      scope,
      title: typeof raw.title === "string" ? raw.title : `Review: ${scope}`,
      summary: typeof raw.summary === "string" ? raw.summary : "",
      fingerprint: changes.fingerprint,
      head: changes.head,
      changedFiles: changes.files.map((file) => file.path),
      requirements: strings(raw.requirements),
      semanticChanges: strings(raw.semanticChanges),
      impactSurface: strings(raw.impactSurface),
      findings: findings(raw.findings),
      invariants: strings(raw.invariants),
      testGaps: strings(raw.testGaps),
      unknowns: strings(raw.unknowns),
      isolation: selected.isolation,
      model,
      truncatedInput: changes.truncated,
      createdAt: now,
      updatedAt: now,
    };
    saveArtifact(changes.root, artifact, cacheKey);
    setActiveArtifact(artifact);
    displayArtifact(pi, artifact);
  } catch (error: any) {
    notify(ctx, `Review failed: ${error?.message ?? String(error)}`, "error");
  } finally {
    setCodeIntelligencePhase("idle");
  }
}

async function promoteArtifact(pi: ExtensionAPI, kind: "understanding" | "review", ctx: ExtensionCommandContext): Promise<void> {
  const root = findGitRoot(ctx.cwd) ?? ctx.cwd;
  const artifact: CodeIntelligenceArtifact | undefined = kind === "understanding"
    ? getActiveUnderstanding() ?? loadCurrentUnderstanding(root)
    : getActiveReview() ?? loadCurrentReview(root);
  if (!artifact) {
    notify(ctx, `No current ${kind} artifact to promote.`, "warning");
    return;
  }
  try {
    const result = await standalone(ctx, PROMOTE_SYSTEM_PROMPT, JSON.stringify(artifact));
    if (!result) return;
    let approved = true;
    if (ctx.hasUI) approved = await ctx.ui.confirm(`Promote ${artifact.title}?`, `${result.text}\n\nThis concise note will enter the main agent context.`);
    if (!approved) return;
    const details: CodeIntelligencePromotedDetails = { version: 1, kind, artifactId: artifact.id, scope: artifact.scope };
    pi.sendMessage({
      customType: CODE_INTELLIGENCE_PROMOTED_TYPE,
      content: `[Code intelligence promoted: ${artifact.title}]\n${result.text}`,
      display: true,
      details,
    }, { triggerTurn: false });
  } catch (error: any) {
    notify(ctx, `Promotion failed: ${error?.message ?? String(error)}`, "error");
  }
}

async function disposeFinding(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const root = findGitRoot(ctx.cwd) ?? ctx.cwd;
  const review = getActiveReview() ?? loadCurrentReview(root);
  if (!review) {
    notify(ctx, "No current review.", "warning");
    return;
  }
  const [requestedId, requestedDisposition] = args.trim().split(/\s+/, 2);
  let finding = review.findings.find((item) => item.id.toLowerCase() === requestedId?.toLowerCase());
  if (!finding && ctx.hasUI) {
    const choice = await ctx.ui.select("Select review finding", review.findings.map((item) => `${item.id} [${item.severity}] ${item.title}`));
    finding = review.findings.find((item) => choice?.startsWith(`${item.id} `));
  }
  if (!finding) {
    notify(ctx, "Usage: /review:dispose <finding-id> [accepted|fix-requested|deferred|needs-evidence]", "info");
    return;
  }
  let disposition = VALID_DISPOSITIONS.has(requestedDisposition as FindingDisposition)
    ? requestedDisposition as FindingDisposition
    : undefined;
  if (!disposition && ctx.hasUI) {
    disposition = await ctx.ui.select("Finding disposition", ["accepted", "fix-requested", "deferred", "needs-evidence"]) as FindingDisposition | undefined;
  }
  if (!disposition || disposition === "open") return;
  const updated: ReviewArtifact = {
    ...review,
    findings: review.findings.map((item) => item.id === finding!.id ? { ...item, disposition } : item),
    updatedAt: Date.now(),
  };
  saveArtifact(root, updated);
  setActiveArtifact(updated);
  displayArtifact(pi, updated, { cached: true });
}

export default function codeIntelligenceExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    clearCodeIntelligenceState();
    const root = findGitRoot(ctx.cwd) ?? ctx.cwd;
    const understanding = loadCurrentUnderstanding(root);
    const review = loadCurrentReview(root);
    if (understanding) setActiveArtifact(refreshUnderstandingStaleness(root, understanding));
    if (review) setActiveArtifact(review);
  });

  pi.on("context", async (event) => {
    const messages = event.messages.filter((message: any) =>
      message?.customType !== CODE_INTELLIGENCE_DISPLAY_TYPE
    );
    if (messages.length !== event.messages.length) return { messages };
  });

  pi.registerCommand("understand", {
    description: "Build or reuse a project/module mental model",
    handler: async (args, ctx) => runUnderstand(pi, args, ctx),
  });
  pi.registerCommand("understand:ask", {
    description: "Ask a follow-up about the current understanding artifact",
    handler: async (args, ctx) => askAboutArtifact(pi, "understanding", args, ctx),
  });
  pi.registerCommand("understand:promote", {
    description: "Promote a concise understanding summary into main context",
    handler: async (_args, ctx) => promoteArtifact(pi, "understanding", ctx),
  });
  pi.registerCommand("review", {
    description: "Independently review local staged, unstaged, and untracked changes",
    handler: async (args, ctx) => runReview(pi, args, ctx),
  });
  pi.registerCommand("review:ask", {
    description: "Ask a follow-up about the current review artifact",
    handler: async (args, ctx) => askAboutArtifact(pi, "review", args, ctx),
  });
  pi.registerCommand("review:promote", {
    description: "Promote a concise review summary into main context",
    handler: async (_args, ctx) => promoteArtifact(pi, "review", ctx),
  });
  pi.registerCommand("review:dispose", {
    description: "Record a human disposition for a review finding",
    handler: async (args, ctx) => disposeFinding(pi, args, ctx),
  });

  pi.on("session_shutdown", async () => {
    setCodeIntelligencePhase("idle");
  });
}
