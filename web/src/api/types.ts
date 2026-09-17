export type SubmitterType = "customer" | "prospect" | "support" | "internal";
export type CustomerTier = "enterprise" | "growth" | "starter" | "free";
export type RequestStatus = "received" | "analyzing" | "analyzed" | "failed";
export type ClusterStatus =
  | "new"
  | "under_review"
  | "planned"
  | "in_progress"
  | "shipped"
  | "declined";
export type Severity = "blocker" | "major" | "moderate" | "minor";

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
  rationaleStale: boolean;
  model: string;
  createdAt: string;
}

export interface RequestAnalysis {
  requestId: string;
  underlyingNeed: string;
  jobToBeDone: string;
  problemSummary: string;
  severity: Severity;
  urgency: number;
  sentiment: "frustrated" | "neutral" | "enthusiastic";
  strategicAlignment: number;
  suggestedTeam: string;
  suggestedProductArea: string;
  tags: string[];
  confidence: number;
  reasoning: string;
  model: string;
  createdAt: string;
}

export interface Theme {
  id: string;
  name: string;
  description: string;
  productArea: string;
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

export interface RequestListItem extends FeatureRequest {
  submitterName: string;
  submitterType: SubmitterType;
  underlyingNeed: string | null;
  severity: Severity | null;
  cluster: {
    id: string;
    title: string;
    status: ClusterStatus;
    themeId: string | null;
    score: number | null;
    supporterCount: number;
    memberCount: number;
  } | null;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SupportSignal {
  id: string;
  impactText: string;
  currentWorkaround: string | null;
  submitterName: string;
  submitterType: SubmitterType;
  submitterTier: CustomerTier | null;
  accountName: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  entityType: string;
  entityId: string;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RequestDetail {
  request: FeatureRequest;
  submitter: {
    id: string;
    name: string;
    type: SubmitterType;
    tier: CustomerTier | null;
    accountName: string | null;
  } | null;
  analysis: RequestAnalysis | null;
  cluster: {
    id: string;
    title: string;
    canonicalNeed: string;
    status: ClusterStatus;
    theme: Theme | null;
    score: PriorityScore | null;
    memberCount: number;
    supporterCount: number;
  } | null;
  mergeDecision: {
    decidedBy: "ai" | "human";
    confidence: number;
    rationale: string;
  } | null;
  relatedRequests: Array<{
    id: string;
    title: string;
    createdAt: string;
    rationale: string | null;
  }>;
  supportSignals: SupportSignal[];
  timeline: AuditEvent[];
}

export interface RankedCluster {
  clusterId: string;
  title: string;
  canonicalNeed: string;
  status: ClusterStatus;
  themeId: string | null;
  themeName: string | null;
  productArea: string | null;
  owningTeam: string | null;
  score: number;
  components: ScoreComponents;
  rationale: string;
  requestCount: number;
  supporterCount: number;
  distinctAccounts: number;
  totalArrUsd: number;
  topSegment: string | null;
  updatedAt: string;
}

export interface ThemeBreakdown {
  themeId: string | null;
  themeName: string;
  productArea: string;
  clusterCount: number;
  requestCount: number;
  averageScore: number;
  topScore: number;
  topClusters: Array<{ clusterId: string; title: string; score: number }>;
}

export interface DashboardData {
  topClusters: RankedCluster[];
  byTheme: ThemeBreakdown[];
  volumeTrend: Array<{
    period: string;
    total: number;
    bySubmitterType: Record<SubmitterType, number>;
  }>;
  submitterMix: Array<{ type: SubmitterType; requests: number; supporters: number }>;
  scoreDistribution: Array<{ label: string; count: number }>;
  metrics: {
    totalRequests: number;
    totalClusters: number;
    consolidationRate: number;
    duplicatesAbsorbed: number;
    analysedRequests: number;
    pendingAnalysis: number;
    pendingMergeReviews: number;
    medianTimeToPrioritisationSeconds: number | null;
    rationaleCompleteness: {
      scoredClusters: number;
      withRationale: number;
      withEvidence: number;
      withBrief: number;
      percent: number;
    };
    aiUsageByStage: Array<{
      stage: string;
      calls: number;
      cacheHits: number;
      inputTokens: number;
      outputTokens: number;
      avgLatencyMs: number;
      failures: number;
    }>;
    jobs: Record<string, number>;
  };
}

export interface MergeSuggestion {
  id: string;
  requestId: string;
  targetClusterId: string;
  verdict: "duplicate" | "related";
  confidence: number;
  rationale: string;
  requestTitle: string;
  targetClusterTitle: string;
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
  createdAt: string;
}

export interface ClusterDetail {
  cluster: {
    id: string;
    title: string;
    canonicalNeed: string;
    status: ClusterStatus;
    owningTeam: string | null;
    theme: Theme | null;
  };
  score: PriorityScore | null;
  scoreHistory: PriorityScore[];
  brief: DecisionBrief | null;
  updates: StakeholderUpdate[];
  supportSignals: SupportSignal[];
  requests: Array<{
    id: string;
    title: string;
    description: string;
    createdAt: string;
    submitter: {
      name: string;
      type: SubmitterType;
      tier: CustomerTier | null;
      accountName: string | null;
    } | null;
    analysis: RequestAnalysis | null;
    mergeRationale: string | null;
  }>;
  timeline: AuditEvent[];
}

export interface EmergingNeeds {
  trends: Array<{
    title: string;
    description: string;
    signalStrength: "watch" | "building" | "urgent";
    evidenceClusterIds: string[];
    affectedSegments: string[];
    whyNow: string;
  }>;
  summary: string;
  model: string;
  cached?: boolean;
  createdAt?: string;
}

export interface SubmitterInput {
  name: string;
  email?: string;
  type: SubmitterType;
  tier?: CustomerTier;
  accountName?: string;
  arrUsd?: number;
}
