/**
 * The `/politicians/[slug]` funding-returns section's read path.
 *
 * SELF-CONTAINED, DELIBERATELY — the same trade `getDistinctiveHoldings.ts`
 * documents at length, and for the same reason: this rpc has exactly one caller,
 * so a local copy of the transport/cache helpers costs ~60 lines while a shared
 * edit costs a merge conflict on a read path that 500s the whole profile route
 * when it goes wrong.
 *
 * WHAT THIS RPC WILL AND WILL NOT SERVE. Only returns that NAME the member:
 * their own annual member return, and the election returns they lodged as a
 * candidate. Party money is never on this response, and the section built from
 * it therefore cannot render a party figure even by accident (a test asserts the
 * component contains no party-group total). The response ALWAYS carries its
 * coverage note, empty or not — this layer is thin, and a surface that does not
 * state its coverage lies by construction.
 *
 * The KV key MUST stay under the `cache:politicians:` prefix — that prefix is
 * what `/api/revalidate?flush=politicians` clears, and a key outside it would
 * survive an AEC re-ingest and serve last month's figures for a full day.
 */

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { cache } from "react";

import {
  PoliticiansService,
  GetPoliticianFundingResponseSchema,
  type GetPoliticianFundingResponse,
} from "~/gen/shorts/v1alpha1/politicians_pb";
import {
  SERVER_SHORTS_API_URL,
  serverFetchWithUserAgent,
  skipForBuild,
} from "./config";
import { POLITICIANS_TTL, getCached, setCached } from "@/lib/kv-cache";
import { withRetryAndNotFound } from "./withRetry";

/**
 * See the file header — the `cache:politicians:` prefix is load-bearing.
 *
 * THE SLUG IS NORMALISED THE WAY THE HANDLER NORMALISES IT (trim + lower-case):
 * a key built from the raw string gives `Helen-Haines` and `helen-haines` two
 * entries for one identical response, so one link's warm cache is another link's
 * miss and a flush that clears one leaves the other serving pre-flush figures.
 */
function politicianFundingKey(slug: string): string {
  return `cache:politicians:funding:${slug.trim().toLowerCase()}`;
}

// A transport whose fetch tags the request ISR-cacheable. LOAD-BEARING — see
// getDistinctiveHoldings.ts for the "static to dynamic at runtime" failure this
// prevents.
const isrPoliticiansFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, { ...init, next: { revalidate: 3600 } });

function createCacheablePoliticiansClient() {
  const transport = createConnectTransport({
    fetch: isrPoliticiansFetch,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(PoliticiansService, transport);
}

/**
 * Is a cached response actually populated?
 *
 * AN EMPTY CACHE ENTRY IS A MISS, NOT A HIT. `fromJson` turns `{}` into a valid
 * message with two empty lists and every note string blank, `if (hit)` is truthy
 * for any object, and the read returns before it reaches the fetch that would
 * have corrected it.
 *
 * The predicate is THE RETURNS, not the canonical slug: the AEC kill switch and
 * a cold ingest both produce a well-formed response with no rows, and caching
 * that hides a member's funding returns for a day. A member who genuinely lodged
 * nothing is simply never cached — a handful of extra fetches on the profiles
 * that render no section at all is the cheap side of this trade.
 */
function isPopulated(value: GetPoliticianFundingResponse): boolean {
  return value.annualReturns.length > 0 || value.candidateReturns.length > 0;
}

function readCached(cached: JsonValue | null): GetPoliticianFundingResponse | undefined {
  if (cached == null) return undefined;
  try {
    const parsed = fromJson(GetPoliticianFundingResponseSchema, cached);
    return isPopulated(parsed) ? parsed : undefined;
  } catch {
    // A fromJson failure means the proto changed since the entry was written;
    // fall through to a live fetch rather than serving a broken shape.
    return undefined;
  }
}

/**
 * Write a cache entry, fire-and-forget.
 *
 * Caches the toJson PROJECTION, never the proto: these messages carry Timestamps
 * and int64 amounts, both BigInt-backed, and JSON.stringify throws on both.
 */
function writeCached(key: string, value: GetPoliticianFundingResponse): void {
  try {
    void setCached(
      key,
      toJson(GetPoliticianFundingResponseSchema, value) as JsonValue,
      POLITICIANS_TTL,
    );
  } catch {
    // Never let a cache write break a render.
  }
}

/**
 * The AEC funding returns that name one member.
 *
 * Returns `undefined` when the request did not answer (the retry helper's
 * exhausted signal) and a well-formed empty response when the member simply has
 * no linked return. The section renders nothing in both cases — an empty frame
 * under a funding heading beside a named person reads as "received nothing",
 * which the corpus cannot support: most parliamentarians never lodge one.
 */
export const getPoliticianFunding = cache(
  withRetryAndNotFound(
    async (slug: string): Promise<GetPoliticianFundingResponse | undefined> => {
      if (!slug) return undefined;
      if (skipForBuild()) return undefined;

      const key = politicianFundingKey(slug);
      const hit = readCached(await getCached<JsonValue>(key));
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().getPoliticianFunding({ slug });
      if (isPopulated(resp)) {
        writeCached(key, resp);
      }
      return resp;
    },
  ),
);
