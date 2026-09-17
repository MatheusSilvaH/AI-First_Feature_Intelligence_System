-- ---------------------------------------------------------------------------
-- Feature Intelligence System - initial schema
--
-- The unit of prioritization is the CLUSTER, not the request. Every request
-- belongs to exactly one cluster (a cluster of one, if it is genuinely novel).
-- Scores, briefs, themes and status all hang off the cluster, which is what
-- makes "consolidate duplicates" a structural property rather than a UI filter.
-- ---------------------------------------------------------------------------

CREATE TABLE submitters (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT,
  type          TEXT NOT NULL CHECK (type IN ('customer','prospect','support','internal')),
  tier          TEXT CHECK (tier IN ('enterprise','growth','starter','free')),
  account_name  TEXT,
  arr_usd       REAL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_submitters_type ON submitters(type);
CREATE UNIQUE INDEX idx_submitters_email ON submitters(email) WHERE email IS NOT NULL;

CREATE TABLE themes (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  product_area  TEXT NOT NULL DEFAULT 'unassigned',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE clusters (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  canonical_need TEXT NOT NULL DEFAULT '',
  theme_id       TEXT REFERENCES themes(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','under_review','planned','in_progress','shipped','declined')),
  owning_team    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_clusters_theme ON clusters(theme_id);
CREATE INDEX idx_clusters_status ON clusters(status);

CREATE TABLE requests (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  submitter_id  TEXT NOT NULL REFERENCES submitters(id) ON DELETE RESTRICT,
  cluster_id    TEXT REFERENCES clusters(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'received'
                CHECK (status IN ('received','analyzing','analyzed','failed')),
  source        TEXT NOT NULL DEFAULT 'web',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_requests_cluster ON requests(cluster_id);
CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_created ON requests(created_at);
CREATE INDEX idx_requests_submitter ON requests(submitter_id);

-- Full-text index over request text. This is the *retrieval* half of duplicate
-- detection: BM25 narrows thousands of requests to a handful of candidates that
-- Claude then adjudicates semantically.
--
-- Deliberately a self-contained (not contentless) FTS5 table: `underlying_need`
-- is backfilled later by the analysis stage, and a contentless table can only
-- be deleted from by replaying the exact values originally indexed. Storing a
-- copy costs disk and buys a trivial "delete by id, re-insert" sync, which
-- requests.repo.ts performs inside the same transaction as the write.
CREATE VIRTUAL TABLE requests_fts USING fts5(
  request_id UNINDEXED,
  title,
  description,
  underlying_need,
  tokenize = 'porter unicode61'
);

CREATE TABLE request_analysis (
  request_id            TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  underlying_need       TEXT NOT NULL,
  job_to_be_done        TEXT NOT NULL,
  problem_summary       TEXT NOT NULL,
  severity              TEXT NOT NULL CHECK (severity IN ('blocker','major','moderate','minor')),
  urgency               INTEGER NOT NULL CHECK (urgency BETWEEN 0 AND 100),
  sentiment             TEXT NOT NULL CHECK (sentiment IN ('frustrated','neutral','enthusiastic')),
  strategic_alignment   INTEGER NOT NULL CHECK (strategic_alignment BETWEEN 0 AND 100),
  suggested_team        TEXT NOT NULL,
  suggested_product_area TEXT NOT NULL,
  tags                  TEXT NOT NULL DEFAULT '[]',
  confidence            REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reasoning             TEXT NOT NULL DEFAULT '',
  model                 TEXT NOT NULL,
  prompt_version        TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Append-only audit of how each request landed in its cluster, including human
-- overrides of an AI merge.
CREATE TABLE cluster_decisions (
  id                       TEXT PRIMARY KEY,
  cluster_id               TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  request_id               TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  decided_by               TEXT NOT NULL CHECK (decided_by IN ('ai','human')),
  confidence               REAL NOT NULL DEFAULT 1.0,
  rationale                TEXT NOT NULL DEFAULT '',
  overridden_from_cluster_id TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_cluster_decisions_cluster ON cluster_decisions(cluster_id);
CREATE INDEX idx_cluster_decisions_request ON cluster_decisions(request_id);

-- Merges the model proposed but was not confident enough to apply on its own.
-- This is the human-in-the-loop queue: a low-confidence duplicate call parks
-- here instead of silently absorbing someone's request into another cluster.
CREATE TABLE merge_suggestions (
  id                 TEXT PRIMARY KEY,
  request_id         TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  target_cluster_id  TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  verdict            TEXT NOT NULL CHECK (verdict IN ('duplicate','related')),
  confidence         REAL NOT NULL,
  rationale          TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','accepted','rejected')),
  resolved_by        TEXT,
  resolved_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (request_id, target_cluster_id)
);
CREATE INDEX idx_merge_suggestions_status ON merge_suggestions(status, created_at DESC);

-- Append-only score history. The newest row for a cluster is the current score;
-- older rows make re-ranking auditable ("why did this drop last week?").
CREATE TABLE priority_scores (
  id                  TEXT PRIMARY KEY,
  cluster_id          TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  total               REAL NOT NULL,
  c_submitter_weight  REAL NOT NULL,
  c_reach             REAL NOT NULL,
  c_severity          REAL NOT NULL,
  c_strategic         REAL NOT NULL,
  c_urgency           REAL NOT NULL,
  rationale           TEXT NOT NULL,
  evidence            TEXT NOT NULL DEFAULT '[]',
  weights_version     TEXT NOT NULL,
  -- Two fingerprints, because the two halves of a score change independently.
  -- `evidence_fingerprint` covers what the model judged (severity, urgency,
  -- who asked); `inputs_fingerprint` additionally covers the weights. When only
  -- the weights move, the totals are recomputed locally and the prior rationale
  -- is carried forward rather than re-bought - see pipeline.ts scoreCluster.
  inputs_fingerprint  TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL DEFAULT '',
  -- Set when the rationale was carried forward under different weights, so the
  -- UI can say so instead of presenting stale prose as current.
  rationale_stale     INTEGER NOT NULL DEFAULT 0,
  model               TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_scores_cluster_created ON priority_scores(cluster_id, created_at DESC);

CREATE TABLE support_signals (
  id                 TEXT PRIMARY KEY,
  cluster_id         TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  request_id         TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  submitter_id       TEXT NOT NULL REFERENCES submitters(id) ON DELETE CASCADE,
  impact_text        TEXT NOT NULL,
  current_workaround TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- One voice per account per cluster. Re-supporting updates the existing row.
  UNIQUE (cluster_id, submitter_id)
);
CREATE INDEX idx_signals_cluster ON support_signals(cluster_id);

CREATE TABLE decision_briefs (
  id                  TEXT PRIMARY KEY,
  cluster_id          TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  problem             TEXT NOT NULL,
  evidence            TEXT NOT NULL DEFAULT '[]',
  affected_segments   TEXT NOT NULL DEFAULT '[]',
  recommended_priority TEXT NOT NULL,
  suggested_next_step TEXT NOT NULL,
  risks_if_ignored    TEXT NOT NULL DEFAULT '',
  open_questions      TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  approved_by         TEXT,
  model               TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_briefs_cluster_created ON decision_briefs(cluster_id, created_at DESC);

CREATE TABLE stakeholder_updates (
  id          TEXT PRIMARY KEY,
  cluster_id  TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  audience    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_updates_cluster_created ON stakeholder_updates(cluster_id, created_at DESC);

-- Durable job queue. Survives restarts, which matters because AI analysis is
-- async: the submit endpoint returns immediately and enqueues the pipeline.
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','succeeded','failed','dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error   TEXT,
  -- Collapses duplicate work: enqueueing "rescore cluster X" twice while the
  -- first is still pending is a no-op.
  dedupe_key   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_jobs_claim ON jobs(status, run_after);
CREATE UNIQUE INDEX idx_jobs_dedupe ON jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');

-- Response cache for Claude calls, keyed by (stage, model, prompt version,
-- input hash). Stops us paying twice for an identical analysis.
CREATE TABLE ai_cache (
  cache_key   TEXT PRIMARY KEY,
  stage       TEXT NOT NULL,
  model       TEXT NOT NULL,
  output      TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ai_cache_stage ON ai_cache(stage, created_at);

-- Per-call telemetry, so "what is this costing us" is answerable.
CREATE TABLE ai_call_log (
  id            TEXT PRIMARY KEY,
  stage         TEXT NOT NULL,
  model         TEXT NOT NULL,
  cache_hit     INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 1,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ai_call_log_created ON ai_call_log(created_at);

-- Human-readable audit trail across every entity.
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'system',
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_events_entity ON events(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_events_created ON events(created_at DESC);

-- Replay cache for POSTs carrying an Idempotency-Key header.
CREATE TABLE idempotency_keys (
  key             TEXT PRIMARY KEY,
  endpoint        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Tunable configuration that product leadership owns (scoring weights, strategy
-- pillars). Kept in the DB rather than code so re-weighting is an API call.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  version    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Cached output of the emerging-needs stage (expensive, whole-corpus).
CREATE TABLE insights (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  content    TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_insights_kind_created ON insights(kind, created_at DESC);

-- Only the delete side is worth a trigger: it has no "new" values to depend on,
-- and it guarantees the index cannot outlive a removed request even if a future
-- code path deletes rows directly.
CREATE TRIGGER requests_fts_delete AFTER DELETE ON requests BEGIN
  DELETE FROM requests_fts WHERE request_id = old.id;
END;
