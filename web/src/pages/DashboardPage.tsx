import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
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
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useQuery({ queryKey: ["dashboard"], queryFn: () => api.dashboard(90) });

  if (query.isLoading) return <Loading rows={4} />;
  if (query.isError) return <ErrorNotice error={query.error} />;
  if (!query.data) return null;

  const { topClusters, byTheme, volumeTrend, submitterMix, metrics } = query.data;

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

      {/* --- ranked leaderboard --- */}
      <section className="card">
        <div className="spread">
          <h2>Top priorities overall</h2>
          <span className="faint small">Ranked by AI priority score</span>
        </div>
        {topClusters.length === 0 ? (
          <p className="faint">Nothing scored yet.</p>
        ) : (
          <div>
            {topClusters.map((cluster, index) => (
              <RankedRow
                key={cluster.clusterId}
                cluster={cluster}
                rank={index + 1}
                expanded={expanded === cluster.clusterId}
                onToggle={() =>
                  setExpanded(expanded === cluster.clusterId ? null : cluster.clusterId)
                }
              />
            ))}
          </div>
        )}
      </section>

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

function RankedRow({
  cluster,
  rank,
  expanded,
  onToggle,
}: {
  cluster: RankedCluster;
  rank: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="ranked-row">
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
