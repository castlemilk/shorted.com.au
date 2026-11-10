import { unstable_cache } from "next/cache";

import { listStateSuburbsOutsideNextCache } from "./getHousing";
import type { SuburbLike } from "@/lib/housing/suburb-stats";

/**
 * A compact, cacheable projection of a state's suburb list.
 *
 * The suburb profile needs the whole state to rank one suburb against it, but it
 * must not pay for the whole state on every regeneration. Two measured facts
 * force this shape:
 *
 *   1. `ListStateSuburbs(NSW, limit 5000)` returns **3.65 MB** of JSON for 4,544
 *      suburbs (measured 2026-08-22). Next's data cache refuses entries over
 *      2 MB, so caching the raw response is not on the table.
 *   2. Connect POSTs carry a Uint8Array body. With a fetch-level
 *      `next: { revalidate }` tag Next 15 would store the response in its data
 *      cache, where an empty response would outlive the render that found it
 *      (`getHousing.ts` documents the body). The inner call therefore uses
 *      `serverFetchOutsideNextCache`, the posture `config.ts` prescribes for
 *      RPCs cached at this layer: a `cache: 'no-store'` fetch would THROW inside
 *      an unstable_cache callback during static generation, and the default
 *      options would store the body in the data cache.
 *
 * Together those mean a naive `await listStateSuburbs(...)` in the page would
 * re-pull 3.65 MB from Cloud Run and re-decode it for every one of ~3,600 suburb
 * pages, every day.
 *
 * `unstable_cache` keys on the arguments instead of the request body, so the
 * expensive read happens once per state per day and what is stored is this
 * ~400 KB projection — seven fields, no nested amenity submessage, no electoral
 * or crime columns the ranking never touches.
 */
export const getStateSuburbIndex = (stateCode: string): Promise<SuburbLike[]> =>
  unstable_cache(
    async (): Promise<SuburbLike[]> => {
      const res = await listStateSuburbsOutsideNextCache(stateCode, 5000);
      // THROW rather than return []. `withRetryAndNotFound` resolves to
      // undefined once its retries are spent, and an empty array is a perfectly
      // valid cache entry — so swallowing the failure here would pin "no state
      // context" for the full 24h window across every suburb in the state. A
      // throw leaves the cache empty and lets the caller degrade for this render
      // only. Every Australian state has suburbs, so an empty list is a failure
      // too, not a legitimate answer.
      if (!res?.suburbs?.length) {
        throw new Error(`ListStateSuburbs returned no suburbs for ${stateCode}`);
      }
      return res.suburbs.map((s) => ({
        salCode: s.salCode,
        salName: s.salName,
        stateCode: s.stateCode,
        postcode: s.postcode,
        latestMedianPrice: s.latestMedianPrice,
        yoyPct: s.yoyPct,
        medianWeeklyHhdIncome: s.medianWeeklyHhdIncome,
        amenityScore: s.amenities?.amenityDensityScore ?? 0,
        population: s.population,
      }));
    },
    // "v2": the projection gained `population` (the state page's server-rendered
    // suburb directory ranks by it). A new key rather than a silent shape change,
    // so a cached v1 entry cannot be served for 24h without the field.
    ["housing-state-suburb-index", "v2", stateCode],
    // Matches the suburb route's own 24h ISR window. The `housing` tag is
    // sent (`/api/revalidate?tag=housing`) only by the collector's official
    // data refresh, refresh() in services/house-price-collector. Every state
    // and suburb page reads this entry, so one tag expiry rebuilds all of them.
    // Crawl writes send no tag: none of these fields comes from the crawl.
    // Keep it that way if a field is added here. A crawl-derived field would
    // need its own narrow scope, never the crawl pinging this tag (it pinged it
    // ~20 times a day before 2026-11-09).
    // No per-state tag: nothing revalidates at state granularity, so it would be
    // metadata nobody reads.
    { revalidate: 86400, tags: ["housing"] },
  )();
