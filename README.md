# Feature Intelligence System

Turns unstructured feature requests into product decisions. Claude does the reading, grouping and judging; the system does the arithmetic, the bookkeeping and the asking-a-human-when-it-matters.

```
Node 24 · TypeScript · Express 5 · SQLite (node:sqlite + FTS5) · React 19 · Vite · Recharts
Claude Opus 5 (judgment) + Claude Haiku 4.5 (volume), via the Anthropic Messages API
```

---

## Quick start

```bash
npm install
cp .env.example .env          # add your ANTHROPIC_API_KEY
npm run seed                  # 12 realistic requests, analysed end to end
npm run dev                   # API on :4000, UI on :5173
```

No API key to hand? Set `AI_DRY_RUN=true` and everything runs against deterministic stubs — the full pipeline, UI and dashboard work, no calls are made, nothing is billed. That is also how CI runs.

```bash
npm test          # 42 tests
npm run typecheck
```

---

## The problem this solves

A product team drowning in feedback has four distinct problems, and only the first one looks like a software problem:

1. **The same need arrives in different words.** "Add CSV export", "get our data into Snowflake" and "customer asked how to pull six months of history" are one need. Keyword search does not see it. A human reading 400 requests does, but only if they read all 400 at once and remember them.
2. **People describe solutions, not problems.** "Add a CSV button" is the ask. "I cannot get my data into the tool where I actually do my analysis" is the need. A team that builds the button still has the problem.
3. **Popularity is not value.** Twenty free-tier votes and one blocked enterprise renewal are not comparable, and a vote count treats them as if they were.
4. **Decisions do not get communicated.** The person who filed the request hears nothing, escalates, and the loop costs more than the original triage.

Each of these is a *judgment* problem dressed as a data problem, which is why AI is load-bearing here rather than decorative.

## Why AI, and not heuristics

Duplicate detection is the clearest case. The naive version is keyword matching, and it fails in both directions:

- **Misses.** "Scheduled CSV export" and "get our usage numbers into Snowflake" share almost no vocabulary and are the same underlying need.
- **False positives.** "SAML SSO for our employees" and "let our customers log into our vendor portal" share their most distinctive terms and are completely different products.

Both cases are in `src/db/seed.ts`, deliberately. You cannot regex your way out of either; you need something that reads for meaning. The same argument applies to severity (a calm note describing three hours of weekly manual work is a *major* problem; an angry message about a button colour is *minor*), and to the underlying-need extraction that the whole pipeline rests on.

**Where AI is deliberately not used:** the priority score itself. See [Scoring](#scoring-ai-judgment-deterministic-arithmetic).

## Why not an agent?

The brief asked whether to build this on the Claude Agent SDK as an autonomous agentic loop. **It is a fixed pipeline of discrete Messages API calls instead**, and the reasoning matters more than the conclusion.

An agent loop earns its cost when the *sequence of steps is not knowable in advance* — when the model must decide what to look at next based on what it just found. Triaging a feature request is not that task. Every run does the same five things in the same order:

```
extract need → retrieve candidates → adjudicate duplicates → assign theme → score
```

Making that a loop would buy nondeterminism and lose four things this system needs:

| | Fixed pipeline | Agent loop |
|---|---|---|
| **Testability** | Each stage has typed inputs and outputs; `compute.test.ts` pins the scoring maths exactly, and the duplicate adjudicator can be driven to a specific verdict in a test | You test a trajectory, and it differs between runs |
| **Cost** | Known call count per request, cached per stage | Unbounded; a loop that decides to look at forty more requests costs forty more calls |
| **Latency** | Two fast-model calls on the hot path | However many turns it takes |
| **Debuggability** | A bad merge traces to one stage with one prompt you can fix in isolation | A bad merge traces to a conversation |

**Where an agent loop would genuinely pay off**, and where I would reach for the Agent SDK if this grew: open-ended investigation. "Something is going wrong with enterprise onboarding — go find out what" is a task where the next step really does depend on the last. The `emerging_needs` stage is the seed of that: today it reads aggregates in one call, but the natural next version explores — pulling up individual requests, checking support ticket volume, comparing against last quarter. That is the right place for an agent, and it is deliberately isolated from the per-request pipeline so it can become one without disturbing anything else.

### Structured outputs, not tool-calling-for-JSON

Every stage uses `output_config.format` with a Zod schema (`services/ai/schemas.ts`), via `client.messages.parse()`. The model is constrained to the schema server-side and the SDK returns a typed object.

This is the current successor to the older "define a tool the model must call, to force JSON out of it" pattern — same goal, fewer moving parts, no fake tool that never executes. The schemas double as the validation boundary: nothing reaches a repository without passing through one.

### Model routing

Two tiers, because paying Opus prices to classify a support ticket is waste:

| Stage | Model | Why |
|---|---|---|
| `extract_need` | Haiku 4.5 | Runs on *every* submission. Extraction, not judgment. |
| `adjudicate_duplicate` | Haiku 4.5 | Bounded comparison against ≤8 candidates. |
| `assign_theme` | Haiku 4.5 | Classification against an existing list. |
| `explain_score` | **Opus 5** | A leader reorders a roadmap on this. A plausible-but-wrong sentence is expensive. |
| `decision_brief` | **Opus 5** | Same. |
| `stakeholder_update` | **Opus 5** | Goes to a customer under the company's name. |
| `emerging_needs` | **Opus 5** | Whole-corpus synthesis; the hardest reasoning in the system. |

Both are env vars (`ANTHROPIC_MODEL_PRIMARY` / `_FAST`), so the split is tunable without a deploy.

---

## Architecture

```
web/  React SPA ─────── /api ──────┐   (the browser never sees the API key)
                                    │
server/                             ▼
  api/          routes · zod validation · idempotency · rate limits
  services/     requests · clusters · analytics · insights
      ai/       claudeClient.ts  ← the ONLY file importing @anthropic-ai/sdk
        stages/ extractNeed · adjudicateDuplicate · assignTheme
                explainScore · composeBrief · detectEmergingNeeds
      scoring/  config.ts (tunable weights) · compute.ts (deterministic maths)
      intelligence/pipeline.ts  ← composes the stages
  jobs/         durable SQLite-backed queue + worker
  repositories/ one module per aggregate; all SQL lives here
  db/           schema, migrations, FTS sync
```

Dependencies point one way: `routes → services → repositories → db`. Nothing below reaches up.

**The cluster, not the request, is the unit of prioritisation.** Every request belongs to exactly one cluster — a cluster of one if it is genuinely novel. Scores, themes, briefs and status hang off the cluster. That is what makes "consolidate duplicates" a structural property of the data model rather than a filter in the UI.

### Why SQLite

Node 24 ships SQLite in the standard library, and it includes **FTS5** — which is not a detail, it is the retrieval half of duplicate detection. That combination means: zero native compilation, zero external services, `npm install && npm run dev` works on a clean machine, and BM25 candidate retrieval comes free.

The schema is ordinary relational SQL with JSON columns only where the shape is genuinely open (AI output blobs, evidence arrays). Porting to Postgres is a driver swap and a migration dialect pass — there is no SQLite-specific modelling to unwind. For a real deployment at volume I would do exactly that, and move the job queue to the same Postgres instance before reaching for Redis.

### Duplicate detection: retrieval + adjudication

```
new request
   └─ FTS5 / BM25 over title + description + underlying_need   ← cheap, scales
        └─ top 8 candidates
             └─ Claude judges semantic equivalence             ← accurate, bounded
                  └─ confidence ≥ 0.75 → merge
                     confidence < 0.75 → human review queue
```

Anthropic does not ship an embeddings API, so lexical retrieval plus LLM adjudication is the right shape rather than a compromise: BM25 is very good at *recall* over a shortlist, and the model supplies the *precision* that BM25 lacks. Cost stays flat as the corpus grows, because the model always sees eight candidates whether there are 80 requests or 80,000.

Two guards on the model's output:

- A merge naming a request id outside the shortlist is discarded, not trusted (`adjudicateDuplicate.ts`). A hallucinated id would otherwise move someone's request into a cluster nobody chose. There is a test for this.
- Below the confidence threshold, the merge becomes a **suggestion** rather than an action.

That threshold comes from an asymmetry: a **false merge hides someone's request** — they are told their problem is being handled when it is not, and nobody notices until a renewal conversation. A **missed merge** just leaves a visible duplicate on the board. The costs are not symmetric, so the system is biased toward not merging, and the prompt says so explicitly.

### Scoring: AI judgment, deterministic arithmetic

This is the most important design decision in the system.

**The model supplies judgments.** Severity, urgency and strategic alignment are read out of each request and cached on it.

**TypeScript supplies the arithmetic.** `services/scoring/compute.ts` combines those judgments with facts from the database — who asked, how many accounts, how much ARR — using operator-configurable weights.

```
score = w₁·submitterWeight + w₂·reach + w₃·severity + w₄·strategicFit + w₅·urgency
```

Why split them:

- **Re-weighting is free and instant.** `PUT /api/settings/scoring` re-ranks the entire board with **zero inference calls**. A leader can ask "what if severity mattered twice as much?" and get an answer immediately, for nothing.

  This needs a specific mechanism to be true, and it is the part most easily got wrong. Each score carries two fingerprints: one over the *evidence* (what the model judged, who asked) and one that adds the weights. When only the weights move, the totals are recomputed locally and the existing explanation is carried forward rather than re-bought — correct, because the component values it describes have not changed, only their relative contribution. Such a score is flagged `rationaleStale`, the UI says so plainly, and `POST /clusters/:id/rescore?force=true` refreshes the prose on demand. Without this, tuning the weights would cost one Opus call per cluster and nobody would tune them — which would quietly undo the whole reason for separating judgment from arithmetic. There is a test asserting the call count does not move.
- **It is auditable.** Every score persists its components, the weights version it used, and a rationale citing real submitter wording. `priority_scores` is append-only, so "why did this drop last week?" is answerable.
- **It is testable.** `compute.test.ts` pins the properties that make the score defensible, not just the numbers.
- **The hierarchy is not a black box.** Submitter weights and tier multipliers are rows in a table, editable through the API.

Two properties worth calling out, both tested:

- **Submitter weight takes the maximum, not the mean.** One blocked enterprise customer is not made less blocked by ten internal "nice to have" notes. Averaging would let volume from low-weight sources dilute exactly the signal the tier hierarchy exists to protect.
- **Reach saturates.** `100·x/(x+k)` rather than linear growth, so one loud cluster of near-identical tickets cannot dominate the board. ARR is counted per *account*, so two people from the same company do not count their employer's revenue twice.

The model still writes the rationale — and is explicitly instructed to undercut the number where it should: a high score resting on one request from one account is worth less than a middling score drawn from twelve accounts, and the total cannot show that difference.

### Beyond upvoting

Supporting a request requires describing the impact (minimum 15 characters, and the API rejects "+1"):

> *"We hit this every quarter close — two analysts lose a full day assembling the same numbers by hand."*

That text is read by the scoring and brief stages. A vote count is not, because there is nothing in it to read. The support table is unique on `(cluster_id, submitter_id)`, so one account has one voice however many times it clicks — re-supporting updates the description rather than inflating reach.

This costs something real: it is more friction than a button, and fewer people will do it. The trade is deliberate. Ten described impacts are worth more to a prioritisation decision than four hundred anonymous votes, and the described impacts are what end up quoted in the brief a leader actually reads.

### Where the human stays in the loop

| Decision | Who | Mechanism |
|---|---|---|
| Confident duplicate merge | AI | Applied automatically, rationale recorded and shown |
| Uncertain merge | **Human** | Review queue — accept or reject |
| Reversing a merge | **Human** | "This is not the same problem" splits it back out |
| Priority score | AI | Deterministic, explained, re-weightable |
| Roadmap decision | **Human** | Cluster status is set by a person, never by the pipeline |
| Decision brief | AI drafts | Editing writes a new revision; the original is kept |
| Message to a customer | AI drafts | **Never auto-sent.** A person marks it sent |
| Scoring weights | **Human** | `PUT /api/settings/scoring` |

The split follows one rule: **AI does the reading, humans do the deciding.** Automatic merging is only defensible *because* the split control exists and the reasoning is shown to the person whose request was merged.

---

## Measuring whether it works

Three metrics, computed from the audit trail rather than self-reported — `GET /api/analytics/metrics`:

**1. Consolidation rate** — share of requests folded into an existing need. Every request beyond the first in a cluster is one a human did not have to recognise as a duplicate. The seeded corpus reports 33%.

**2. Median time to prioritisation** — the gap between a request arriving and its cluster carrying a score with a rationale. This is the manual-triage latency the system exists to remove; teams typically measure it in days.

**3. Rationale completeness** — the share of ranked clusters carrying a score rationale, evidence and a brief. A prioritisation call nobody can reconstruct in three months is not a decision, it is a memory. This is the quality metric that stops the first two from being gamed by simply merging more aggressively.

`ai_call_log` tracks per-stage calls, cache hits, tokens and latency, so cost per analysed request is answerable at any time (surfaced in the dashboard's telemetry panel).

---

## Cost and latency

AI work never runs inside a request/response cycle. Submission persists the request, enqueues a job, and returns `202` — the submitter is not made to wait on Anthropic's latency or rate limits.

Four layers keep spend down:

- **Response cache** keyed on `(stage, model, promptVersion, systemPrompt, userPrompt)`. Identical analysis is never paid for twice. Cached entries are re-validated against the current schema on read, so a schema change is a cache miss rather than a stale shape reaching the database.
- **Input fingerprinting.** A cluster is re-scored only when something that feeds the score actually changed. Page views cost nothing.
- **Prompt caching.** Each stage's system prompt is identical across every request it processes and is marked `cache_control: ephemeral`, turning the bulk of repeated input into ~0.1× cost cache reads.
- **Job dedupe.** A partial unique index collapses "rescore cluster X" enqueued twice while one is pending. A burst of supporters produces one rescore, not one per click.

Retries use exponential backoff with jitter and honour `retry-after` on rate limits. Failed jobs retry to a cap, then park as `dead` — visible for triage, not silently looping.

---

## Assumptions, risks, tradeoffs

**Customer data is sent to Anthropic.** Request text, submitter type and tier reach the API. Names, emails and ARR figures do not — the prompts pass `customer/enterprise`, never `Priya at Northwind, $240k`. ARR enters only the deterministic scoring maths, which runs locally. For a regulated deployment the next steps are a PII scrub before the extraction stage and a zero-data-retention agreement.

**Hallucination in need extraction is the highest-impact risk.** Everything downstream treats the extracted need as fact. Mitigations: the model reports confidence and is instructed to go low rather than invent detail; low confidence is surfaced in the UI and flagged in the score rationale; the original text is always displayed beside the interpretation. It is mitigated, not solved — a confidently wrong reading of a thin request will still propagate.

**Thin requests produce thin analysis.** "Dark mode" gives the model almost nothing. The submission form asks for the cost of the status quo, and low-confidence extractions are marked rather than hidden.

**Scoring weights encode a policy, and the defaults are a guess.** Ranking customers above prospects above internal is a defensible default, not a universal truth — a PLG company might weight free-tier volume far higher. This is why weights are configuration rather than code, and why every score records the weights version it was computed under.

**Themes drift.** The model is told to reuse existing themes aggressively, and `isNewTheme` is verified against the actual theme list rather than trusted from the model's claim. Over months the taxonomy will still need human pruning; there is no merge-themes endpoint yet.

**Single-process assumptions.** The job queue and rate limiter are in-process. Job claiming is atomic in SQL, so a second worker process is safe today, but the rate limiter would need Redis before running multiple API instances.

**Not built, and would be next:** authentication and authorisation (every mutating endpoint currently takes an `actor` string on trust — this is the largest gap for production), eval harness for the extraction and adjudication stages against a labelled set, theme merging, real notification delivery, and Postgres.

---

## API

Base `/api`. Errors are `{ error: { code, message, details? } }`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/requests` | `202`; accepts `Idempotency-Key` |
| `GET` | `/requests` | `search`, `status`, `submitterType`, `themeId`, `page`, `pageSize` |
| `GET` | `/requests/:id` | Full detail incl. AI reasoning and timeline |
| `POST` | `/requests/:id/support` | Requires an impact description |
| `POST` | `/requests/:id/split` | Human override of a merge |
| `GET` | `/clusters/:id` | Cluster detail, score history, brief, updates |
| `PATCH` | `/clusters/:id/status` | Roadmap status |
| `POST` | `/clusters/:id/brief` | Generates a decision brief (Opus) |
| `POST` | `/clusters/:id/updates` | Drafts a stakeholder message (Opus) |
| `POST` | `/clusters/:id/rescore` | Force a rescore |
| `GET` | `/review/merge-suggestions` | Human review queue |
| `POST` | `/review/merge-suggestions/:id/accept` \| `/reject` | Resolve a suggestion |
| `POST` | `/review/briefs/:id/revise` | Edit or approve a brief |
| `POST` | `/review/updates/:id/sent` | Mark a message sent |
| `GET` | `/analytics/dashboard` | Whole dashboard in one call |
| `GET` | `/analytics/top` · `/by-theme` · `/metrics` · `/activity` | |
| `GET` | `/analytics/emerging` | Cached; `?refresh=true` recomputes |
| `GET`/`PUT` | `/settings/scoring` | Read and re-weight the ranking |
| `GET` | `/health` | AI mode, models, queue depth |

---

## Testing

42 tests, no network calls.

- **`compute.test.ts`** — scoring maths. Pins the properties that make the score defensible: low-weight volume cannot dilute a high-weight voice; ARR counts once per account; reach saturates; re-weighting changes totals without changing judgments.
- **`pipeline.test.ts`** — the AI pipeline against a stubbed adjudicator. Covers confident merge, low-confidence → review queue, hallucinated-id rejection, fingerprint-based rescore skipping, and every human override path.
- **`api.test.ts`** — HTTP contract via supertest. Validation, idempotent replay (including key-reuse-with-different-body → `409`), FTS search including a query made entirely of FTS operator characters, pagination, and the dashboard.

---

## Project rules

`CLAUDE.md` requires every instruction to this repo's AI assistant to be appended to `prompts.txt` with an ISO 8601 timestamp and a summary of the response. That log is maintained.
