// Logo URL helpers.
//
// We store TWO versions of each company logo in GCS:
//   - logos/<CODE>.png             — raw source, variable size/aspect/whitespace
//   - logos-normalized/<CODE>.png  — 256×256 transparent canvas, content trimmed
//                                    and centred (scripts/logo-normalize)
//
// Prefer the normalized version for any UI surface. Fall back to the
// raw URL if the normalized one isn't there yet (the normalize batch
// is idempotent + runs on demand; new companies may not be processed).

const BUCKET = "shorted-company-logos";

/**
 * Returns the normalized (256×256, trimmed, centred) logo URL for an
 * ASX stock code. Does NOT verify the file exists — relies on the
 * caller to have an <img onError> fallback or to fall back at render
 * time using rawLogoUrl().
 */
export function normalizedLogoUrl(stockCode: string): string {
  const code = stockCode.toUpperCase();
  return `https://storage.googleapis.com/${BUCKET}/logos-normalized/${code}.png`;
}

/** Raw, un-processed source logo URL. */
export function rawLogoUrl(stockCode: string): string {
  const code = stockCode.toUpperCase();
  return `https://storage.googleapis.com/${BUCKET}/logos/${code}.png`;
}
