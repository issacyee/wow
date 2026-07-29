import type { ReviewArtifact, UnderstandingArtifact } from "./types.ts";

export const UNDERSTANDING_SCHEMA_VERSION = "understanding-v1";
export const REVIEW_SCHEMA_VERSION = "review-v1";

export const UNDERSTANDING_SYSTEM_PROMPT = `You build evidence-backed mental models of software projects for a human developer.

Rules:
- Analyze only the supplied repository evidence. Never invent files, symbols, behavior, or test results.
- Separate direct facts, inferences, unknowns, and conflicts.
- Optimize for a human who wants a useful overview first, then an efficient reading path.
- A project scope emphasizes architecture, modules, entry points, lifecycle, major flows, extension points, tests, risks, and unknowns.
- A module scope emphasizes responsibility, boundaries, callers/consumers, key types/functions/state, control/data flow, invariants, modification impact, and unknowns.
- Preserve technical identifiers exactly.
- Output valid JSON only, with no markdown fence or preamble.

JSON shape:
{
  "title": "string",
  "summary": "string",
  "sections": [{
    "id": "stable-kebab-id",
    "title": "string",
    "summary": "string",
    "details": ["string"],
    "evidence": [{ "status": "FACT|INFERENCE|UNKNOWN|CONFLICT", "claim": "string", "locations": ["path[:line]"], "basis": "string" }],
    "dependencies": ["repository-relative file path"]
  }],
  "readingPath": [{ "target": "path or symbol", "reason": "string" }],
  "unknowns": ["string"]
}`;

export const REVIEW_SYSTEM_PROMPT = `You independently review local uncommitted code for a human developer.

Rules:
- Analyze only supplied evidence. Do not claim that you ran tests, lint, type checking, or any command.
- The implementation agent's statements, if present, are claims to verify rather than facts.
- Find production-relevant correctness, requirement, compatibility, security, concurrency, data-integrity, error-handling, and maintainability risks. Avoid style-only noise.
- Separate FACT, INFERENCE, UNKNOWN, and CONFLICT.
- For core paths, state useful invariants and concrete counterexamples.
- If requirements are missing or ambiguous, record UNKNOWN instead of guessing.
- A suggested validation is not an executed validation.
- Preserve technical identifiers exactly.
- Output valid JSON only, with no markdown fence or preamble.

JSON shape:
{
  "title": "string",
  "summary": "string",
  "requirements": ["string"],
  "semanticChanges": ["string"],
  "impactSurface": ["string"],
  "findings": [{
    "id": "K-1",
    "severity": "critical|high|medium|low|info",
    "confidence": "high|medium|low",
    "status": "FACT|INFERENCE|UNKNOWN|CONFLICT",
    "title": "string",
    "claim": "string",
    "requirement": "optional string",
    "evidence": ["string"],
    "locations": ["path[:line]"],
    "impact": "string",
    "counterexample": "optional string",
    "suggestedFix": "optional string",
    "suggestedValidation": "optional string"
  }],
  "invariants": ["string"],
  "testGaps": ["string"],
  "unknowns": ["string"]
}`;

export const FOLLOW_UP_SYSTEM_PROMPT = `Answer a human's follow-up question about a previously generated code-intelligence artifact.
Use only the artifact and supplemental evidence supplied. Distinguish facts, inferences, and unknowns. Preserve technical identifiers. Be concise but evidence-backed. Reply in the user's language.`;

export const PROMOTE_SYSTEM_PROMPT = `Compress a code-intelligence artifact into a short note for the main coding-agent context.
Include scope, code fingerprint, key conclusions, high-risk findings, and unknowns. Preserve technical identifiers. Output only the note, without preamble.`;

export function understandingUserPrompt(input: {
  scope: string;
  scopeKind: "project" | "module";
  projectContext: string;
  semanticContext: string;
  previous?: UnderstandingArtifact;
}): string {
  return [
    `Scope kind: ${input.scopeKind}`,
    `Requested scope: ${input.scope}`,
    input.previous ? `Previous artifact (refresh only stale/affected knowledge; return a complete updated artifact):\n${JSON.stringify(input.previous)}` : undefined,
    `Project evidence:\n${input.projectContext}`,
    `Semantic evidence:\n${input.semanticContext || "[CodeGraph unavailable; evidence is degraded]"}`,
  ].filter(Boolean).join("\n\n");
}

export function reviewUserPrompt(input: {
  scope: string;
  requirements: string;
  projectContext: string;
  changedFiles: string[];
  diff: string;
  truncated: boolean;
}): string {
  return [
    `Review scope: ${input.scope}`,
    `Requirements and project constraints:\n${input.requirements || "[Requirements unavailable: mark requirement-fit conclusions UNKNOWN]"}`,
    `Project context:\n${input.projectContext}`,
    `Changed files:\n${input.changedFiles.map((path) => `- ${path}`).join("\n") || "(none)"}`,
    `Local change evidence${input.truncated ? " (TRUNCATED: explicitly account for incomplete evidence)" : ""}:\n${input.diff || "(empty)"}`,
  ].join("\n\n");
}

export function followUpPrompt(artifact: UnderstandingArtifact | ReviewArtifact, question: string, evidence?: string): string {
  return [
    `Artifact:\n${JSON.stringify(artifact)}`,
    evidence ? `Supplemental evidence:\n${evidence}` : undefined,
    `Question:\n${question}`,
  ].filter(Boolean).join("\n\n");
}
