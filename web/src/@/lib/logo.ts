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

// Deploy-bound cache-bust suffix. Google's edge caches normalized
// logo objects for hours even when we update them (and re-scrapes
// happen on demand — see ZIP, which was inherited as the wrong company
// "ZipTel" from a legacy scrape). Appending the build SHA forces a
// fresh fetch after every deploy; logos that haven't changed still
// hit Google's edge cache for the actual bytes — only the URL key
// changes per deploy.
const LOGO_VERSION =
  process.env.NEXT_PUBLIC_LOGO_VERSION ??
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
  "dev";

/**
 * Returns the normalized (256×256, trimmed, centred) logo URL for an
 * ASX stock code with a deploy-bound cache-bust query string.
 */
export function normalizedLogoUrl(stockCode: string): string {
  const code = stockCode.toUpperCase();
  return `https://storage.googleapis.com/${BUCKET}/logos-normalized/${code}.png?v=${LOGO_VERSION}`;
}

/** Raw, un-processed source logo URL (no cache bust). */
export function rawLogoUrl(stockCode: string): string {
  const code = stockCode.toUpperCase();
  return `https://storage.googleapis.com/${BUCKET}/logos/${code}.png`;
}
