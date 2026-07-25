/**
 * Visible "as at" stamp for the homepage top-10 table.
 *
 * The date is derived from data the page has ALREADY fetched (the top-shorts
 * time series) — no extra RPC. Server component, no client JS.
 */

/** Loose shape of a time-series point as it arrives from either transport. */
type LooseSeries = {
  points?: Array<{
    // Connect/protobuf-es path: google.protobuf.Timestamp { seconds, nanos }
    // Edge-read (JSON) path: an RFC3339 string.
    timestamp?: { seconds?: bigint | number | string } | string | null;
  }> | null;
};

function pointDate(
  timestamp: { seconds?: bigint | number | string } | string | null | undefined,
): Date | null {
  if (!timestamp) return null;
  if (typeof timestamp === "string") {
    const parsed = new Date(timestamp);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof timestamp === "object" && timestamp.seconds !== undefined) {
    const seconds = Number(timestamp.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(seconds * 1000);
  }
  return null;
}

/**
 * Latest observation date across every series' points — i.e. the ASIC report
 * date the homepage table reflects. Returns null when the data carries no
 * usable timestamps (caller then renders nothing rather than inventing a date).
 */
export function latestAsicDataDate(
  timeSeries: readonly LooseSeries[] | null | undefined,
): Date | null {
  if (!timeSeries?.length) return null;
  let latest: Date | null = null;
  for (const series of timeSeries) {
    const points = series?.points;
    if (!points?.length) continue;
    // Points are chronological, but scan the tail defensively rather than
    // assuming ordering across every transport.
    for (let i = points.length - 1; i >= 0 && i >= points.length - 5; i--) {
      const date = pointDate(points[i]?.timestamp);
      if (date && (!latest || date > latest)) latest = date;
    }
  }
  return latest;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Australia/Sydney",
});

/** ISO yyyy-mm-dd in the ASX's timezone, for the <time dateTime> attribute. */
function isoDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Australia/Sydney",
  }).format(date);
  return parts;
}

export function AsicDataFreshness({
  date,
  className,
}: {
  date: Date | null;
  className?: string;
}) {
  if (!date) return null;
  return (
    <p className={className}>
      ASIC short position data as at{" "}
      <time dateTime={isoDate(date)}>{DATE_FORMAT.format(date)}</time> (T+4
      reporting delay)
    </p>
  );
}
