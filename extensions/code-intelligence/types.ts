export const CODE_INTELLIGENCE_DISPLAY_TYPE = "wow.code-intelligence.display";
export const CODE_INTELLIGENCE_PROMOTED_TYPE = "wow.code-intelligence.promoted";

export type EvidenceStatus = "FACT" | "INFERENCE" | "UNKNOWN" | "CONFLICT";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type FindingDisposition = "open" | "accepted" | "fix-requested" | "deferred" | "needs-evidence";

export interface EvidenceItem {
  status: EvidenceStatus;
  claim: string;
  locations: string[];
  basis: string;
}

export interface UnderstandingSection {
  id: string;
  title: string;
  summary: string;
  details: string[];
  evidence: EvidenceItem[];
  dependencies: string[];
  dependencyFingerprint?: string;
  stale?: boolean;
}

export interface UnderstandingArtifact {
  version: 1;
  id: string;
  kind: "understanding";
  scope: string;
  scopeKind: "project" | "module";
  title: string;
  summary: string;
  sections: UnderstandingSection[];
  readingPath: Array<{ target: string; reason: string }>;
  unknowns: string[];
  codeGraph: "available" | "initialized" | "degraded";
  parentId?: string;
  childIds: string[];
  fingerprint: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  confidence: "high" | "medium" | "low";
  status: EvidenceStatus;
  title: string;
  claim: string;
  requirement?: string;
  evidence: string[];
  locations: string[];
  impact: string;
  counterexample?: string;
  suggestedFix?: string;
  suggestedValidation?: string;
  disposition: FindingDisposition;
}

export interface ReviewArtifact {
  version: 1;
  id: string;
  kind: "review";
  scope: string;
  title: string;
  summary: string;
  fingerprint: string;
  head: string;
  changedFiles: string[];
  requirements: string[];
  semanticChanges: string[];
  impactSurface: string[];
  findings: ReviewFinding[];
  invariants: string[];
  testGaps: string[];
  unknowns: string[];
  isolation: string;
  model: string;
  truncatedInput: boolean;
  createdAt: number;
  updatedAt: number;
}

export type CodeIntelligenceArtifact = UnderstandingArtifact | ReviewArtifact;

export interface CodeIntelligenceDisplayDetails {
  version: 1;
  artifact: CodeIntelligenceArtifact;
  cached?: boolean;
  followUp?: boolean;
}

export interface CodeIntelligencePromotedDetails {
  version: 1;
  kind: "understanding" | "review";
  artifactId: string;
  scope: string;
}
