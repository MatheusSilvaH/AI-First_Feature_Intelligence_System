import { z } from "zod";
import {
  CLUSTER_STATUSES,
  CUSTOMER_TIERS,
  REQUEST_STATUSES,
  SUBMITTER_TYPES,
} from "../domain/types.js";
import { ScoringConfigSchema } from "../services/scoring/config.js";

export const SubmitterInputSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320).optional(),
  type: z.enum(SUBMITTER_TYPES),
  tier: z.enum(CUSTOMER_TIERS).optional(),
  accountName: z.string().min(1).max(200).optional(),
  arrUsd: z.number().nonnegative().max(1_000_000_000).optional(),
});

export const CreateRequestSchema = z.object({
  // Long enough to carry a real problem statement, bounded so one submission
  // cannot blow out a model call's input budget.
  title: z.string().trim().min(5).max(200),
  description: z.string().trim().min(20).max(8_000),
  submitter: SubmitterInputSchema,
  source: z.string().max(50).optional(),
});

export const ListRequestsQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(REQUEST_STATUSES).optional(),
  submitterType: z.enum(SUBMITTER_TYPES).optional(),
  themeId: z.string().max(100).optional(),
  clusterId: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const SupportRequestSchema = z.object({
  impactText: z
    .string()
    .trim()
    .min(15, "Describe how this affects you - a bare vote carries no information.")
    .max(2_000),
  currentWorkaround: z.string().trim().max(1_000).optional(),
  submitter: SubmitterInputSchema,
});

export const UpdateClusterStatusSchema = z.object({
  status: z.enum(CLUSTER_STATUSES),
  actor: z.string().min(1).max(100).default("product-team"),
});

export const SplitRequestSchema = z.object({
  reason: z.string().trim().min(5).max(1_000),
  actor: z.string().min(1).max(100).default("product-team"),
});

export const ResolveSuggestionSchema = z.object({
  actor: z.string().min(1).max(100).default("product-team"),
});

export const ReviseBriefSchema = z.object({
  problem: z.string().trim().min(10).max(4_000).optional(),
  evidence: z.array(z.string().max(500)).max(10).optional(),
  affectedSegments: z.array(z.string().max(100)).max(10).optional(),
  recommendedPriority: z.enum(["now", "next", "later", "decline"]).optional(),
  suggestedNextStep: z.string().trim().max(1_000).optional(),
  risksIfIgnored: z.string().trim().max(2_000).optional(),
  openQuestions: z.array(z.string().max(500)).max(10).optional(),
  approve: z.boolean().default(false),
  actor: z.string().min(1).max(100).default("product-team"),
});

export const GenerateUpdateSchema = z.object({
  audience: z.string().trim().min(2).max(100).default("requesters"),
  note: z.string().trim().max(2_000).default(""),
});

export const TopClustersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  themeId: z.string().max(100).optional(),
  status: z.enum(CLUSTER_STATUSES).optional(),
});

export const TrendQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(365).default(90),
});

export const EmergingQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(7).max(180).default(30),
  refresh: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export const UpdateScoringConfigSchema = z.object({
  config: ScoringConfigSchema,
  actor: z.string().min(1).max(100).default("product-team"),
});
