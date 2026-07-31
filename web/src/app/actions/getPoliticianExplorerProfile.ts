/**
 * The profile analytics read path for `/politicians/[slug]`.
 *
 * SELF-CONTAINED, DELIBERATELY. Everything below the action itself — the
 * ISR-tagged transport, the non-emptiness-guarded cache reader, the toJson
 * writer — is a copy of the helper shape in `getPoliticians.ts`. That file is
 * owned by a concurrent work package (the hub adds its own explorer/summaries
 * actions there), and this rpc has exactly one caller, so a local copy costs
 * ~60 lines while a shared edit costs a merge conflict on a read path that 500s
 * the whole profile route when it goes wrong. Fold the two together once the
 * explorer waves have landed.
 *
 * The KV key MUST stay under the `cache:politicians:` prefix — that prefix is
 * what `/api/revalidate?flush=politicians` clears, and a key outside it would
 * survive an ingest and serve last week's counts for a full day.
 */

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { cache } from "react";

import {
  PoliticiansService,
  GetPoliticianExplorerProfileResponseSchema,
  type GetPoliticianExplorerProfileResponse,
} from "~/gen/shorts/v1alpha1/politicians_pb";
import {
  SERVER_SHORTS_API_URL,
  serverFetchWithUserAgent,
  skipForBuild,
} from "./config";
import { POLITICIANS_TTL, getCached, setCached } from "@/lib/kv-cache";
import { withRetryAndNotFound } from "./withRetry";

/**
 * How many industries the top-5 bar list asks for.
 *
 * A module constant rather than a parameter: the profile is the only caller and
 * the cache key below carries no industry count, so a per-call value would let
 * two different requests share one entry.
 */
const TOP_INDUSTRIES = 5;

/** See the file header — the `cache:politicians:` prefix is load-bearing. */
function explorerProfileKey(slug: string): string {
  return `cache:politicians:explorer-profile:${slug}`;
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
 * perfectly valid message whose every count is zero, `if (hit)` is truthy for
 * any object, and the read returns before it ever reaches the fetch that would
 * have corrected it — which is exactly how /politicians served zeros for 24h
 * after the 2026-07-31 deploy. The writer guard below is the same predicate, so
 * the pair cannot drift.
 *
 * Item counts OR timeline: a member can have current declarations with no dated
 * history (most base statements carry no lodgement date), and a member can have
 * a dated history that has since been fully removed. Either one is a real
 * response worth keeping.
 *
 * The item test is a NONZERO TOTAL rather than a nonempty list, for the same
 * reason the hub's explorer guard is: a cold materialized view can materialise
 * explicit zeros, and a well-formed row of zeros is exactly the entry that
 * sticks for 24h. A member with genuinely nothing current and nothing dated is
 * simply never cached — a handful of extra fetches on the thinnest profiles is
 * the cheap side of this trade.
 */
function isPopulatedProfile(value: GetPoliticianExplorerProfileResponse): boolean {
  return value.itemCounts.some((count) => count.currentCount > 0) || value.timeline.length > 0;
}

/**
 * Read a cached response, tolerating schema drift.
 *
 * A `fromJson` failure means the proto changed since the entry was written; we
 * fall through to a live fetch rather than serving a broken shape.
 */
function readCached(
  cached: JsonValue | null,
): GetPoliticianExplorerProfileResponse | undefined {
  if (cached == null) return undefined;
  try {
    const parsed = fromJson(GetPoliticianExplorerProfileResponseSchema, cached);
    return isPopulatedProfile(parsed) ? parsed : undefined;
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
function writeCached(key: string, value: GetPoliticianExplorerProfileResponse): void {
  try {
    void setCached(
      key,
      toJson(GetPoliticianExplorerProfileResponseSchema, value) as JsonValue,
      POLITICIANS_TTL,
    );
  } catch {
    // Never let a cache write break a render.
  }
}

/**
 * One member's register analytics: per-item counts, holder split, top
 * industries, the 60-month dated timeline, recent changes and the distinct
 * source documents behind the page.
 *
 * Counts only. There is no amount anywhere in this response to render.
 */
export const getPoliticianExplorerProfile = cache(
  withRetryAndNotFound(
    async (
      slug: string,
    ): Promise<GetPoliticianExplorerProfileResponse | undefined> => {
      if (!slug) return undefined;
      if (skipForBuild()) return undefined;

      const key = explorerProfileKey(slug);
      const hit = readCached(await getCached<JsonValue>(key));
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().getPoliticianExplorerProfile(
        { slug, topIndustries: TOP_INDUSTRIES },
      );
      // NEVER cache an empty response: the register kill switch and a cold MV
      // both return {}, and caching that pins the empty state for 24h.
      if (isPopulatedProfile(resp)) {
        writeCached(key, resp);
      }
      return resp;
    },
  ),
);
