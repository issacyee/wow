/** Visual rendering and status presentation for code-intelligence artifacts. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { getCodeIntelligenceSnapshot } from "../code-intelligence/state.ts";
import { linkPath } from "../wow/paths.ts";
import {
  CODE_INTELLIGENCE_DISPLAY_TYPE,
  CODE_INTELLIGENCE_PROMOTED_TYPE,
  type CodeIntelligenceDisplayDetails,
  type CodeIntelligencePromotedDetails,
  type ReviewArtifact,
  type ReviewFinding,
  type UnderstandingArtifact,
} from "../code-intelligence/types.ts";

export const CODE_INTELLIGENCE_STATUS_KEY = "wow.code-intelligence";

function codeLink(target: string): string {
  const trimmed = target.trim();
  if (!/[\\/]|\.[a-z0-9]+(?::\d+)?$/iu.test(trimmed)) return trimmed;
  const match = /^(.+?)(?::(\d+)(?::\d+)?)?$/.exec(trimmed);
  return linkPath(match?.[1] ?? trimmed, process.cwd()) + (match?.[2] ? `:${match[2]}` : "");
}

function linkInlineCode(text: string): string {
  return text.replace(/`([^`]+)`/g, (_match, target: string) => codeLink(target));
}

function severityColor(severity: ReviewFinding["severity"]): string {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  if (severity === "low") return "accent";
  return "muted";
}

function renderUnderstanding(artifact: UnderstandingArtifact, expanded: boolean, theme: any): string {
  const stale = artifact.sections.filter((section) => section.stale).length;
  const lines = [
    theme.fg("accent", theme.bold(artifact.title)),
    theme.fg("dim", `understanding • ${artifact.scopeKind} • CodeGraph: ${artifact.codeGraph} • ${artifact.model}`),
    stale > 0 ? theme.fg("warning", `${stale} section(s) stale`) : theme.fg("success", "dependency fingerprints current"),
    "",
    artifact.summary,
    "",
    theme.fg("accent", theme.bold("Sections")),
    ...artifact.sections.map((section) => `${section.stale ? theme.fg("warning", "[stale]") : theme.fg("success", "[current]")} ${section.title} — ${linkInlineCode(section.summary)}`),
    "",
    theme.fg("accent", theme.bold("Recommended reading path")),
    ...artifact.readingPath.map((item, index) => `${index + 1}. ${codeLink(item.target)} — ${item.reason}`),
  ];
  if (expanded) {
    for (const section of artifact.sections) {
      lines.push("", theme.fg("accent", theme.bold(section.title)), ...section.details);
      for (const item of section.evidence) {
        lines.push(`${theme.fg(item.status === "FACT" ? "success" : item.status === "UNKNOWN" ? "warning" : "muted", `[${item.status}]`)} ${item.claim}`);
        if (item.locations.length > 0) lines.push(theme.fg("dim", `  ${item.locations.map(codeLink).join(", ")}`));
      }
    }
    if (artifact.unknowns.length > 0) lines.push("", theme.fg("warning", theme.bold("Unknowns")), ...artifact.unknowns.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

function renderFinding(finding: ReviewFinding, theme: any): string[] {
  const color = severityColor(finding.severity);
  return [
    `${theme.fg(color, theme.bold(`${finding.id} [${finding.severity}]`))} ${finding.title}`,
    theme.fg("dim", `${finding.status} • confidence ${finding.confidence} • disposition ${finding.disposition}`),
    finding.claim,
    finding.locations.length > 0 ? theme.fg("dim", finding.locations.map(codeLink).join(", ")) : "",
  ].filter(Boolean);
}

function renderReview(artifact: ReviewArtifact, expanded: boolean, theme: any): string {
  const high = artifact.findings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length;
  const lines = [
    theme.fg(high > 0 ? "warning" : "success", theme.bold(artifact.title)),
    theme.fg("dim", `independent review • ${artifact.isolation} • ${artifact.model}`),
    artifact.truncatedInput ? theme.fg("warning", "Review input was truncated; coverage is incomplete") : theme.fg("success", "Full collected diff fit the review budget"),
    "",
    artifact.summary,
    "",
    theme.fg("accent", theme.bold(`Findings (${artifact.findings.length})`)),
  ];
  for (const finding of artifact.findings) {
    lines.push(...renderFinding(finding, theme), "");
    if (expanded) {
      if (finding.evidence.length > 0) lines.push(theme.fg("accent", "Evidence"), ...finding.evidence.map((item) => `- ${item}`));
      if (finding.counterexample) lines.push(theme.fg("accent", "Counterexample"), finding.counterexample);
      if (finding.suggestedFix) lines.push(theme.fg("accent", "Suggested fix"), finding.suggestedFix);
      if (finding.suggestedValidation) lines.push(theme.fg("accent", "Suggested validation (not run)"), finding.suggestedValidation);
      lines.push("");
    }
  }
  if (expanded) {
    if (artifact.semanticChanges.length > 0) lines.push(theme.fg("accent", theme.bold("Semantic changes")), ...artifact.semanticChanges.map((item) => `- ${item}`), "");
    if (artifact.invariants.length > 0) lines.push(theme.fg("accent", theme.bold("Invariants")), ...artifact.invariants.map((item) => `- ${item}`), "");
    if (artifact.testGaps.length > 0) lines.push(theme.fg("warning", theme.bold("Suggested validation gaps (not run)")), ...artifact.testGaps.map((item) => `- ${item}`), "");
    if (artifact.unknowns.length > 0) lines.push(theme.fg("warning", theme.bold("Unknowns")), ...artifact.unknowns.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

export function updateCodeIntelligenceStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const snapshot = getCodeIntelligenceSnapshot();
  if (snapshot.phase !== "idle") {
    ctx.ui.setStatus(CODE_INTELLIGENCE_STATUS_KEY, `◇ ${snapshot.phase}${snapshot.label ? ` ${snapshot.label}` : ""}`);
    return;
  }
  const review = snapshot.activeReview;
  if (review) {
    const open = review.findings.filter((finding) => finding.disposition === "open").length;
    ctx.ui.setStatus(CODE_INTELLIGENCE_STATUS_KEY, open > 0 ? `◇ review ${open} open` : "◇ review clear");
    return;
  }
  ctx.ui.setStatus(CODE_INTELLIGENCE_STATUS_KEY, snapshot.activeUnderstanding ? "◇ understood" : undefined);
}

export function registerCodeIntelligenceRendering(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<CodeIntelligenceDisplayDetails>(CODE_INTELLIGENCE_DISPLAY_TYPE, (message, { expanded }, theme) => {
    const details = message.details;
    const artifact = details?.artifact;
    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    if (!artifact) {
      box.addChild(new Text(typeof message.content === "string" ? message.content : "Code intelligence", 0, 0));
      return box;
    }
    const metadata = [details.cached ? "cached" : undefined, details.followUp ? "follow-up" : undefined, "hidden from main context"]
      .filter(Boolean).join(" • ");
    const body = details.followUp
      ? `${theme.fg("accent", theme.bold(`Follow-up: ${artifact.title}`))}\n\n${typeof message.content === "string" ? linkInlineCode(message.content) : ""}`
      : artifact.kind === "understanding"
        ? renderUnderstanding(artifact, expanded, theme)
        : renderReview(artifact, expanded, theme);
    box.addChild(new Text(`${theme.fg("dim", metadata)}\n\n${body}`, 0, 0));
    return box;
  });

  pi.registerMessageRenderer<CodeIntelligencePromotedDetails>(CODE_INTELLIGENCE_PROMOTED_TYPE, (message, _options, theme) => {
    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${theme.fg("success", theme.bold("Code intelligence promoted"))}\n${typeof message.content === "string" ? message.content : ""}`, 0, 0));
    return box;
  });
}
