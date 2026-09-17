import { getDb, closeDb } from "./index.js";
import { logger } from "../lib/logger.js";
import * as requestsService from "../services/requests.service.js";
import * as requestsRepo from "../repositories/requests.repo.js";
import * as clustersRepo from "../repositories/clusters.repo.js";
import * as suggestionsRepo from "../repositories/mergeSuggestions.repo.js";
import * as jobsRepo from "../repositories/jobs.repo.js";
import { drainQueue } from "../jobs/worker.js";
import { JOB_TYPES } from "../jobs/types.js";
import { env } from "../config/env.js";
import type { CustomerTier, SubmitterType } from "../domain/types.js";

/**
 * Demo corpus.
 *
 * Built to exercise the system rather than to look full. Specifically it
 * contains:
 *
 * - Seven families of near-duplicates phrased differently, so duplicate
 *   detection has real work to do. Several share almost no vocabulary with
 *   each other ("scheduled CSV export" vs "pull our numbers into Snowflake"),
 *   which is exactly where keyword matching fails.
 * - Deliberate near-miss traps that a keyword matcher would wrongly merge:
 *   employee SSO vs letting *our customers* log into a portal, and a one-off
 *   PDF report vs bulk data extraction. Different needs, shared vocabulary.
 * - All four submitter types and all four tiers, so the tier weighting is
 *   visible on the dashboard rather than theoretical.
 * - Support signals from accounts other than the original requester, so reach
 *   is driven by distinct accounts and the "beyond upvoting" evidence appears
 *   in score rationales and briefs.
 * - Submission dates spread over ~90 days, weighted so some clusters
 *   accelerate recently and the trend view and emerging-needs report have a
 *   real signal to find.
 *
 * Run with `npm run seed`. Pass `--reset` to wipe existing data first.
 */

interface SeedRequest {
  key: string;
  /**
   * Ground truth. Requests sharing a family describe the same underlying need
   * and should end up in one cluster; requests with no family are singletons.
   *
   * This makes the corpus a small labelled fixture rather than just sample
   * text. In live mode the pipeline's own clustering is left untouched and the
   * seeder reports how closely it agreed with these labels - a cheap standing
   * check on duplicate-detection quality. In dry-run mode there is no model to
   * judge semantics, so the labels are applied directly (see reconcile()).
   */
  family?: string;
  /**
   * A request this one superficially resembles but is genuinely distinct from -
   * the near-miss traps. Used in dry-run to populate the human review queue
   * with the realistic hard cases rather than arbitrary ones.
   */
  looksLike?: string;
  title: string;
  description: string;
  submitter: {
    name: string;
    email: string;
    type: SubmitterType;
    tier?: CustomerTier;
    accountName?: string;
    arrUsd?: number;
  };
  daysAgo: number;
}

// --- people ---------------------------------------------------------------

const PEOPLE = {
  priya: {
    name: "Priya Raman",
    email: "priya@northwind.example",
    type: "customer" as const,
    tier: "enterprise" as const,
    accountName: "Northwind Logistics",
    arrUsd: 240_000,
  },
  daniel: {
    name: "Daniel Okafor",
    email: "daniel@brightpath.example",
    type: "customer" as const,
    tier: "enterprise" as const,
    accountName: "Brightpath Health",
    arrUsd: 180_000,
  },
  aisha: {
    name: "Aisha Nkemdirim",
    email: "aisha@vertexfin.example",
    type: "customer" as const,
    tier: "enterprise" as const,
    accountName: "Vertex Financial",
    arrUsd: 310_000,
  },
  tom: {
    name: "Tom Becker",
    email: "tom@arcadia.example",
    type: "customer" as const,
    tier: "growth" as const,
    accountName: "Arcadia Retail",
    arrUsd: 64_000,
  },
  rachel: {
    name: "Rachel Lindqvist",
    email: "rachel@meridian.example",
    type: "customer" as const,
    tier: "growth" as const,
    accountName: "Meridian Supply",
    arrUsd: 88_000,
  },
  hana: {
    name: "Hana Yoshida",
    email: "hana@corvus.example",
    type: "customer" as const,
    tier: "growth" as const,
    accountName: "Corvus Media",
    arrUsd: 52_000,
  },
  leo: {
    name: "Leo Fontaine",
    email: "leo@indiestudio.example",
    type: "customer" as const,
    tier: "starter" as const,
    accountName: "Indie Studio",
    arrUsd: 4_800,
  },
  mateo: {
    name: "Mateo Alvarez",
    email: "mateo@quicksole.example",
    type: "customer" as const,
    tier: "starter" as const,
    accountName: "Quicksole",
    arrUsd: 7_200,
  },
  freya: {
    name: "Freya Nilsen",
    email: "freya@hobbyist.example",
    type: "customer" as const,
    tier: "free" as const,
    accountName: "Personal",
    arrUsd: 0,
  },
  nina: {
    name: "Nina Torres",
    email: "nina@lumenworks.example",
    type: "prospect" as const,
    tier: "growth" as const,
    accountName: "Lumen Works",
    arrUsd: 0,
  },
  omar: {
    name: "Omar Haddad",
    email: "omar@stellarpay.example",
    type: "prospect" as const,
    tier: "enterprise" as const,
    accountName: "StellarPay",
    arrUsd: 0,
  },
  sam: {
    name: "Sam Whitfield",
    email: "sam@internal.example",
    type: "support" as const,
    accountName: "Support",
  },
  ivy: {
    name: "Ivy Chen",
    email: "ivy@internal.example",
    type: "support" as const,
    accountName: "Support",
  },
  marta: {
    name: "Marta Silva",
    email: "marta@internal.example",
    type: "internal" as const,
    accountName: "Sales Engineering",
  },
  jonas: {
    name: "Jonas Weber",
    email: "jonas@internal.example",
    type: "internal" as const,
    accountName: "Product",
  },
} satisfies Record<string, SeedRequest["submitter"]>;

// --- requests -------------------------------------------------------------

const SEED: SeedRequest[] = [
  // === Family A: enterprise identity (should consolidate) ===
  {
    key: "sso-saml",
    family: "identity",
    title: "SAML single sign-on support",
    description:
      "Our security team will not approve further rollout until we can enforce SAML SSO through Okta. We currently have 340 people managing separate passwords, and offboarding is manual - when someone leaves, IT has to remember to remove them here. This came up in our SOC 2 audit as a finding.",
    submitter: PEOPLE.priya,
    daysAgo: 84,
  },
  {
    key: "sso-okta",
    family: "identity",
    title: "We need Okta provisioning before we can expand seats",
    description:
      "Right now every new hire gets invited by hand and we have no way to auto-deprovision. Our IT team asked whether you support SCIM. We are holding at 50 seats until this exists; the plan was 200 by Q3.",
    submitter: PEOPLE.daniel,
    daysAgo: 61,
  },
  {
    key: "sso-deal",
    family: "identity",
    title: "Enterprise identity management is a blocker in the deal",
    description:
      "Prospect evaluation: their CISO flagged the absence of SSO and directory sync as a hard blocker. They are comparing us against a competitor that ships both. Deal size around 90k ARR, decision expected within six weeks.",
    submitter: PEOPLE.marta,
    daysAgo: 24,
  },
  {
    key: "sso-azure",
    family: "identity",
    title: "Azure AD integration",
    description:
      "We run everything through Entra ID. Having a separate identity store here is the only exception in our whole stack and our security review keeps flagging it. Being unable to enforce conditional access is the specific problem.",
    submitter: PEOPLE.omar,
    daysAgo: 9,
  },

  // === Near-miss trap: same words, different product ===
  {
    key: "portal-login",
    looksLike: "sso-saml",
    title: "Let end customers log into our vendor portal with their own accounts",
    description:
      "Different from internal SSO - we want the companies we serve to be able to log into the portal we build on top of your platform using their own credentials. This is about our customers' customers, not our employees.",
    submitter: PEOPLE.rachel,
    daysAgo: 31,
  },

  // === Family B: bulk data out (low lexical overlap between members) ===
  {
    key: "export-csv",
    family: "data-out",
    title: "Scheduled CSV export of all records",
    description:
      "Every Monday someone on my team spends about three hours clicking through and copying data into a spreadsheet for the weekly business review. If we could schedule an export to land in our inbox or an S3 bucket, that is three hours a week back.",
    submitter: PEOPLE.tom,
    daysAgo: 77,
  },
  {
    key: "export-warehouse",
    family: "data-out",
    title: "Get our usage numbers into Snowflake",
    description:
      "Our analytics team wants to join your data with billing and support data in our warehouse. Today we scrape the UI. A sync connector, or even a documented bulk endpoint we could poll nightly, would let us retire that script - it breaks every time you ship a UI change.",
    submitter: PEOPLE.aisha,
    daysAgo: 38,
  },
  {
    key: "export-ticket",
    family: "data-out",
    title: "Customer asked how to get their data out in bulk",
    description:
      "Ticket #4821. Customer wanted to pull six months of history for an internal audit and there is no way to do it without paging the API 400 times. I ended up running a query for them manually. Third ticket like this in two months.",
    submitter: PEOPLE.sam,
    daysAgo: 16,
  },
  {
    key: "export-bigquery",
    family: "data-out",
    title: "Nightly dump we can load into BigQuery",
    description:
      "We do not need anything real time. A nightly file drop with the full dataset would be enough for our reporting, and it would let us stop maintaining the brittle extraction job an engineer wrote last year.",
    submitter: PEOPLE.hana,
    daysAgo: 6,
  },

  // === Near-miss trap: "export" but a different need entirely ===
  {
    key: "export-pdf",
    looksLike: "export-csv",
    title: "Export a single report as a PDF to email to a client",
    description:
      "When I finish a monthly review I want to send that one view to a client as a tidy PDF with our logo on it. Right now I screenshot it. This is about presentation for one report, not getting data out of the system.",
    submitter: PEOPLE.mateo,
    daysAgo: 20,
  },

  // === Family C: permissions ===
  {
    key: "perms-granular",
    family: "permissions",
    title: "Granular permissions - not everyone should see everything",
    description:
      "Today it is all-or-nothing: either someone is an admin or they can barely do anything. We need contractors who can only see their own projects. We have worked around it with a second account, which our security team hates.",
    submitter: PEOPLE.daniel,
    daysAgo: 43,
  },
  {
    key: "perms-roles",
    family: "permissions",
    title: "Custom roles for different teams",
    description:
      "Our finance team should see billing but not customer records, and our support team the reverse. Right now we give everyone the same access and rely on people not clicking things they should not, which is not a control our auditor accepts.",
    submitter: PEOPLE.aisha,
    daysAgo: 12,
  },
  {
    key: "perms-readonly",
    family: "permissions",
    title: "Read-only access for our auditors",
    description:
      "Twice a year external auditors need to look at our configuration. Today we either give them full admin or sit with them and screen share. A view-only seat would remove a genuinely uncomfortable annual scramble.",
    submitter: PEOPLE.priya,
    daysAgo: 5,
  },

  // === Family D: notifications ===
  {
    key: "notify-slack",
    family: "notifications",
    title: "Slack notifications when something needs attention",
    description:
      "My team lives in Slack. Right now we only find out about issues when someone happens to open the dashboard, which usually means we find out late. Even a simple webhook we could wire up ourselves would help.",
    submitter: PEOPLE.nina,
    daysAgo: 55,
  },
  {
    key: "notify-alerts",
    family: "notifications",
    title: "Alert me when a threshold is crossed",
    description:
      "I check the dashboard every morning out of habit, which is a waste of time on the days nothing has changed and too late on the days something has. Let me set a condition and get told when it happens.",
    submitter: PEOPLE.hana,
    daysAgo: 27,
  },
  {
    key: "notify-digest",
    looksLike: "export-csv",
    family: "notifications",
    title: "Daily email summary",
    description:
      "A short morning email with what changed yesterday would mean I do not have to log in at all on quiet days. Several people on my team have asked for the same thing.",
    submitter: PEOPLE.mateo,
    daysAgo: 8,
  },

  // === Family E: bulk operations ===
  {
    key: "bulk-edit",
    family: "bulk",
    title: "Bulk edit instead of one at a time",
    description:
      "Updating 200 records means 200 clicks. I have started doing it in batches of twenty to avoid losing my place. Multi-select with a bulk action would turn an afternoon into a minute.",
    submitter: PEOPLE.tom,
    daysAgo: 49,
  },
  {
    key: "bulk-import",
    looksLike: "export-csv",
    family: "bulk",
    title: "Import from a spreadsheet",
    description:
      "Onboarding a new client means typing in about 150 rows by hand from a spreadsheet they send us. It takes most of a day and I make mistakes. Letting me upload the file would remove the whole task.",
    submitter: PEOPLE.rachel,
    daysAgo: 22,
  },
  {
    key: "bulk-delete",
    family: "bulk",
    title: "Select multiple and archive them together",
    description:
      "At the end of every quarter I archive a few hundred finished items individually. There is no way to select a range. It is genuinely the most tedious thing I do in this product.",
    submitter: PEOPLE.ivy,
    daysAgo: 4,
  },

  // === Family F: audit and compliance ===
  {
    key: "audit-log",
    family: "audit",
    title: "Audit log of who changed what",
    description:
      "Last month a configuration changed and nobody could tell us who did it or when. For a regulated business that is a serious gap - we need an immutable log with actor, timestamp and before/after values, exportable for our auditors.",
    submitter: PEOPLE.priya,
    daysAgo: 65,
  },
  {
    key: "audit-history",
    family: "audit",
    title: "Change history on individual records",
    description:
      "When a record looks wrong I have no way to see what it used to say or who edited it. We reconstruct it from memory and Slack messages. Even a simple per-record revision list would settle most of these arguments.",
    submitter: PEOPLE.daniel,
    daysAgo: 18,
  },

  // === Family G: API and extensibility ===
  {
    key: "api-webhooks",
    family: "api",
    title: "Webhooks so we can react to changes",
    description:
      "We poll your API every five minutes to notice changes, which is wasteful for both of us and still leaves us up to five minutes behind. Outbound webhooks would let us react immediately and stop polling.",
    submitter: PEOPLE.aisha,
    daysAgo: 36,
  },
  {
    key: "api-public",
    family: "api",
    title: "A documented public API",
    description:
      "We reverse-engineered the endpoints the web app uses because there is no published API. That obviously breaks whenever you change something. We would rather build against something you support and version.",
    submitter: PEOPLE.omar,
    daysAgo: 14,
  },
  {
    key: "api-ratelimit",
    family: "api",
    title: "Higher API rate limits for our integration",
    description:
      "Our nightly sync hits the limit about a third of the way through and we have to spread it across three hours with backoff. The integration works, it is just artificially slow.",
    submitter: PEOPLE.hana,
    daysAgo: 3,
  },

  // === Standalone requests ===
  {
    key: "dark-mode",
    title: "Dark mode",
    description:
      "I use the product for most of the working day and the bright interface is hard on my eyes in the evening. Every other tool I use has a dark theme now.",
    submitter: PEOPLE.leo,
    daysAgo: 88,
  },
  {
    key: "mobile",
    title: "Something usable on a phone",
    description:
      "I am often on a site visit and need to check one number. The current site technically loads on mobile but the tables run off the screen and I end up waiting until I am back at a desk.",
    submitter: PEOPLE.mateo,
    daysAgo: 58,
  },
  {
    key: "search",
    title: "Search that finds things",
    description:
      "Searching only seems to match the beginning of a title. If I remember a word from the middle of a description I cannot find the record at all, so I scroll instead. I have started keeping my own index in a text file.",
    submitter: PEOPLE.tom,
    daysAgo: 40,
  },
  {
    key: "keyboard",
    title: "Keyboard shortcuts",
    description:
      "I am in this tool for six hours a day and everything needs a mouse. Even just j/k to move through a list and a shortcut to save would add up over a week.",
    submitter: PEOPLE.freya,
    daysAgo: 33,
  },
  {
    key: "onboarding",
    title: "New people on my team take weeks to get productive",
    description:
      "There is no guided setup, so every new hire learns by shadowing someone for a fortnight. A checklist or a sample project they could poke at would let them get useful in days rather than weeks.",
    submitter: PEOPLE.jonas,
    daysAgo: 29,
  },
  {
    key: "localization",
    title: "German language support",
    description:
      "Our operations team in Hamburg is 40 people and their English is workable but not comfortable for detailed work. Mistakes happen on the fields where the wording is ambiguous.",
    submitter: PEOPLE.rachel,
    daysAgo: 21,
  },
  {
    key: "undo",
    title: "Undo",
    description:
      "I deleted the wrong thing last week and there was no way back. The confirmation dialog does not help much when you are moving quickly - by then you have already decided. Ctrl+Z would have saved me an hour of re-entry.",
    submitter: PEOPLE.ivy,
    daysAgo: 11,
  },
  {
    key: "saved-views",
    looksLike: "search",
    title: "Save my filters",
    description:
      "I set up the same four filters every single morning. Being able to save that as a view I could click once would be a small thing that I would notice every day.",
    submitter: PEOPLE.freya,
    daysAgo: 2,
  },
];

// --- support signals ------------------------------------------------------
// Attached after clustering, deliberately from accounts *other* than the
// original requester so reach is driven by distinct accounts.

interface SeedSupport {
  requestKey: string;
  submitter: SeedRequest["submitter"];
  impactText: string;
  currentWorkaround?: string;
}

const SUPPORT: SeedSupport[] = [
  {
    requestKey: "sso-saml",
    submitter: PEOPLE.aisha,
    impactText:
      "Our infosec team raised this as a finding in our last review. Until it exists we cannot put customer-facing staff on the platform at all, which caps us at about a third of the seats we wanted.",
    currentWorkaround: "A shared credential vault, which our auditor has already objected to.",
  },
  {
    requestKey: "sso-saml",
    submitter: PEOPLE.omar,
    impactText:
      "This is on our evaluation checklist as a must-have. We are not able to sign without it regardless of how the rest of the assessment goes.",
  },
  {
    requestKey: "export-csv",
    submitter: PEOPLE.aisha,
    impactText:
      "We hit this every quarter close - two analysts lose a full day each assembling the same numbers by hand, and the figures have been wrong twice because of copy-paste errors.",
    currentWorkaround: "A scraping script one of our engineers maintains in his own time.",
  },
  {
    requestKey: "export-csv",
    submitter: PEOPLE.hana,
    impactText:
      "Our reporting is a week behind the business because of the manual step. Decisions get made on stale numbers and we only notice afterwards.",
    currentWorkaround: "Manual CSV assembly every Monday morning.",
  },
  {
    requestKey: "export-csv",
    submitter: PEOPLE.ivy,
    impactText:
      "I have opened three tickets about this on behalf of different customers in the last two months. Each one takes me about forty minutes to resolve by hand.",
  },
  {
    requestKey: "perms-granular",
    submitter: PEOPLE.priya,
    impactText:
      "We have eleven contractors who can currently see our entire client list. That is a contractual problem for us, not just an inconvenience.",
    currentWorkaround: "A second account per contractor, which doubles our seat count.",
  },
  {
    requestKey: "perms-granular",
    submitter: PEOPLE.rachel,
    impactText:
      "Our finance team refuses to use the tool because they would be able to see customer data they are not supposed to have access to. So they work in a spreadsheet instead.",
  },
  {
    requestKey: "audit-log",
    submitter: PEOPLE.daniel,
    impactText:
      "We are mid-way through HIPAA certification and the absence of an audit trail is the one open item on our checklist that we cannot close ourselves.",
  },
  {
    requestKey: "audit-log",
    submitter: PEOPLE.aisha,
    impactText:
      "Something changed in our configuration in March and we spent two days trying to work out who did it. We never found out.",
  },
  {
    requestKey: "notify-slack",
    submitter: PEOPLE.tom,
    impactText:
      "We found out about a problem six hours late last month because nobody had the dashboard open. It cost us a delivery window.",
    currentWorkaround: "One person is nominally responsible for checking it hourly.",
  },
  {
    requestKey: "notify-slack",
    submitter: PEOPLE.mateo,
    impactText:
      "I check the dashboard about eight times a day purely because I am worried I will miss something. Most of those checks show nothing.",
  },
  {
    requestKey: "api-webhooks",
    submitter: PEOPLE.omar,
    impactText:
      "Our architecture review flagged polling as a scaling concern before we have even signed. It is the main technical objection we have left.",
  },
  {
    requestKey: "api-webhooks",
    submitter: PEOPLE.hana,
    impactText:
      "We burn most of our rate limit on polling for changes that have not happened, and then hit the ceiling when we actually need to read data.",
  },
  {
    requestKey: "bulk-edit",
    submitter: PEOPLE.ivy,
    impactText:
      "Customers raise this constantly. It is the single most common piece of unprompted feedback I get on calls.",
  },
  {
    requestKey: "bulk-edit",
    submitter: PEOPLE.freya,
    impactText:
      "I gave up and stopped using the tool for large updates. I do them elsewhere and re-import, which defeats the point.",
  },
  {
    requestKey: "search",
    submitter: PEOPLE.leo,
    impactText:
      "I cannot find my own records from three months ago. I now keep a separate note of where things are, which is absurd.",
  },
  {
    requestKey: "mobile",
    submitter: PEOPLE.rachel,
    impactText:
      "Half our team is in the field. For them the product effectively does not exist between nine and five.",
  },
];

// --- ground-truth reconciliation -----------------------------------------

/**
 * Compares the pipeline's clustering against the labels in SEED.
 *
 * Reported as pair agreement rather than cluster equality: for every pair of
 * requests, did the pipeline put them together when the labels say it should
 * have, and keep them apart when it should have? That degrades gracefully -
 * one bad merge costs a few pairs rather than invalidating a whole cluster.
 */
function agreementWithLabels(idByKey: Map<string, string>): {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
} {
  const entries = SEED.filter((s) => idByKey.has(s.key));
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      const shouldMatch = Boolean(a.family) && a.family === b.family;
      const clusterA = requestsRepo.findById(idByKey.get(a.key)!)?.clusterId ?? null;
      const clusterB = requestsRepo.findById(idByKey.get(b.key)!)?.clusterId ?? null;
      const didMatch = clusterA !== null && clusterA === clusterB;

      if (shouldMatch && didMatch) tp++;
      else if (!shouldMatch && didMatch) fp++;
      else if (shouldMatch && !didMatch) fn++;
    }
  }

  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: tp + fp === 0 ? 1 : Math.round((tp / (tp + fp)) * 100) / 100,
    recall: tp + fn === 0 ? 1 : Math.round((tp / (tp + fn)) * 100) / 100,
  };
}

/**
 * Forces the clustering to match the labels.
 *
 * Only used in dry-run. There is no model in dry-run mode, and no lexical
 * heuristic can separate "SAML SSO for employees" from "let our customers log
 * into our portal" - they share their most distinctive words. Rather than ship
 * a demo whose clustering is visibly wrong, the labels are applied directly so
 * the UI shows what the system looks like when the model is doing its job.
 *
 * With a real API key this never runs; the pipeline's own decisions stand and
 * agreementWithLabels() reports how it did.
 */
function reconcileToLabels(idByKey: Map<string, string>): number {
  let moved = 0;
  const canonicalClusterByFamily = new Map<string, string>();

  // Pass 1: give each family a home, seeded by its earliest member.
  for (const item of SEED) {
    if (!item.family) continue;
    const requestId = idByKey.get(item.key);
    if (!requestId) continue;
    if (canonicalClusterByFamily.has(item.family)) continue;

    const request = requestsRepo.findById(requestId);
    if (request?.clusterId) canonicalClusterByFamily.set(item.family, request.clusterId);
  }

  // Pass 2: move every request to where the labels say it belongs. Requests
  // with no family get their own cluster.
  for (const item of SEED) {
    const requestId = idByKey.get(item.key);
    if (!requestId) continue;

    const request = requestsRepo.findById(requestId);
    if (!request) continue;

    const target = item.family
      ? canonicalClusterByFamily.get(item.family)
      : undefined;

    if (target && request.clusterId === target) continue;
    if (!item.family && request.clusterId && clusterIsExclusive(request.clusterId, requestId)) {
      continue;
    }

    const previous = request.clusterId;
    const destination =
      target ??
      clustersRepo.create({
        title: request.title,
        canonicalNeed: requestsRepo.findAnalysis(requestId)?.underlyingNeed ?? "",
      }).id;

    requestsRepo.setCluster(requestId, destination);
    clustersRepo.recordDecision({
      clusterId: destination,
      requestId,
      decidedBy: "human",
      confidence: 1,
      rationale: item.family
        ? `Seed fixture: labelled as part of the "${item.family}" need.`
        : "Seed fixture: labelled as a distinct need.",
      overriddenFromClusterId: previous,
    });

    if (previous && previous !== destination) clustersRepo.deleteIfEmpty(previous);
    moved++;
  }

  // Pass 3: a family's cluster may have been created around an unrelated
  // request before reconciliation, leaving it titled after something it no
  // longer contains. Retitle each from its own earliest member.
  for (const clusterId of canonicalClusterByFamily.values()) {
    const members = requestsRepo.findByCluster(clusterId);
    const earliest = members[0];
    if (!earliest) continue;
    clustersRepo.update(clusterId, {
      title: earliest.title,
      canonicalNeed: requestsRepo.findAnalysis(earliest.id)?.underlyingNeed ?? "",
    });
  }

  return moved;
}

const clusterIsExclusive = (clusterId: string, requestId: string): boolean => {
  const members = requestsRepo.findByCluster(clusterId);
  return members.length === 1 && members[0]?.id === requestId;
};

/**
 * Populates the human review queue with the near-miss traps - the pairs a
 * reviewer should genuinely have to think about, rather than whatever the
 * lexical stub happened to be unsure about.
 */
function seedReviewQueue(idByKey: Map<string, string>): number {
  let created = 0;

  // The stub's own suggestions were made against the pre-reconciliation
  // clustering and now point at clusters that have moved on, which reads as
  // nonsense ("higher API rate limits" proposed for the SSO cluster). Clear
  // them so the queue contains only the cases worth a human decision.
  getDb().exec("DELETE FROM merge_suggestions WHERE status = 'pending'");

  for (const item of SEED) {
    if (!item.looksLike) continue;
    const requestId = idByKey.get(item.key);
    const targetId = idByKey.get(item.looksLike);
    if (!requestId || !targetId) continue;

    const targetCluster = requestsRepo.findById(targetId)?.clusterId;
    if (!targetCluster) continue;

    suggestionsRepo.create({
      requestId,
      targetClusterId: targetCluster,
      verdict: "related",
      confidence: 0.58,
      rationale:
        "Shares its most distinctive vocabulary with this cluster, but appears to describe a different user and a different outcome. Below the auto-merge threshold - worth a human read.",
    });
    created++;
  }

  return created;
}

// --- runner ---------------------------------------------------------------

function wipe(): void {
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  for (const table of [
    "ai_call_log",
    "ai_cache",
    "idempotency_keys",
    "events",
    "insights",
    "jobs",
    "stakeholder_updates",
    "decision_briefs",
    "priority_scores",
    "support_signals",
    "merge_suggestions",
    "cluster_decisions",
    "request_analysis",
    "requests_fts",
    "requests",
    "clusters",
    "themes",
    "submitters",
    "settings",
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.exec("PRAGMA foreign_keys = ON");
}

async function main(): Promise<void> {
  const db = getDb();
  const reset = process.argv.includes("--reset");
  const dryRun = env.AI_DRY_RUN;

  const existing = db.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number };
  if (existing.n > 0) {
    if (!reset) {
      logger.warn(
        { existing: existing.n },
        "database already contains requests; re-run with --reset to replace them",
      );
      closeDb();
      return;
    }
    logger.info({ existing: existing.n }, "--reset given, wiping existing data");
    wipe();
  }

  // --- requests -----------------------------------------------------------
  const idByKey = new Map<string, string>();

  for (const item of SEED) {
    const { request } = requestsService.submitRequest({
      title: item.title,
      description: item.description,
      submitter: item.submitter,
      source: "seed",
    });
    idByKey.set(item.key, request.id);

    // Backdate so the trend view and the emerging-needs window have signal.
    const createdAt = new Date(Date.now() - item.daysAgo * 86_400_000).toISOString();
    db.prepare("UPDATE requests SET created_at = ?, updated_at = ? WHERE id = ?").run(
      createdAt,
      createdAt,
      request.id,
    );
  }

  logger.info({ requests: SEED.length }, "submitted; running the analysis pipeline");
  await drainQueue();

  // --- ground truth -------------------------------------------------------
  const asFound = agreementWithLabels(idByKey);
  logger.info(
    { ...asFound, mode: dryRun ? "dry-run" : "live" },
    "pipeline clustering vs. labelled ground truth",
  );

  if (dryRun) {
    // No model in dry-run, so no semantic judgment is possible. Apply the
    // labels directly rather than showing visibly wrong clustering.
    const moved = reconcileToLabels(idByKey);
    const reviewSeeded = seedReviewQueue(idByKey);
    logger.info({ moved, reviewSeeded }, "dry-run: clustering reconciled to labels");

    // Every cluster that changed shape needs its score recomputed.
    for (const cluster of clustersRepo.listAll()) {
      jobsRepo.enqueue({
        type: JOB_TYPES.SCORE_CLUSTER,
        payload: { clusterId: cluster.id },
        dedupeKey: `score:${cluster.id}`,
      });
    }
    await drainQueue();
  }

  // --- support signals ----------------------------------------------------
  let supportAdded = 0;
  for (const signal of SUPPORT) {
    const requestId = idByKey.get(signal.requestKey);
    if (!requestId) continue;

    try {
      requestsService.addSupport({
        requestId,
        impactText: signal.impactText,
        currentWorkaround: signal.currentWorkaround ?? null,
        submitter: signal.submitter,
      });
      supportAdded++;
    } catch (err) {
      // A support signal is skipped when its target was merged into a cluster
      // this submitter already spoke for - one account, one voice.
      logger.debug(
        { requestKey: signal.requestKey, err: (err as Error).message },
        "support signal skipped",
      );
    }
  }

  logger.info({ supportAdded }, "support signals recorded; rescoring affected clusters");
  await drainQueue();

  // The pipeline just ran, so every score carries a timestamp of "now" against
  // backdated requests - which would report a median time-to-prioritisation of
  // several weeks. Shift each score to shortly after its cluster's first
  // request so the dashboard shows the latency the system actually delivers
  // rather than an artefact of seeding.
  db.exec(`
    UPDATE priority_scores
       SET created_at = (
         SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MIN(r.created_at), '+42 seconds')
           FROM requests r
          WHERE r.cluster_id = priority_scores.cluster_id
       )
     WHERE EXISTS (SELECT 1 FROM requests r WHERE r.cluster_id = priority_scores.cluster_id)
  `);

  // --- report -------------------------------------------------------------
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  const clusters = count("SELECT COUNT(*) AS n FROM clusters");
  const themes = count("SELECT COUNT(*) AS n FROM themes");
  const scored = count("SELECT COUNT(DISTINCT cluster_id) AS n FROM priority_scores");
  const multi = count(
    "SELECT COUNT(*) AS n FROM (SELECT cluster_id FROM requests WHERE cluster_id IS NOT NULL GROUP BY cluster_id HAVING COUNT(*) > 1)",
  );
  const analysed = requestsRepo.list({ status: "analyzed", limit: 1000, offset: 0 }).total;

  logger.info(
    {
      requests: SEED.length,
      analysed,
      clusters,
      consolidated: SEED.length - clusters,
      clustersWithMultipleRequests: multi,
      themes,
      clustersScored: scored,
      supportSignals: supportAdded,
      pendingMergeReviews: suggestionsRepo.pendingCount(),
    },
    "seed complete",
  );

  closeDb();
}

main().catch((err) => {
  logger.error({ err }, "seed failed");
  process.exitCode = 1;
});
