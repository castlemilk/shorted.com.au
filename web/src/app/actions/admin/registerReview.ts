"use server";

// Server actions for the register review console.
//
// EVERY action here calls requireAdmin() ITSELF, not merely because it lives
// under /admin. Server actions are globally addressable by action-id and can be
// POSTed to a route outside the /admin matcher, so the middleware gate alone is
// bypassable — that is precisely the shape of the sendBroadcast defect the
// 2026-07 audit found (a write with no requireAdmin at all).
//
// The RPCs behind these are ALSO in internalOnlyMethods, so the internal secret
// is required on top of an admin identity. A decision here writes a curated
// alias, and a curated alias is the one match method the public gate lets
// publish a live company link against a named politician.

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { revalidatePath } from "next/cache";

import { RegisterReviewService } from "~/gen/registerreview/v1/register_review_pb";
import { requireAdmin } from "~/server/admin";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "../config";

/** The decision vocabulary, mirroring the proto enum. No fuzzy member exists. */
export type ReviewDecision =
  | "resolved"
  | "not_a_security"
  | "unlisted_fund"
  | "foreign"
  | "skip";

const DECISION_ENUM: Record<ReviewDecision, number> = {
  resolved: 1,
  not_a_security: 2,
  unlisted_fund: 3,
  foreign: 4,
  skip: 5,
};

export type ReviewAliasKind = "equity" | "etf" | "lic" | "managed_fund";

const ALIAS_KIND_ENUM: Record<ReviewAliasKind, number> = {
  equity: 1,
  etf: 2,
  lic: 3,
  managed_fund: 4,
};

async function reviewClient() {
  const admin = await requireAdmin();
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
  });
  return {
    client: createClient(RegisterReviewService, transport),
    headers: {
      "X-Internal-Secret": process.env.INTERNAL_SECRET ?? "dev-internal-secret",
      // curated_by is read from this header server-side, never from the request
      // body: a body-supplied identity is one the caller chose for themselves.
      "X-User-Email": admin.email,
      "X-User-Id": admin.userId,
    },
  };
}

/**
 * Plain-object shapes returned to the client component.
 *
 * The protobuf messages carry BigInt-adjacent generated types and a `$typeName`
 * that does not survive the RSC boundary cleanly, so everything is mapped to
 * plain data here — the same rule the housing surfaces learned (a formatter
 * function or a class instance across the boundary is a runtime error, not a
 * type error).
 */
export interface QueueSample {
  declaredText: string;
  politicianName: string;
  politicianSlug: string;
  itemNo: number;
  parliament: number;
  sourceUrl: string;
}

export interface QueueListing {
  stockCode: string;
  companyName: string;
  existingUses: number;
  isStopwordTicker: boolean;
}

export interface QueueProposal {
  proposedStockCode: string;
  proposedCompanyName: string;
  confidence: number;
  rationale: string;
  model: string;
  status: string;
  shortlist: QueueListing[];
}

export interface QueueItem {
  candidateNorm: string;
  example: string;
  occurrences: number;
  people: number;
  items: number[];
  parliaments: number[];
  entityKinds: string[];
  gateRows: number;
  skipCount: number;
  samples: QueueSample[];
  proposal: QueueProposal | null;
}

export interface Coverage {
  resolved: number;
  listedCandidates: number;
  gatePercent: number;
  backlogCandidates: number;
  backlogRows: number;
  classifiedOut: number;
  method: string;
}

export interface QueuePage {
  items: QueueItem[];
  totalCandidates: number;
  totalRows: number;
}

function toListing(l: {
  stockCode: string;
  companyName: string;
  existingUses: number;
  isStopwordTicker: boolean;
}): QueueListing {
  return {
    stockCode: l.stockCode,
    companyName: l.companyName,
    existingUses: Number(l.existingUses ?? 0),
    isStopwordTicker: !!l.isStopwordTicker,
  };
}

export async function listSecurityQueue(
  limit = 25,
  offset = 0,
  gateOnly = false,
): Promise<QueuePage> {
  const { client, headers } = await reviewClient();
  const resp = await client.listSecurityQueue({ limit, offset, gateOnly }, { headers });

  return {
    totalCandidates: Number(resp.totalCandidates ?? 0),
    totalRows: Number(resp.totalRows ?? 0),
    items: (resp.items ?? []).map((i) => ({
      candidateNorm: i.candidateNorm,
      example: i.example,
      occurrences: Number(i.occurrences ?? 0),
      people: Number(i.people ?? 0),
      items: (i.items ?? []).map(Number),
      parliaments: (i.parliaments ?? []).map(Number),
      entityKinds: i.entityKinds ?? [],
      gateRows: Number(i.gateRows ?? 0),
      skipCount: Number(i.skipCount ?? 0),
      samples: (i.samples ?? []).map((s) => ({
        declaredText: s.declaredText,
        politicianName: s.politicianName,
        politicianSlug: s.politicianSlug,
        itemNo: Number(s.itemNo ?? 0),
        parliament: Number(s.parliament ?? 0),
        sourceUrl: s.sourceUrl,
      })),
      proposal: i.proposal
        ? {
            proposedStockCode: i.proposal.proposedStockCode,
            proposedCompanyName: i.proposal.proposedCompanyName,
            confidence: Number(i.proposal.confidence ?? 0),
            rationale: i.proposal.rationale,
            model: i.proposal.model,
            status: i.proposal.status,
            shortlist: (i.proposal.shortlist ?? []).map(toListing),
          }
        : null,
    })),
  };
}

export async function searchListings(query: string, limit = 15): Promise<QueueListing[]> {
  if (!query.trim()) return [];
  const { client, headers } = await reviewClient();
  const resp = await client.searchListings({ query, limit }, { headers });
  return (resp.listings ?? []).map(toListing);
}

export async function getCoverageStats(): Promise<Coverage | null> {
  const { client, headers } = await reviewClient();
  const resp = await client.getCoverageStats({}, { headers });
  return resp.coverage ? toCoverage(resp.coverage) : null;
}

function toCoverage(c: {
  resolved: number;
  listedCandidates: number;
  gatePercent: number;
  backlogCandidates: number;
  backlogRows: number;
  classifiedOut: number;
  method: string;
}): Coverage {
  return {
    resolved: Number(c.resolved ?? 0),
    listedCandidates: Number(c.listedCandidates ?? 0),
    gatePercent: Number(c.gatePercent ?? 0),
    backlogCandidates: Number(c.backlogCandidates ?? 0),
    backlogRows: Number(c.backlogRows ?? 0),
    classifiedOut: Number(c.classifiedOut ?? 0),
    method: c.method,
  };
}

export interface DecisionResult {
  ok: boolean;
  rowsAffected: number;
  coverage: Coverage | null;
  /** Set when the server refused. Surfaced verbatim — never swallowed. */
  error?: string;
  /** True when the refusal was the stopword-ticker guard, which the UI can retry with a confirmation. */
  needsStopwordConfirm?: boolean;
}

export async function decideSecurityCandidate(input: {
  candidateNorm: string;
  decision: ReviewDecision;
  stockCode?: string;
  aliasKind?: ReviewAliasKind;
  note?: string;
  stopwordConfirmed?: boolean;
}): Promise<DecisionResult> {
  const { client, headers } = await reviewClient();

  try {
    const resp = await client.decideSecurityCandidate(
      {
        candidateNorm: input.candidateNorm,
        decision: DECISION_ENUM[input.decision],
        stockCode: input.stockCode ?? "",
        aliasKind: input.aliasKind ? ALIAS_KIND_ENUM[input.aliasKind] : 0,
        note: input.note ?? "",
        stopwordConfirmed: !!input.stopwordConfirmed,
      },
      { headers },
    );
    // The queue is server-rendered, so the next page load must not serve a
    // candidate this reviewer just decided.
    revalidatePath("/admin/register/securities");
    return {
      ok: true,
      rowsAffected: Number(resp.rowsAffected ?? 0),
      coverage: resp.coverage ? toCoverage(resp.coverage) : null,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      rowsAffected: 0,
      coverage: null,
      error: message,
      needsStopwordConfirm: /stopword ticker/i.test(message),
    };
  }
}

export async function undoSecurityDecision(candidateNorm: string): Promise<DecisionResult> {
  const { client, headers } = await reviewClient();
  try {
    const resp = await client.undoSecurityDecision({ candidateNorm }, { headers });
    revalidatePath("/admin/register/securities");
    return {
      ok: !!resp.deleted,
      rowsAffected: 0,
      coverage: resp.coverage ? toCoverage(resp.coverage) : null,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, rowsAffected: 0, coverage: null, error: message };
  }
}
