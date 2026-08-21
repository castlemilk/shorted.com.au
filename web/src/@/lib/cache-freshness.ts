/**
 * Staleness guard for cached ASIC short-position payloads.
 *
 * WHY THIS EXISTS — the 2026-08-21 freeze. Upstash hit its 500k/month command
 * cap: reads kept being served, but every SETEX and DEL was rejected. The cache
 * therefore became READ-ONLY, and every layer that assumed "a write or a delete
 * will eventually move this entry" stopped working at once — /api/revalidate
 * flushed nothing while reporting success, and the /top entry kept being served
 * for days with the same frozen ASIC date. Nothing in the read path looked at
 * the data itself, so nothing noticed.
 *
 * THE MECHANISM, and why this one. The read path has no fresher date already in
 * hand (`/top`'s metadata and its body both come FROM this cached accessor, and
 * the first thing either does is the cache read), and the design constraint is
 * to add no blocking fetch on the hot path. So the check is purely intrinsic:
 * how old is the newest data point in the entry, in calendar days? A frozen
 * entry ages past the bound on its own and self-invalidates within days, with
 * zero extra I/O and no dependence on Redis accepting a write.
 *
 * THE BOUND. ASIC publishes T+4 TRADING days, so the newest legitimately
 * available report is normally 6 calendar days old at worst (4 trading days
 * spanning one weekend). MAX_SHORTS_DATA_AGE_DAYS is set above that worst case
 * to leave room for a public holiday inside the window: rejecting a legitimately
 * lagging entry costs a live refetch on every request until the source moves,
 * which is the expensive direction, while serving one that is a day or two past
 * the bound costs nothing. Longer holiday clusters (Easter, Christmas) can still
 * exceed it — in those windows the page degrades to the (edge-cached) live fetch
 * and renders correct data, which is the safe direction.
 *
 * The guard applies to CACHED entries only. Freshly built data is whatever the
 * API just said and is served and stored as-is; otherwise a genuinely lagging
 * source would be refused outright.
 */
export const MAX_SHORTS_DATA_AGE_DAYS = 8;

const MS_PER_DAY = 86_400_000;

/**
 * Coerce the several timestamp shapes a cached short-position point can carry
 * into epoch milliseconds:
 *  - ISO string        (getTopPageData's serialized form)
 *  - Date              (in-memory dev cache round-trip)
 *  - {seconds, nanos}  (protobuf Timestamp, as JSON — `seconds` may be a
 *                       string, number or bigint depending on the transport)
 * Returns null for anything else, which callers treat as "no usable date".
 */
export function timestampToMs(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "string") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "object" && "seconds" in value) {
    const ts = value as { seconds?: unknown; nanos?: unknown };
    const seconds = Number(ts.seconds ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const nanos = Number(ts.nanos ?? 0);
    return seconds * 1000 + (Number.isFinite(nanos) ? nanos / 1e6 : 0);
  }
  return null;
}

interface SeriesLike {
  points?: unknown;
}

/**
 * Newest point timestamp across a time-series collection, in epoch ms.
 * Returns null when the collection carries no usable date at all.
 */
export function newestSeriesTimestampMs(series: unknown): number | null {
  if (!Array.isArray(series)) return null;
  let newest = 0;
  for (const entry of series as SeriesLike[]) {
    const points = entry?.points;
    if (!Array.isArray(points)) continue;
    for (const point of points) {
      const ms = timestampToMs(
        point && typeof point === "object"
          ? (point as { timestamp?: unknown }).timestamp
          : undefined,
      );
      if (ms !== null && ms > newest) newest = ms;
    }
  }
  return newest > 0 ? newest : null;
}

/**
 * True when a CACHED payload's newest data point is older than the bound above
 * — i.e. the entry looks frozen and must not be served.
 *
 * A payload with no dated point at all is NOT reported stale here: dateless
 * entries are the shape the pre-existing structural checks already police, and
 * failing them on age too would reject every legitimately point-less response.
 */
export function isCachedShortsDataStale(
  series: unknown,
  now: number = Date.now(),
): boolean {
  const newest = newestSeriesTimestampMs(series);
  if (newest === null) return false;
  return now - newest > MAX_SHORTS_DATA_AGE_DAYS * MS_PER_DAY;
}
