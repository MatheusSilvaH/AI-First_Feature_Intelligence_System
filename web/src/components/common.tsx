import type { ReactNode } from "react";
import type { ScoreComponents, Severity, SubmitterType } from "../api/types";

export function Badge({
  children,
  variant,
}: {
  children: ReactNode;
  variant?: string;
}) {
  return <span className={`badge ${variant ?? ""}`}>{children}</span>;
}

export function SubmitterBadge({
  type,
  tier,
  account,
}: {
  type: SubmitterType;
  tier?: string | null;
  account?: string | null;
}) {
  return (
    <Badge variant={type}>
      {type}
      {tier ? ` · ${tier}` : ""}
      {account ? ` · ${account}` : ""}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge variant={severity}>{severity}</Badge>;
}

/** Marks content the model produced, so inference is never mistaken for fact. */
export function AiPanel({
  title,
  model,
  children,
}: {
  title: string;
  model?: string;
  children: ReactNode;
}) {
  return (
    <section className="ai-panel">
      <div className="ai-panel-title">
        <span aria-hidden="true">✦</span>
        <span>{title}</span>
        {model ? <span className="component-weight">· {model}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function ScorePill({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <div className="score-pill low">
        <span className="value">–</span>
        <span className="label">pending</span>
      </div>
    );
  }
  const band = score >= 65 ? "high" : score >= 40 ? "mid" : "low";
  return (
    <div className={`score-pill ${band}`}>
      <span className="value">{Math.round(score)}</span>
      <span className="label">score</span>
    </div>
  );
}

const COMPONENT_LABELS: Record<keyof ScoreComponents, string> = {
  submitterWeight: "Submitter weight",
  reach: "Reach",
  severity: "Severity",
  strategicAlignment: "Strategic fit",
  urgency: "Urgency",
};

/**
 * The score broken into its parts. Shown wherever a score is shown - a bare
 * number is exactly the black box this system is meant to replace.
 */
export function ComponentBars({ components }: { components: ScoreComponents }) {
  return (
    <div className="components">
      {(Object.keys(COMPONENT_LABELS) as Array<keyof ScoreComponents>).map((key) => (
        <div className="component" key={key}>
          <span className="component-name">{COMPONENT_LABELS[key]}</span>
          <div
            className="component-bar"
            role="meter"
            aria-valuenow={Math.round(components[key])}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={COMPONENT_LABELS[key]}
          >
            <div style={{ width: `${Math.min(100, Math.max(0, components[key]))}%` }} />
          </div>
          <span className="component-value">{Math.round(components[key])}</span>
        </div>
      ))}
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="list" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card">
          <div className="skeleton" style={{ width: "45%", marginBottom: "0.6rem" }} />
          <div className="skeleton" style={{ width: "85%", marginBottom: "0.4rem" }} />
          <div className="skeleton" style={{ width: "60%" }} />
        </div>
      ))}
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div className="notice error" role="alert">
      {message}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const formatUsd = (n: number): string =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `$${Math.round(n / 1_000)}k`
      : `$${n}`;
