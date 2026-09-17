import type {
  ClusterDetail,
  DashboardData,
  DecisionBrief,
  EmergingNeeds,
  MergeSuggestion,
  Paginated,
  RankedCluster,
  RequestDetail,
  RequestListItem,
  StakeholderUpdate,
  SubmitterInput,
  SubmitterType,
  RequestStatus,
} from "./types";

/**
 * The only network layer in the app. Every call goes to our own Node backend -
 * the browser has no Anthropic credentials and never talks to the model
 * directly.
 */

const BASE = "/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code: string; message: string; details?: [] } })?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "unknown",
      error?.message ?? response.statusText,
      error?.details,
    );
  }

  return payload as T;
}

/**
 * A per-submission key so a double-click or a retry after a timeout cannot
 * create two requests. Generated client-side because only the client knows
 * which attempts are the same user action.
 */
const idempotencyKey = () => crypto.randomUUID();

export const api = {
  health: () =>
    call<{ status: string; aiMode: string; queueDepth: number }>("/health"),

  listRequests: (params: {
    search?: string;
    status?: RequestStatus;
    submitterType?: SubmitterType;
    themeId?: string;
    page?: number;
    pageSize?: number;
  }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return call<Paginated<RequestListItem>>(`/requests?${query.toString()}`);
  },

  getRequest: (id: string) => call<RequestDetail>(`/requests/${id}`),

  submitRequest: (body: {
    title: string;
    description: string;
    submitter: SubmitterInput;
  }) =>
    call<{ request: { id: string }; analysisStatus: string; message: string }>("/requests", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify(body),
    }),

  supportRequest: (
    id: string,
    body: { impactText: string; currentWorkaround?: string; submitter: SubmitterInput },
  ) =>
    call<{ signal: { id: string } }>(`/requests/${id}/support`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify(body),
    }),

  splitRequest: (id: string, reason: string) =>
    call<{ clusterId: string }>(`/requests/${id}/split`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  getCluster: (id: string) => call<ClusterDetail>(`/clusters/${id}`),

  setClusterStatus: (id: string, status: string) =>
    call<unknown>(`/clusters/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  generateBrief: (clusterId: string) =>
    call<DecisionBrief>(`/clusters/${clusterId}/brief`, { method: "POST" }),

  generateUpdate: (clusterId: string, audience: string, note: string) =>
    call<StakeholderUpdate>(`/clusters/${clusterId}/updates`, {
      method: "POST",
      body: JSON.stringify({ audience, note }),
    }),

  approveBrief: (briefId: string) =>
    call<DecisionBrief>(`/review/briefs/${briefId}/revise`, {
      method: "POST",
      body: JSON.stringify({ approve: true }),
    }),

  markUpdateSent: (updateId: string) =>
    call<StakeholderUpdate>(`/review/updates/${updateId}/sent`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  listMergeSuggestions: () =>
    call<{ suggestions: MergeSuggestion[] }>("/review/merge-suggestions"),

  acceptMerge: (id: string) =>
    call<{ merged: boolean }>(`/review/merge-suggestions/${id}/accept`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  rejectMerge: (id: string) =>
    call<{ merged: boolean }>(`/review/merge-suggestions/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  dashboard: (days = 90) => call<DashboardData>(`/analytics/dashboard?days=${days}`),

  topClusters: (params: { limit?: number; themeId?: string } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    return call<{ clusters: RankedCluster[] }>(`/analytics/top?${query.toString()}`);
  },

  emergingNeeds: (refresh = false) =>
    call<EmergingNeeds>(`/analytics/emerging?refresh=${refresh}`),

  themes: () => call<{ themes: Array<{ id: string; name: string }> }>("/clusters"),
};
