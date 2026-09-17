export const JOB_TYPES = {
  ANALYZE_REQUEST: "analyze_request",
  SCORE_CLUSTER: "score_cluster",
  GENERATE_BRIEF: "generate_brief",
  RESCORE_ALL: "rescore_all",
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];
