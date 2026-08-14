/**
 * The shape the masthead components need from an editorial take. Structural
 * rather than the protobuf EditorialTake so the /news page can feed it from
 * a plain-JSON connect POST (whose Timestamps are RFC3339 strings, mapped to
 * `{seconds}` by the caller) — the connect transport can't run inside ISR
 * routes (streamed bodies can't data-cache; its no-store fallback throws
 * "Dynamic server usage" during regeneration).
 */
export interface TakeLike {
  id: string;
  slug: string;
  headline: string;
  standfirst?: string;
  byline?: string;
  sentiment?: string;
  stockCode?: string;
  heroImageUrl?: string;
  heroCaption?: string;
  heroCredit?: string;
  publishedAt?: { seconds?: bigint | number };
}

/** Format a protobuf Timestamp-ish value as an en-AU long date. */
export function fmtTakeDate(
  ts: { seconds?: bigint | number } | undefined,
): string {
  if (!ts?.seconds) return "";
  const s = typeof ts.seconds === "bigint" ? Number(ts.seconds) : ts.seconds;
  return new Date(s * 1000).toLocaleDateString("en-AU", {
    timeZone: "Australia/Sydney",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Extract the beat from a byline like
 * "The Shorted Desk — Mining & Resources" → "Mining & Resources".
 */
export function beatFromByline(byline: string | undefined): string | undefined {
  if (!byline) return undefined;
  const idx = byline.indexOf("—");
  if (idx === -1) return undefined;
  const beat = byline.slice(idx + 1).trim();
  return beat || undefined;
}

/**
 * Sentiment → text colour, matching the emerald/rose/amber idiom used by
 * take-card-grid / take-hero.
 */
export function sentimentText(s: string | undefined): {
  label: string;
  className: string;
} {
  switch (s) {
    case "positive":
      return { label: "Positive", className: "text-emerald-700 dark:text-emerald-400" };
    case "negative":
      return { label: "Negative", className: "text-rose-700 dark:text-rose-400" };
    default:
      return { label: "Neutral", className: "text-muted-foreground" };
  }
}
