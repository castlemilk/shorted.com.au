/**
 * The AEC funding explorer's three read paths.
 *
 * SELF-CONTAINED, DELIBERATELY — the same trade `getDistinctiveHoldings.ts` and
 * `getPoliticianExplorerProfile.ts` document at length. The ISR-tagged
 * transport, the non-emptiness-guarded cache reader and the toJson writer below
 * are a copy of the helper shape in `getPoliticians.ts`, which is owned by other
 * work packages. These rpcs have exactly one caller each, so a local copy costs
 * ~70 lines while a shared edit costs a merge conflict on a read path that 500s
 * a whole route when it goes wrong.
 *
 * THE KV KEYS MUST STAY UNDER `cache:politicians:` — that prefix is what
 * `/api/revalidate?flush=politicians` clears, and a key outside it would survive
 * an AEC re-ingest and serve last month's figures for a full day. Every input
 * that changes the response is IN the key, and every one of them is clamped
 * before the key is built: a key that describes a page size other than the one
 * that produced it is a cache that serves the wrong page.
 *
 * NON-EMPTINESS IS CHECKED ON BOTH SIDES. `fromJson` turns `{}` into a perfectly
 * valid message with empty lists, `if (hit)` is truthy for any object, and the
 * read returns before it reaches the fetch that would have corrected it — which
 * is how /politicians served zeros for 24h after the 2026-07-31 deploy. The
 * writer guard is the SAME predicate as the reader's, so the pair cannot drift.
 * The AEC kill switch (`AEC_DONATIONS_ENABLED=false`) returns exactly that
 * well-formed empty shape, so caching it would pin a taken-down surface's empty
 * state for a day after the switch went back on.
 */

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { cache } from "react";

import {
  PoliticiansService,
  GetDonationsOverviewResponseSchema,
  ListTopDonorsResponseSchema,
  ListPartyFundingResponseSchema,
  type GetDonationsOverviewResponse,
  type ListTopDonorsResponse,
  type ListPartyFundingResponse,
} from "~/gen/shorts/v1alpha1/politicians_pb";
import {
  SERVER_SHORTS_API_URL,
  serverFetchWithUserAgent,
  skipForBuild,
} from "./config";
import { POLITICIANS_TTL, getCached, setCached } from "@/lib/kv-cache";
import { withRetryAndNotFound } from "./withRetry";

/* --------------------------------------------------------------- clamping */

/**
 * The FY label is VERBATIM from the source ('2011-12' in some years,
 * '1998-1999' in others), so this trims and does nothing else. Upper- or
 * lower-casing it would invent a label the corpus does not contain, and the
 * backend's own `normaliseFinancialYear` trims and nothing else too — the two
 * must agree or the key describes a different request than the one that ran.
 *
 * EMPTY IS A LEGITIMATE VALUE and means "the latest year held". The response
 * then carries the year actually served, which is the only thing a caption may
 * be built from.
 */
export function clampFinancialYear(financialYear: string | undefined): string {
  return (financialYear ?? "").trim();
}

/**
 * The party group is the source's own verbatim key ('The Greens', 'Country
 * Liberal Party (NT)'). Trimmed, never case-folded: the backend looks it up
 * exactly, so folding the case here would silently return an empty list under a
 * filter the reader can see selected.
 */
export function clampPartyGroup(partyGroup: string | undefined): string {
  return (partyGroup ?? "").trim();
}

/** The handler's own clamp, mirrored so the key cannot describe another page. */
function clampLimit(requested: number | undefined, fallback: number, max: number): number {
  const value = Math.trunc(Number(requested ?? 0));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

function clampOffset(requested: number | undefined): number {
  const value = Math.trunc(Number(requested ?? 0));
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

export const DONORS_PAGE_SIZE = 25;
export const OVERVIEW_PARTY_LIMIT = 25;
export const PARTY_PAYER_LIMIT = 100;

/** One page of the donor table, clamped exactly as the handler clamps it. */
export interface TopDonorsQuery {
  financialYear: string;
  partyGroup: string;
  limit: number;
  offset: number;
}

export function clampTopDonorsQuery(input: Partial<TopDonorsQuery> = {}): TopDonorsQuery {
  return {
    financialYear: clampFinancialYear(input.financialYear),
    partyGroup: clampPartyGroup(input.partyGroup),
    limit: clampLimit(input.limit, DONORS_PAGE_SIZE, 200),
    offset: clampOffset(input.offset),
  };
}

/* -------------------------------------------------------------- transport */

// A transport whose fetch tags the request ISR-cacheable.
//
// LOAD-BEARING. Without a `next` (or explicit `cache`) option,
// serverFetchWithUserAgent forces `cache:'no-store'` on POSTs at Vercel runtime,
// which opts the whole route out of static generation — and worse, throws
// "Page changed from static to dynamic at runtime" during an ISR regen, baking
// the placeholder for a day. Same lesson as getPoliticians/getHousing/getEconomy.
const isrPoliticiansFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, { ...init, next: { revalidate: 3600 } });

function createCacheablePoliticiansClient() {
  const transport = createConnectTransport({
    fetch: isrPoliticiansFetch,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(PoliticiansService, transport);
}

/* ------------------------------------------------------------------ cache */

/**
 * Read a cached response, tolerating schema drift and refusing empty entries.
 *
 * A `fromJson` failure means the proto changed since the entry was written; we
 * fall through to a live fetch rather than serving a broken shape.
 */
function readCached<T>(
  cached: JsonValue | null,
  schema: Parameters<typeof fromJson>[0],
  isPopulated: (value: T) => boolean,
): T | undefined {
  if (cached == null) return undefined;
  try {
    const parsed = fromJson(schema, cached) as T;
    return isPopulated(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a cache entry, fire-and-forget.
 *
 * Caches the toJson PROJECTION, never the proto: funding messages carry
 * Timestamps (BigInt-backed) and int64 amounts (BigInt), both of which make
 * JSON.stringify throw.
 */
function writeCached<T>(
  key: string,
  value: T,
  schema: Parameters<typeof toJson>[0],
): void {
  try {
    void setCached(key, toJson(schema, value as never) as JsonValue, POLITICIANS_TTL);
  } catch {
    // Never let a cache write break a render.
  }
}

/* --------------------------------------------------------------- readers */

/**
 * Party funding by financial year, plus the corpus counts and the mandatory
 * notes the explorer's methodology band renders.
 *
 * `financialYear` may be empty, which asks for the latest year held. The
 * response carries the year actually served and that — never the request — is
 * what a caption may be built from.
 */
export const getDonationsOverview = cache(
  withRetryAndNotFound(
    async (
      // ANNOTATED AND OPTIONAL rather than defaulted: the retry wrapper's
      // `(...args: TArgs)` makes contextually-typed parameters `unknown`, which
      // silently defeats the clamps below — and a default value would be
      // "trivially inferred" and rejected by lint. The clamps supply the
      // fallbacks, which is where they belong anyway.
      financialYear: string,
      limit?: number,
    ): Promise<GetDonationsOverviewResponse | undefined> => {
      if (skipForBuild()) return undefined;
      const fy = clampFinancialYear(financialYear);
      const partyLimit = clampLimit(limit, OVERVIEW_PARTY_LIMIT, 100);
      const key = `cache:politicians:donations:overview:${fy || "latest"}:${partyLimit}`;

      const hit = readCached<GetDonationsOverviewResponse>(
        await getCached<JsonValue>(key),
        GetDonationsOverviewResponseSchema,
        (value) => value.parties.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().getDonationsOverview({
        financialYear: fy,
        limit: partyLimit,
      });
      // NEVER cache an empty response: the AEC kill switch and a cold
      // materialized view both return one, and caching it pins the empty state
      // for 24h after the underlying cause has gone.
      if (resp.parties.length > 0) {
        writeCached(key, resp, GetDonationsOverviewResponseSchema);
      }
      return resp;
    },
  ),
);

/**
 * One page of payers into party branches, ordered by the amount the AEC itself
 * published.
 */
export const listTopDonors = cache(
  withRetryAndNotFound(
    async (input: Partial<TopDonorsQuery> = {}): Promise<ListTopDonorsResponse | undefined> => {
      if (skipForBuild()) return undefined;
      const query = clampTopDonorsQuery(input);
      const key =
        `cache:politicians:donations:donors:${query.financialYear || "latest"}:` +
        `${query.partyGroup || "all"}:${query.limit}:${query.offset}`;

      const hit = readCached<ListTopDonorsResponse>(
        await getCached<JsonValue>(key),
        ListTopDonorsResponseSchema,
        (value) => value.donors.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().listTopDonors(query);
      if (resp.donors.length > 0) {
        writeCached(key, resp, ListTopDonorsResponseSchema);
      }
      return resp;
    },
  ),
);

/**
 * One party group's whole series plus its focus-year payer lists.
 *
 * The listed-company payers rail is built from THIS rpc rather than from the
 * donor page: only 6 of the 90 listed payers in FY2024-25 fall inside the top
 * 200 payers by amount, so filtering the donor table for a stock code would
 * have published six companies under a heading claiming to cover the listed
 * ones. The overview says which party groups hold listed payers at all (three
 * or four in every year measured), so the rail is a bounded fan-out over those.
 */
export const listPartyFunding = cache(
  withRetryAndNotFound(
    async (
      partyGroup: string,
      financialYear?: string,
      limit?: number,
    ): Promise<ListPartyFundingResponse | undefined> => {
      const group = clampPartyGroup(partyGroup);
      // The handler rejects an empty group with InvalidArgument rather than
      // serving a corpus-wide list; asking for one is a caller bug, not a miss.
      if (!group) return undefined;
      if (skipForBuild()) return undefined;
      const fy = clampFinancialYear(financialYear);
      const payerLimit = clampLimit(limit, PARTY_PAYER_LIMIT, 200);
      // The group goes into the key VERBATIM, not case-folded. The backend
      // matches it exactly, so "the greens" and "The Greens" are two different
      // requests with two different answers (one of them empty) — folding them
      // onto one key would serve the empty one under the populated one's name.
      const key =
        `cache:politicians:donations:party:${group}:${fy || "latest"}:${payerLimit}`;

      const hit = readCached<ListPartyFundingResponse>(
        await getCached<JsonValue>(key),
        ListPartyFundingResponseSchema,
        (value) => value.series.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().listPartyFunding({
        partyGroup: group,
        financialYear: fy,
        limit: payerLimit,
      });
      if (resp.series.length > 0) {
        writeCached(key, resp, ListPartyFundingResponseSchema);
      }
      return resp;
    },
  ),
);
