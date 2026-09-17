import { useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { CustomerTier, SubmitterType } from "../api/types";
import {
  AiPanel,
  Badge,
  ComponentBars,
  ErrorNotice,
  Loading,
  ScorePill,
  SeverityBadge,
  SubmitterBadge,
  relativeTime,
} from "../components/common";

export function RequestDetailPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const isNew = params.get("new") === "1";
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["request", id],
    queryFn: () => api.getRequest(id),
    // A freshly submitted request is still being analysed; poll until it lands
    // rather than making the user refresh to find out.
    refetchInterval: (q) =>
      q.state.data && q.state.data.request.status !== "analyzed" ? 3_000 : false,
  });

  if (query.isLoading) return <Loading rows={3} />;
  if (query.isError) return <ErrorNotice error={query.error} />;
  if (!query.data) return null;

  const { request, submitter, analysis, cluster, mergeDecision, relatedRequests, supportSignals, timeline } =
    query.data;

  const pending = request.status !== "analyzed";

  return (
    <>
      <p className="faint" style={{ marginBottom: "0.75rem" }}>
        <Link to="/">← All requests</Link>
      </p>

      {isNew ? (
        <div className="notice success" style={{ marginBottom: "1rem" }}>
          Request received. It is being analysed for duplicates, underlying need and priority.
        </div>
      ) : null}

      <div className="page-header">
        <div className="spread">
          <div>
            <h1>{request.title}</h1>
            <div className="row">
              {submitter ? (
                <SubmitterBadge
                  type={submitter.type}
                  tier={submitter.tier}
                  account={submitter.accountName}
                />
              ) : null}
              <span className="faint">{relativeTime(request.createdAt)}</span>
              {cluster ? <Badge>{cluster.status.replace(/_/g, " ")}</Badge> : null}
            </div>
          </div>
          <ScorePill score={cluster?.score?.total ?? null} />
        </div>
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div>
          <section className="card">
            <h2>What was submitted</h2>
            <p style={{ whiteSpace: "pre-wrap" }}>{request.description}</p>
          </section>

          {pending ? (
            <div className="notice info" style={{ marginTop: "1rem" }}>
              ✦ Analysis in progress. This page updates automatically.
            </div>
          ) : null}

          {analysis ? (
            <div style={{ marginTop: "1rem" }}>
              <AiPanel title="The problem underneath" model={analysis.model}>
                <p>
                  <strong>{analysis.underlyingNeed}</strong>
                </p>
                <p className="small muted">{analysis.jobToBeDone}</p>
                <div className="row" style={{ marginTop: "0.5rem" }}>
                  <SeverityBadge severity={analysis.severity} />
                  <Badge>urgency {analysis.urgency}</Badge>
                  <Badge>strategic fit {analysis.strategicAlignment}</Badge>
                  <Badge>{analysis.sentiment}</Badge>
                  <Badge>→ {analysis.suggestedTeam}</Badge>
                </div>

                {analysis.confidence < 0.5 ? (
                  <p className="small" style={{ marginTop: "0.6rem", color: "var(--warn)" }}>
                    Low confidence ({analysis.confidence.toFixed(2)}) — the request text was thin,
                    so treat this reading as provisional.
                  </p>
                ) : null}

                <details style={{ marginTop: "0.6rem" }}>
                  <summary>Why it was read this way</summary>
                  <p className="small muted" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
                    {analysis.reasoning}
                  </p>
                </details>
              </AiPanel>
            </div>
          ) : null}

          {/* The consolidation decision, shown to the person whose request was
              merged - the transparency that makes auto-merging acceptable. */}
          {mergeDecision && relatedRequests.length > 0 ? (
            <div style={{ marginTop: "1rem" }}>
              <AiPanel title={`Grouped with ${relatedRequests.length} other request${relatedRequests.length === 1 ? "" : "s"}`}>
                <p className="small">{mergeDecision.rationale}</p>
                <p className="faint small">
                  Decided by {mergeDecision.decidedBy === "ai" ? "automated analysis" : "a person"}
                  {mergeDecision.decidedBy === "ai"
                    ? ` · confidence ${mergeDecision.confidence.toFixed(2)}`
                    : ""}
                </p>
                <ul className="evidence">
                  {relatedRequests.map((r) => (
                    <li key={r.id}>
                      <Link to={`/requests/${r.id}`}>{r.title}</Link>
                      {r.rationale ? <span className="faint"> — {r.rationale}</span> : null}
                    </li>
                  ))}
                </ul>
                <SplitControl requestId={request.id} />
              </AiPanel>
            </div>
          ) : null}

          {cluster?.score ? (
            <div style={{ marginTop: "1rem" }}>
              <AiPanel title="Why it is ranked here" model={cluster.score.model}>
                <p>{cluster.score.rationale}</p>
                <ComponentBars components={cluster.score.components} />
                {cluster.score.evidence.length > 0 ? (
                  <ul className="evidence">
                    {cluster.score.evidence.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                ) : null}
                {cluster.score.rationaleStale ? (
                  <p className="small" style={{ marginTop: "0.6rem", color: "var(--warn)" }}>
                    The number above reflects the current weights; this explanation was written
                    before they were last changed. The component values it describes have not
                    moved.
                  </p>
                ) : null}
                <p className="faint small" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
                  Weights version{" "}
                  <span className="mono">{cluster.score.weightsVersion}</span> · scored{" "}
                  {relativeTime(cluster.score.createdAt)}
                </p>
              </AiPanel>
            </div>
          ) : null}

          {supportSignals.length > 0 ? (
            <section className="card" style={{ marginTop: "1rem" }}>
              <h2>Who else is affected</h2>
              <div className="list">
                {supportSignals.map((s) => (
                  <div key={s.id} style={{ borderTop: "1px solid var(--border)", paddingTop: "0.7rem" }}>
                    <div className="row" style={{ marginBottom: "0.3rem" }}>
                      <SubmitterBadge
                        type={s.submitterType}
                        tier={s.submitterTier}
                        account={s.accountName}
                      />
                      <span className="faint">{relativeTime(s.createdAt)}</span>
                    </div>
                    <p className="small" style={{ marginBottom: s.currentWorkaround ? "0.3rem" : 0 }}>
                      {s.impactText}
                    </p>
                    {s.currentWorkaround ? (
                      <p className="small faint" style={{ marginBottom: 0 }}>
                        Workaround: {s.currentWorkaround}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <div>
          {cluster ? (
            <section className="card">
              <h2>Cluster</h2>
              <p className="small">
                {/* Deep-links by stable id, never by title, so renaming a
                    cluster cannot break the link. The dashboard resolves which
                    page the id falls on. */}
                <Link
                  to={`/dashboard?cluster=${encodeURIComponent(cluster.id)}`}
                  title="See how this need ranks on the dashboard"
                >
                  {cluster.title}
                </Link>
              </p>
              <p className="small muted">{cluster.canonicalNeed}</p>
              <div className="row">
                {cluster.theme ? <Badge variant="ai">✦ {cluster.theme.name}</Badge> : null}
                <Badge>
                  {cluster.memberCount} request{cluster.memberCount === 1 ? "" : "s"}
                </Badge>
                <Badge>
                  {cluster.supporterCount} supporter{cluster.supporterCount === 1 ? "" : "s"}
                </Badge>
              </div>
            </section>
          ) : null}

          {cluster ? (
            <SupportForm
              requestId={request.id}
              onDone={() => queryClient.invalidateQueries({ queryKey: ["request", id] })}
            />
          ) : null}

          {timeline.length > 0 ? (
            <section className="card">
              <h2>History</h2>
              <ul className="timeline">
                {timeline.map((event) => (
                  <li key={event.id}>
                    <time dateTime={event.createdAt}>{relativeTime(event.createdAt)}</time>
                    <span>
                      {event.type.replace(/_/g, " ")}
                      <span className="faint"> · {event.actor}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}

/**
 * Support, not upvote. The impact description is required because it is what
 * the scoring and brief stages actually read - a bare count would tell a
 * product team nothing about who is affected or how badly.
 */
function SupportForm({ requestId, onDone }: { requestId: string; onDone: () => void }) {
  const [impactText, setImpactText] = useState("");
  const [workaround, setWorkaround] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [type, setType] = useState<SubmitterType>("customer");
  const [tier, setTier] = useState<CustomerTier | "">("");
  const [accountName, setAccountName] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      api.supportRequest(requestId, {
        impactText: impactText.trim(),
        ...(workaround.trim() ? { currentWorkaround: workaround.trim() } : {}),
        submitter: {
          name: name.trim(),
          type,
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(tier ? { tier } : {}),
          ...(accountName.trim() ? { accountName: accountName.trim() } : {}),
        },
      }),
    onSuccess: () => {
      setImpactText("");
      setWorkaround("");
      onDone();
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  if (mutation.isSuccess) {
    return (
      <section className="card">
        <div className="notice success">
          Recorded. Your description feeds directly into how this is prioritised.
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>This affects you too?</h2>
      <p className="small muted">
        Rather than a vote, tell us what it costs you. That description is read when this is
        scored and when a decision brief is written — a number alone would not be.
      </p>
      <form onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="impact">How does this affect you?</label>
          <textarea
            id="impact"
            value={impactText}
            onChange={(e) => setImpactText(e.target.value)}
            placeholder="We hit this every quarter close — two analysts lose a full day assembling the same numbers by hand."
            required
            minLength={15}
            style={{ minHeight: "5.5rem" }}
          />
        </div>
        <div className="field">
          <label htmlFor="workaround">What do you do instead today?</label>
          <input
            id="workaround"
            value={workaround}
            onChange={(e) => setWorkaround(e.target.value)}
            placeholder="A scraping script one of our engineers maintains"
          />
        </div>
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="s-name">Name</label>
            <input id="s-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="s-email">Email</label>
            <input
              id="s-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="s-type">You are a…</label>
            <select
              id="s-type"
              value={type}
              onChange={(e) => setType(e.target.value as SubmitterType)}
            >
              <option value="customer">Customer</option>
              <option value="prospect">Prospect</option>
              <option value="support">Support</option>
              <option value="internal">Internal</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="s-account">Company</label>
            <input
              id="s-account"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
            />
          </div>
        </div>
        {type === "customer" || type === "prospect" ? (
          <div className="field">
            <label htmlFor="s-tier">Plan</label>
            <select
              id="s-tier"
              value={tier}
              onChange={(e) => setTier(e.target.value as CustomerTier | "")}
            >
              <option value="">Not sure</option>
              <option value="enterprise">enterprise</option>
              <option value="growth">growth</option>
              <option value="starter">starter</option>
              <option value="free">free</option>
            </select>
          </div>
        ) : null}

        {mutation.isError ? (
          <div className="notice error" role="alert" style={{ marginBottom: "0.8rem" }}>
            {mutation.error instanceof ApiError
              ? (mutation.error.details?.[0]?.message ?? mutation.error.message)
              : "Could not record that."}
          </div>
        ) : null}

        <button type="submit" className="primary" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Add my impact"}
        </button>
      </form>
    </section>
  );
}

/** Human override: pull this request back out of a cluster the AI merged it into. */
function SplitControl({ requestId }: { requestId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const mutation = useMutation({
    mutationFn: () => api.splitRequest(requestId, reason.trim()),
    onSuccess: () => {
      setOpen(false);
      setReason("");
      queryClient.invalidateQueries({ queryKey: ["request", requestId] });
    },
  });

  if (!open) {
    return (
      <button type="button" className="subtle" onClick={() => setOpen(true)}>
        This is not the same problem →
      </button>
    );
  }

  return (
    <div style={{ marginTop: "0.6rem" }}>
      <label htmlFor="split-reason">Why is it different?</label>
      <input
        id="split-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Warehouse sync is a pipeline, not a spreadsheet export."
      />
      {mutation.isError ? (
        <div className="notice error" role="alert" style={{ marginTop: "0.5rem" }}>
          {mutation.error instanceof ApiError ? mutation.error.message : "Could not split."}
        </div>
      ) : null}
      <div className="row" style={{ marginTop: "0.6rem" }}>
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={reason.trim().length < 5 || mutation.isPending}
        >
          {mutation.isPending ? "Separating…" : "Separate it"}
        </button>
        <button type="button" className="subtle" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
