/**
 * The sole-declarer read path for the `/politicians/[slug]` rail.
 *
 * SELF-CONTAINED, DELIBERATELY — the same trade `getPoliticianExplorerProfile.ts`
 * documents at length. The ISR-tagged transport, the non-emptiness-guarded cache
 * reader and the toJson writer below are a copy of the helper shape in
 * `getPoliticians.ts`, which is owned by a concurrent work package. This rpc has
 * exactly one caller, so a local copy costs ~60 lines while a shared edit costs a
 * merge conflict on a read path that 500s the whole profile route when it goes
 * wrong. Fold the three together once the explorer waves have landed.
 *
 * The KV key MUST stay under the `cache:politicians:` prefix — that prefix is
 * what `/api/revalidate?flush=politicians` clears, and a key outside it would
 * survive an ingest and serve last week's declarer counts for a full day.
 */

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { cache } from "react";

import {
  PoliticiansService,
  ListDistinctiveHoldingsResponseSchema,
  type ListDistinctiveHoldingsResponse,
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
 * THE SLUG IS NORMALISED THE WAY THE HANDLER NORMALISES IT (trim + lower-case),
 * which is the same rule the feed's key follows: a key built from the raw string
 * gives `Anthony-Albanese` and `anthony-albanese` two entries for one identical
 * response, so one link's warm cache is another link's miss and a flush that
 * clears one leaves the other serving the pre-flush rows.
 */
function distinctiveHoldingsKey(slug: string): string {
  return `cache:politicians:distinctive:${slug.trim().toLowerCase()}`;
}

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

/**
 * Is a cached response actually populated?
 *
 * AN EMPTY CACHE ENTRY IS A MISS, NOT A HIT. `fromJson` turns `{}` into a
 * perfectly valid message with an empty holdings list, `if (hit)` is truthy for
 * any object, and the read returns before it reaches the fetch that would have
 * corrected it — which is how /politicians served zeros for 24h after the
 * 2026-07-31 deploy. The writer guard below is the same predicate, so the pair
 * cannot drift.
 *
 * The predicate is HOLDINGS, not the canonical slug: the register kill switch
 * and a cold materialized view both return a well-formed response with no rows,
 * and caching that pins an empty rail for a day. A member who genuinely declares
 * no listed company is simply never cached — a handful of extra fetches on the
 * thinnest profiles is the cheap side of this trade, and the rail renders
 * nothing either way.
 */
function isPopulated(value: ListDistinctiveHoldingsResponse): boolean {
  return value.holdings.length > 0;
}

/**
 * Read a cached response, tolerating schema drift.
 *
 * A `fromJson` failure means the proto changed since the entry was written; we
 * fall through to a live fetch rather than serving a broken shape.
 */
function readCached(cached: JsonValue | null): ListDistinctiveHoldingsResponse | undefined {
  if (cached == null) return undefined;
  try {
    const parsed = fromJson(ListDistinctiveHoldingsResponseSchema, cached);
    return isPopulated(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a cache entry, fire-and-forget.
 *
 * Caches the toJson PROJECTION, never the proto: register messages carry
 * Timestamps, which are BigInt-backed and make JSON.stringify throw.
 */
function writeCached(key: string, value: ListDistinctiveHoldingsResponse): void {
  try {
    void setCached(
      key,
      toJson(ListDistinctiveHoldingsResponseSchema, value) as JsonValue,
      POLITICIANS_TTL,
    );
  } catch {
    // Never let a cache write break a render.
  }
}

/**
 * One member's currently-declared listed companies, each with the corpus-wide
 * count of members currently declaring it.
 *
 * The count is the whole fact. Nothing here — and nothing downstream — derives a
 * rarity measure, a score or a label from it.
 *
 * ROW GRAIN IS (company, holder). A member declaring the same code for
 * themselves and via a spouse yields TWO rows, deliberately: collapsing them in
 * the store would have to pick one holder and would thereby attribute a spouse's
 * declaration to the member. Consumers group by code for display and list every
 * holder within the row.
 */
export const getDistinctiveHoldings = cache(
  withRetryAndNotFound(
    async (slug: string): Promise<ListDistinctiveHoldingsResponse | undefined> => {
      if (!slug) return undefined;
      if (skipForBuild()) return undefined;

      const key = distinctiveHoldingsKey(slug);
      const hit = readCached(await getCached<JsonValue>(key));
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().listDistinctiveHoldings({
        slug,
      });
      // NEVER cache an empty response: the register kill switch and a cold MV
      // both return one, and caching it pins the empty state for 24h.
      if (isPopulated(resp)) {
        writeCached(key, resp);
      }
      return resp;
    },
  ),
);
