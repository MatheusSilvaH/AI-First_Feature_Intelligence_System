import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { AiPanel, Badge, Empty, ErrorNotice, Loading, relativeTime } from "../components/common";

/**
 * The human-in-the-loop queue.
 *
 * The pipeline applies a merge on its own only when it is confident. Everything
 * below that threshold lands here for a person to accept or reject - which is
 * precisely what makes automatic merging safe to leave on.
 */
export function ReviewPage() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["merge-suggestions"],
    queryFn: api.listMergeSuggestions,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["merge-suggestions"] });
    queryClient.invalidateQueries({ queryKey: ["requests"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const accept = useMutation({ mutationFn: api.acceptMerge, onSuccess: invalidate });
  const reject = useMutation({ mutationFn: api.rejectMerge, onSuccess: invalidate });

  if (query.isLoading) return <Loading rows={2} />;
  if (query.isError) return <ErrorNotice error={query.error} />;

  const suggestions = query.data?.suggestions ?? [];

  return (
    <>
      <div className="page-header">
        <h1>Review queue</h1>
        <p>
          Consolidations the analysis proposed but was not confident enough to apply on its own.
          A wrongly merged request disappears from view, so these wait for a person.
        </p>
      </div>

      {suggestions.length === 0 ? (
        <Empty>
          <p>Nothing waiting. Confident merges are applied automatically.</p>
          <Link to="/">Back to discovery</Link>
        </Empty>
      ) : (
        <div className="list">
          {suggestions.map((s) => {
            const busy =
              (accept.isPending && accept.variables === s.id) ||
              (reject.isPending && reject.variables === s.id);

            return (
              <div key={s.id} className="card">
                <div className="spread">
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ marginBottom: "0.5rem" }}>
                      <Badge variant={s.verdict === "duplicate" ? "major" : undefined}>
                        {s.verdict}
                      </Badge>
                      <Badge variant="ai">confidence {s.confidence.toFixed(2)}</Badge>
                      <span className="faint">{relativeTime(s.createdAt)}</span>
                    </div>
                    <h3 style={{ marginBottom: "0.2rem" }}>
                      <Link to={`/requests/${s.requestId}`}>{s.requestTitle}</Link>
                    </h3>
                    <p className="small muted" style={{ marginBottom: "0.6rem" }}>
                      Proposed merge into: <strong>{s.targetClusterTitle}</strong>
                    </p>
                  </div>
                </div>

                <AiPanel title="Reasoning">
                  <p className="small" style={{ marginBottom: 0 }}>
                    {s.rationale}
                  </p>
                </AiPanel>

                <div className="row" style={{ marginTop: "0.9rem" }}>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => accept.mutate(s.id)}
                    disabled={busy}
                  >
                    Merge them
                  </button>
                  <button type="button" onClick={() => reject.mutate(s.id)} disabled={busy}>
                    Keep separate
                  </button>
                  <Link to={`/requests/${s.requestId}`} className="small faint">
                    Read the full request →
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <BriefWorkbench />
    </>
  );
}

/**
 * Drafting a decision brief and the outbound message. Both are always drafts -
 * nothing is sent to a customer without someone reading it first.
 */
function BriefWorkbench() {
  const [clusterId, setClusterId] = useState("");
  const [note, setNote] = useState("");

  const top = useQuery({
    queryKey: ["top-clusters"],
    queryFn: () => api.topClusters({ limit: 25 }),
  });

  const cluster = useQuery({
    queryKey: ["cluster", clusterId],
    queryFn: () => api.getCluster(clusterId),
    enabled: clusterId !== "",
  });

  const brief = useMutation({
    mutationFn: () => api.generateBrief(clusterId),
    onSuccess: () => cluster.refetch(),
  });

  const update = useMutation({
    mutationFn: () => api.generateUpdate(clusterId, "requesters", note.trim()),
    onSuccess: () => cluster.refetch(),
  });

  const latestBrief = brief.data ?? cluster.data?.brief ?? null;
  const latestUpdate = update.data ?? cluster.data?.updates[0] ?? null;

  return (
    <section className="card" style={{ marginTop: "2rem" }}>
      <h2>Decision briefs and stakeholder updates</h2>
      <p className="small muted">
        Generate a one-page brief for a need, then draft the message that goes back to the people
        who asked for it. Both are drafts — a person decides what is actually sent.
      </p>

      <div className="field">
        <label htmlFor="cluster-select">Need</label>
        <select
          id="cluster-select"
          value={clusterId}
          onChange={(e) => setClusterId(e.target.value)}
        >
          <option value="">Choose a need…</option>
          {top.data?.clusters.map((c) => (
            <option key={c.clusterId} value={c.clusterId}>
              {Math.round(c.score)} · {c.title}
            </option>
          ))}
        </select>
      </div>

      {clusterId ? (
        <>
          <div className="row" style={{ marginBottom: "1rem" }}>
            <button
              type="button"
              className="ai"
              onClick={() => brief.mutate()}
              disabled={brief.isPending}
            >
              {brief.isPending ? "Writing…" : "✦ Generate decision brief"}
            </button>
          </div>

          {brief.isError ? <ErrorNotice error={brief.error} /> : null}

          {latestBrief ? (
            <AiPanel title="Decision brief" model={latestBrief.model}>
              <p>
                <strong>Problem.</strong> {latestBrief.problem}
              </p>
              <p>
                <strong>Recommendation.</strong>{" "}
                <Badge
                  variant={
                    latestBrief.recommendedPriority === "now"
                      ? "blocker"
                      : latestBrief.recommendedPriority === "next"
                        ? "major"
                        : undefined
                  }
                >
                  {latestBrief.recommendedPriority}
                </Badge>{" "}
                {latestBrief.suggestedNextStep}
              </p>
              <p className="small">
                <strong>Affected.</strong> {latestBrief.affectedSegments.join(", ")}
              </p>
              <p className="small">
                <strong>Risk if ignored.</strong> {latestBrief.risksIfIgnored}
              </p>
              <ul className="evidence">
                {latestBrief.evidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
              {latestBrief.openQuestions.length > 0 ? (
                <details>
                  <summary>Open questions for a human ({latestBrief.openQuestions.length})</summary>
                  <ul className="evidence">
                    {latestBrief.openQuestions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </AiPanel>
          ) : null}

          <div className="field" style={{ marginTop: "1.2rem" }}>
            <label htmlFor="note">Anything the message should say?</label>
            <input
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="We are starting discovery this quarter but cannot commit to a date yet."
            />
            <div className="hint">
              Only what you write here becomes a commitment — the draft will not invent dates.
            </div>
          </div>

          <button
            type="button"
            className="ai"
            onClick={() => update.mutate()}
            disabled={update.isPending}
          >
            {update.isPending ? "Drafting…" : "✦ Draft the update"}
          </button>

          {update.isError ? <ErrorNotice error={update.error} /> : null}

          {latestUpdate ? (
            <div style={{ marginTop: "1rem" }}>
              <AiPanel title={`Draft update · ${latestUpdate.status}`}>
                <p>
                  <strong>{latestUpdate.subject}</strong>
                </p>
                <p style={{ whiteSpace: "pre-wrap" }}>{latestUpdate.body}</p>
                <p className="faint small" style={{ marginBottom: 0 }}>
                  Review and edit before sending. Nothing is sent automatically.
                </p>
              </AiPanel>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
