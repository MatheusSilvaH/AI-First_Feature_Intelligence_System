import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, keepPreviousData } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api/client";
import { useDebounced } from "../hooks/useDebounced";
import type { RankedCluster } from "../api/types";
import {
  AiPanel,
  Badge,
  ComponentBars,
  Empty,
  ErrorNotice,
  Loading,
  ScorePill,
  formatUsd,
  relativeTime,
} from "../components/common";

/**
 * Colour-blind-safe categorical palette. Used consistently across every chart
 * so a submitter type keeps the same colour wherever it appears.
 */
const SERIES = {
  customer: "#4ec98a",
  prospect: "#6aa2ff",
  support: "#e8b750",
  internal: "#9aa4b5",
} as const;

const axisStyle = { fontSize: 11, fill: "var(--text-faint)" };

const tooltipStyle = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--text)",
};

export function DashboardPage() {
  const query = useQuery({ queryKey: ["dashboard"], queryFn: () => api.dashboard(90) });

  if (query.isLoading) return <Loading rows={4} />;
  if (query.isError) return <ErrorNotice error={query.error} />;
  if (!query.data) return null;

  const { byTheme, volumeTrend, submitterMix, metrics } = query.data;

  if (metrics.totalRequests === 0) {
    return (
      <Empty>
        <p>No requests yet, so there is nothing to rank.</p>
        <Link to="/submit">Submit one</Link>
      </Empty>
    );
  }

  return (
    <>
      <div className="page-header">
        <h1>Stakeholder dashboard</h1>
        <p>
          Everything below ranks consolidated needs, not individual requests. Expand any row to see
          the reasoning behind its score.
        </p>
      </div>

      <section className="grid grid-4" style={{ marginBottom: "1.5rem" }}>
        <div className="metric">
          <div className="value">{metrics.totalRequests}</div>
          <div className="label">Requests received</div>
          <div className="sub">{metrics.analysedRequests} analysed</div>
        </div>
        <div className="metric">
          <div className="value">{metrics.totalClusters}</div>
          <div className="label">Distinct needs</div>
          <div className="sub">
            {metrics.duplicatesAbsorbed} duplicate{metrics.duplicatesAbsorbed === 1 ? "" : "s"}{" "}
            consolidated
          </div>
        </div>
        <div className="metric">
          <div className="value">{metrics.consolidationRate}%</div>
          <div className="label">Consolidation rate</div>
          <div className="sub">Share of requests folded into an existing need</div>
        </div>
        <div className="metric">
          <div className="value">
            {metrics.medianTimeToPrioritisationSeconds === null
              ? "–"
              : formatDuration(metrics.medianTimeToPrioritisationSeconds)}
          </div>
          <div className="label">Median time to priority</div>
          <div className="sub">Submission → scored and ranked</div>
        </div>
        <div className="metric">
          <div className="value">{metrics.rationaleCompleteness.percent}%</div>
          <div className="label">Rationale completeness</div>
          <div className="sub">
            {metrics.rationaleCompleteness.withBrief} of{" "}
            {metrics.rationaleCompleteness.scoredClusters} also have a decision brief
          </div>
        </div>
      </section>

      {metrics.pendingMergeReviews > 0 ? (
        <div className="notice info" style={{ marginBottom: "1.5rem" }}>
          {metrics.pendingMergeReviews} merge{metrics.pendingMergeReviews === 1 ? "" : "s"} need a
          human decision. <Link to="/review">Open the review queue →</Link>
        </div>
      ) : null}

      <ClusterExplorer />

      {/* --- by theme --- */}
      <section className="card">
        <div className="spread">
          <h2>By theme</h2>
          <span className="faint small">Themes are derived from the requests themselves</span>
        </div>
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={byTheme.map((t) => ({
                name: t.themeName,
                top: t.topScore,
                average: t.averageScore,
                requests: t.requestCount,
              }))}
              layout="vertical"
              margin={{ left: 8, right: 16, top: 8, bottom: 8 }}
            >
              <CartesianGrid horizontal={false} stroke="var(--border)" />
              <XAxis type="number" domain={[0, 100]} tick={axisStyle} stroke="var(--border)" />
              <YAxis
                type="category"
                dataKey="name"
                width={150}
                tick={axisStyle}
                stroke="var(--border)"
              />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--bg-sunken)" }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="top" name="Top score" fill={SERIES.prospect} radius={[0, 3, 3, 0]} />
              <Bar dataKey="average" name="Average" fill={SERIES.internal} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="grid grid-3" style={{ marginTop: "1rem" }}>
          {byTheme.map((theme) => (
            <div key={theme.themeId ?? "unassigned"} className="card">
              <h3>{theme.themeName}</h3>
              <p className="faint small">
                {theme.clusterCount} need{theme.clusterCount === 1 ? "" : "s"} ·{" "}
                {theme.requestCount} request{theme.requestCount === 1 ? "" : "s"}
              </p>
              <ul className="evidence">
                {theme.topClusters.map((c) => (
                  <li key={c.clusterId}>
                    {c.title} <span className="faint">({Math.round(c.score)})</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* --- trends --- */}
      <div className="grid grid-2">
        <section className="card">
          <h2>Request volume over time</h2>
          <p className="faint small">Daily submissions by submitter type</p>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={volumeTrend.map((p) => ({
                  period: p.period.slice(5),
                  ...p.bySubmitterType,
                }))}
                margin={{ left: 0, right: 12, top: 8, bottom: 8 }}
              >
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="period" tick={axisStyle} stroke="var(--border)" />
                <YAxis allowDecimals={false} tick={axisStyle} stroke="var(--border)" />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {(Object.keys(SERIES) as Array<keyof typeof SERIES>).map((key) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stroke={SERIES[key]}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card">
          <h2>Who is asking</h2>
          <p className="faint small">Requests filed and impact descriptions added</p>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={submitterMix}
                margin={{ left: 0, right: 12, top: 8, bottom: 8 }}
              >
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="type" tick={axisStyle} stroke="var(--border)" />
                <YAxis allowDecimals={false} tick={axisStyle} stroke="var(--border)" />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--bg-sunken)" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="requests" name="Requests" radius={[3, 3, 0, 0]}>
                  {submitterMix.map((entry) => (
                    <Cell key={entry.type} fill={SERIES[entry.type]} />
                  ))}
                </Bar>
                <Bar
                  dataKey="supporters"
                  name="Supporters"
                  fill="var(--border-strong)"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <EmergingNeedsSection />

      <details className="card" style={{ marginTop: "1rem" }}>
        <summary>AI usage and cost telemetry</summary>
        <table style={{ width: "100%", fontSize: "0.85rem", marginTop: "0.8rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-faint)" }}>
              <th>Stage</th>
              <th>Calls</th>
              <th>Cache hits</th>
              <th>Input tok</th>
              <th>Output tok</th>
              <th>Avg ms</th>
              <th>Failures</th>
            </tr>
          </thead>
          <tbody>
            {metrics.aiUsageByStage.map((s) => (
              <tr key={s.stage}>
                <td>{s.stage}</td>
                <td>{s.calls}</td>
                <td>{s.cacheHits}</td>
                <td>{s.inputTokens.toLocaleString()}</td>
                <td>{s.outputTokens.toLocaleString()}</td>
                <td>{s.avgLatencyMs}</td>
                <td>{s.failures}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

const PAGE_SIZE = 10;

/**
 * The ranked cluster list: searchable, paged, and deep-linkable.
 *
 * URL contract (all optional, all shareable and reload-safe):
 *   ?q=<text>        active title filter
 *   ?page=<n>        1-based page within the filtered ranking
 *   ?cluster=<id>    a cluster to locate and open, wherever it ranks
 *
 * Search and paging are resolved server-side against the whole dataset - see
 * `api.rankedClusters`. The client never holds the full list, so it cannot and
 * does not filter locally.
 */
function ClusterExplorer() {
  const [params, setParams] = useSearchParams();

  const urlSearch = params.get("q") ?? "";
  const focusId = params.get("cluster");
  const urlPage = Math.max(1, Number(params.get("page") ?? 1) || 1);

  // The input stays immediate so typing never feels laggy; only the fetch waits.
  const [searchInput, setSearchInput] = useState(urlSearch);
  const search = useDebounced(searchInput, 250);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [missingCluster, setMissingCluster] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["ranked-clusters", { search, page: urlPage, focus: focusId }],
    queryFn: () =>
      api.rankedClusters({
        search: search || undefined,
        page: urlPage,
        pageSize: PAGE_SIZE,
        focus: focusId ?? undefined,
      }),
    // Keeps the current page on screen while the next loads, rather than
    // collapsing the list to a spinner on every keystroke.
    placeholderData: keepPreviousData,
  });

  const data = query.data;
  const focus = data?.focus ?? null;

  // Reconcile a deep link against what the server resolved. Runs once per
  // response; every write here is `replace`, so arriving via a cluster link
  // leaves exactly one history entry and Back returns to the request page.
  useEffect(() => {
    if (!focus) return;

    if (!focus.found) {
      setMissingCluster(focus.clusterId);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("cluster");
          return next;
        },
        { replace: true },
      );
      return;
    }

    setMissingCluster(null);
    setExpanded(focus.clusterId);

    // The server serves the focused cluster's real page regardless of what we
    // asked for; bring the URL into line so a reload lands in the same place.
    if (focus.page && focus.page !== urlPage) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("page", String(focus.page));
          return next;
        },
        { replace: true },
      );
    }
  }, [focus, urlPage, setParams]);

  // Bring the focused row into view once it has actually rendered.
  useEffect(() => {
    if (!focusId || !data) return;
    const el = document.getElementById(`cluster-${focusId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, data]);

  /** Typing is browsing: it resets paging and cancels any deep-link focus. */
  const onSearchChange = (value: string) => {
    setSearchInput(value);
    setMissingCluster(null);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value.trim()) next.set("q", value);
        else next.delete("q");
        next.delete("page");
        next.delete("cluster");
        return next;
      },
      // Replace, or every keystroke would become a history entry.
      { replace: true },
    );
  };

  /**
   * Explicit page changes push, so Back steps through pages. The focus param
   * is dropped: leaving it would make the server keep serving the focused
   * cluster's page and the pagination controls would appear dead.
   */
  const goToPage = (next: number) => {
    setParams((prev) => {
      const updated = new URLSearchParams(prev);
      updated.set("page", String(next));
      updated.delete("cluster");
      return updated;
    });
  };

  const page = data?.page ?? urlPage;
  const totalPages = data?.totalPages ?? 1;

  return (
    <section className="card">
      <div className="spread">
        <h2>Priorities</h2>
        <span className="faint small">Ranked by AI priority score</span>
      </div>

      <div className="filters" style={{ marginTop: "0.75rem", marginBottom: "1rem" }}>
        <input
          type="search"
          value={searchInput}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter by name…"
          aria-label="Filter clusters by name"
        />
        {searchInput ? (
          <button type="button" onClick={() => onSearchChange("")}>
            Clear
          </button>
        ) : null}
      </div>

      {missingCluster ? (
        <div className="notice error" role="status" style={{ marginBottom: "1rem" }}>
          That cluster no longer exists — it may have been merged into another need or deleted.
          Showing the full list.
        </div>
      ) : null}

      {query.isError ? <ErrorNotice error={query.error} /> : null}
      {query.isLoading && !data ? <Loading rows={3} /> : null}

      {data ? (
        <>
          <p className="faint small" style={{ marginBottom: "0.75rem" }}>
            {data.total} need{data.total === 1 ? "" : "s"}
            {search ? ` matching “${search}”` : ""}
            {data.total > 0 ? ` · page ${page} of ${totalPages}` : ""}
          </p>

          {data.items.length === 0 ? (
            <Empty>
              <p>No needs match that filter.</p>
              <button type="button" onClick={() => onSearchChange("")}>
                Clear the filter
              </button>
            </Empty>
          ) : (
            <div style={{ opacity: query.isFetching ? 0.6 : 1, transition: "opacity 120ms" }}>
              {data.items.map((cluster, index) => (
                <RankedRow
                  key={cluster.clusterId}
                  cluster={cluster}
                  // Rank is position in the whole filtered ranking, not on this page.
                  rank={(page - 1) * data.pageSize + index + 1}
                  expanded={expanded === cluster.clusterId}
                  highlighted={focusId === cluster.clusterId}
                  onToggle={() =>
                    setExpanded(expanded === cluster.clusterId ? null : cluster.clusterId)
                  }
                />
              ))}
            </div>
          )}

          {totalPages > 1 ? (
            <nav className="pagination" aria-label="Cluster pages">
              <button type="button" onClick={() => goToPage(page - 1)} disabled={page <= 1}>
                Previous
              </button>
              {pageNumbers(page, totalPages).map((n, i) =>
                n === null ? (
                  <span key={`gap-${i}`} className="faint">
                    …
                  </span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    onClick={() => goToPage(n)}
                    className={n === page ? "primary" : undefined}
                    aria-current={n === page ? "page" : undefined}
                  >
                    {n}
                  </button>
                ),
              )}
              <button
                type="button"
                onClick={() => goToPage(page + 1)}
                disabled={page >= totalPages}
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** Windowed page numbers: first, last, and a span around the current page. */
function pageNumbers(current: number, total: number): Array<number | null> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);

  const out: Array<number | null> = [];
  let previous = 0;
  for (const n of sorted) {
    if (previous && n - previous > 1) out.push(null);
    out.push(n);
    previous = n;
  }
  return out;
}

function RankedRow({
  cluster,
  rank,
  expanded,
  highlighted = false,
  onToggle,
}: {
  cluster: RankedCluster;
  rank: number;
  expanded: boolean;
  /** Arrived at via a deep link - mark it so it is findable among ten rows. */
  highlighted?: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      id={`cluster-${cluster.clusterId}`}
      className={`ranked-row${highlighted ? " highlighted" : ""}`}
    >
      <div className="rank-number">{rank}</div>
      <ScorePill score={cluster.score} />
      <div style={{ minWidth: 0 }}>
        <h3 style={{ marginBottom: "0.2rem" }}>{cluster.title}</h3>
        <p className="small muted" style={{ marginBottom: "0.4rem" }}>
          {cluster.canonicalNeed}
        </p>
        <div className="row">
          {cluster.themeName ? <Badge variant="ai">✦ {cluster.themeName}</Badge> : null}
          <Badge>
            {cluster.requestCount} request{cluster.requestCount === 1 ? "" : "s"}
          </Badge>
          {cluster.distinctAccounts > 0 ? (
            <Badge>
              {cluster.distinctAccounts} account{cluster.distinctAccounts === 1 ? "" : "s"}
            </Badge>
          ) : null}
          {cluster.totalArrUsd > 0 ? <Badge>{formatUsd(cluster.totalArrUsd)} ARR</Badge> : null}
          {cluster.owningTeam ? <Badge>→ {cluster.owningTeam}</Badge> : null}
          <Badge>{cluster.status.replace(/_/g, " ")}</Badge>
        </div>

        {expanded ? (
          <div style={{ marginTop: "0.8rem" }}>
            <AiPanel title="Why this score">
              <p className="small">{cluster.rationale || "Not yet explained."}</p>
              <ComponentBars components={cluster.components} />
            </AiPanel>
          </div>
        ) : null}
      </div>
      <button type="button" className="subtle" onClick={onToggle} aria-expanded={expanded}>
        {expanded ? "Hide" : "Why?"}
      </button>
    </div>
  );
}

/**
 * Emerging needs is the expensive whole-corpus call, so it shows the cached
 * report and recomputes only when a human asks for it.
 */
function EmergingNeedsSection() {
  const query = useQuery({
    queryKey: ["emerging"],
    queryFn: () => api.emergingNeeds(false),
  });

  const refresh = useMutation({
    mutationFn: () => api.emergingNeeds(true),
    onSuccess: (data) => query.refetch().then(() => data),
  });

  const data = refresh.data ?? query.data;

  return (
    <section className="card">
      <div className="spread">
        <div>
          <h2>Emerging needs</h2>
          <p className="faint small" style={{ marginBottom: 0 }}>
            Patterns that are growing but not yet at the top of the board
          </p>
        </div>
        <button
          type="button"
          className="ai"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? "Analysing…" : "✦ Recompute"}
        </button>
      </div>

      {query.isLoading ? <Loading rows={1} /> : null}
      {query.isError && !data ? <ErrorNotice error={query.error} /> : null}

      {data ? (
        <>
          <p className="small" style={{ marginTop: "0.6rem" }}>
            {data.summary}
          </p>
          {data.trends.length === 0 ? (
            <p className="faint small">No trend rose above the noise in this window.</p>
          ) : (
            <div className="grid grid-2">
              {data.trends.map((trend, i) => (
                <div key={i} className="card">
                  <div className="row" style={{ marginBottom: "0.4rem" }}>
                    <Badge
                      variant={
                        trend.signalStrength === "urgent"
                          ? "blocker"
                          : trend.signalStrength === "building"
                            ? "major"
                            : undefined
                      }
                    >
                      {trend.signalStrength}
                    </Badge>
                    {trend.affectedSegments.map((s) => (
                      <Badge key={s}>{s}</Badge>
                    ))}
                  </div>
                  <h3>{trend.title}</h3>
                  <p className="small muted">{trend.description}</p>
                  <p className="small">
                    <strong>Why now:</strong> {trend.whyNow}
                  </p>
                </div>
              ))}
            </div>
          )}
          {data.createdAt ? (
            <p className="faint small" style={{ marginBottom: 0 }}>
              Generated {relativeTime(data.createdAt)} by {data.model}
              {data.cached ? " (cached)" : ""}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
