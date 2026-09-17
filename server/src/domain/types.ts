/**
 * Domain vocabulary shared by the repositories, services and API layer.
 *
 * These are `as const` arrays rather than TS enums so they can be reused for
 * runtime validation (zod) and for SQL CHECK constraints without drifting.
 */

export const SUBMITTER_TYPES = ["customer", "prospect", "support", "internal"] as const;
export type SubmitterType = (typeof SUBMITTER_TYPES)[number];

export const CUSTOMER_TIERS = ["enterprise", "growth", "starter", "free"] as const;
export type CustomerTier = (typeof CUSTOMER_TIERS)[number];

export const REQUEST_STATUSES = ["received", "analyzing", "analyzed", "failed"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const CLUSTER_STATUSES = [
  "new",
  "under_review",
  "planned",
  "in_progress",
  "shipped",
  "declined",
] as const;
export type ClusterStatus = (typeof CLUSTER_STATUSES)[number];

export const SEVERITY_LEVELS = ["blocker", "major", "moderate", "minor"] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export const SENTIMENTS = ["frustrated", "neutral", "enthusiastic"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const DECISION_ACTORS = ["ai", "human"] as const;
export type DecisionActor = (typeof DECISION_ACTORS)[number];

export interface Submitter {
  id: string;
  name: string;
  email: string | null;
  type: SubmitterType;
  tier: CustomerTier | null;
  accountName: string | null;
  arrUsd: number | null;
  createdAt: string;
}

export interface FeatureRequest {
  id: string;
  title: string;
  description: string;
  submitterId: string;
  clusterId: string | null;
  status: RequestStatus;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/** Cached per-request output of the need-extraction stage. */
export interface RequestAnalysis {
  requestId: string;
  underlyingNeed: string;
  jobToBeDone: string;
  problemSummary: string;
  severity: SeverityLevel;
  urgency: number;
  sentiment: Sentiment;
  strategicAlignment: number;
  suggestedTeam: string;
  suggestedProductArea: string;
  tags: string[];
  confidence: number;
  reasoning: string;
  model: string;
  promptVersion: string;
  createdAt: string;
}

export interface Theme {
  id: string;
  name: string;
  description: string;
  productArea: string;
  createdAt: string;
}

export interface Cluster {
  id: string;
  title: string;
  canonicalNeed: string;
  themeId: string | null;
  status: ClusterStatus;
  owningTeam: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Why a request ended up in a cluster - the audit record behind a merge. */
export interface ClusterDecision {
  id: string;
  clusterId: string;
  requestId: string;
  decidedBy: DecisionActor;
  confidence: number;
  rationale: string;
  overriddenFromClusterId: string | null;
  createdAt: string;
}

export interface ScoreComponents {
  submitterWeight: number;
  reach: number;
  severity: number;
  strategicAlignment: number;
  urgency: number;
}

export interface PriorityScore {
  id: string;
  clusterId: string;
  total: number;
  components: ScoreComponents;
  rationale: string;
  evidence: string[];
  weightsVersion: string;
  inputsFingerprint: string;
  evidenceFingerprint: string;
  /** The rationale was carried forward from an earlier score under different weights. */
  rationaleStale: boolean;
  model: string;
  createdAt: string;
}

/**
 * Replaces the anonymous upvote. A supporter must describe the impact, which
 * becomes evidence the scoring stage reads - see README "Beyond upvoting".
 */
export interface SupportSignal {
  id: string;
  clusterId: string;
  requestId: string;
  submitterId: string;
  impactText: string;
  currentWorkaround: string | null;
  createdAt: string;
}

export interface DecisionBrief {
  id: string;
  clusterId: string;
  problem: string;
  evidence: string[];
  affectedSegments: string[];
  recommendedPriority: string;
  suggestedNextStep: string;
  risksIfIgnored: string;
  openQuestions: string[];
  status: "draft" | "approved";
  approvedBy: string | null;
  model: string;
  createdAt: string;
}

export interface StakeholderUpdate {
  id: string;
  clusterId: string;
  audience: string;
  subject: string;
  body: string;
  status: "draft" | "sent";
  model: string;
  createdAt: string;
}
