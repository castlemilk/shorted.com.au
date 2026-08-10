import { createHash, timingSafeEqual } from "node:crypto";

import { revalidatePath, revalidateTag } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";
import {
  deleteCachedByPrefix,
  HOUSING_DATA_CACHE_PREFIXES,
  POLITICIANS_DATA_CACHE_PREFIXES,
  SHORTS_DATA_CACHE_PREFIXES,
} from "~/@/lib/kv-cache";

// Redis prefix sets flushable via ?flush=<name>[,<name>...]. Each name maps to
// the family of keys busted together on that data-change event.
const FLUSH_PREFIXES: Record<string, readonly string[]> = {
  shorts: SHORTS_DATA_CACHE_PREFIXES,
  housing: HOUSING_DATA_CACHE_PREFIXES,
  politicians: POLITICIANS_DATA_CACHE_PREFIXES,
};

function revalidationSecretsMatch(
  provided: string | null,
  expected: string,
): boolean {
  if (provided == null) return false;
  // Hash to fixed-size buffers before timingSafeEqual so different input
  // lengths are handled without a direct secret comparison or an exception.
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * On-demand revalidation endpoint (event-driven caching).
 *
 * Called by the data pipeline when underlying data actually changes (e.g. the
 * daily sync writes new ASIC short data). Busts the Next.js route/data cache and
 * flushes the Redis layer so the next request re-renders fresh — instead of
 * waiting for a time-based TTL.
 *
 *   POST /api/revalidate
 *        X-Revalidate-Secret: <REVALIDATION_SECRET>
 *        ?tag=report-2026-W06,top-shorts      (comma-separated, optional)
 *        &path=/,/top,/news,/shorts/[stockCode]  (comma-separated, optional;
 *                                                 patterns with [..] revalidate
 *                                                 the whole dynamic route)
 *        &flush=shorts,housing                 (comma-separated Redis-prefix
 *                                                 families to flush; `shorts` and
 *                                                 `housing` are the current names)
 *
 * The legacy `?secret=` input remains a temporary one-release fallback for old
 * jobs. A supplied header always wins, including when it is invalid.
 */
export async function POST(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const headerSecret = request.headers.get("x-revalidate-secret");
  const secret = headerSecret ?? sp.get("secret");

  const expectedSecret = process.env.REVALIDATION_SECRET;
  if (!expectedSecret || !revalidationSecretsMatch(secret, expectedSecret)) {
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  const split = (v: string | null) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const tags = split(sp.get("tag"));
  const paths = split(sp.get("path"));
  const flushTargets = split(sp.get("flush"));

  if (tags.length === 0 && paths.length === 0 && flushTargets.length === 0) {
    return NextResponse.json(
      { error: "Provide at least one of: tag, path, flush" },
      { status: 400 },
    );
  }

  for (const tag of tags) revalidateTag(tag);
  for (const path of paths) {
    // A path containing "[" is a dynamic route pattern (e.g. /shorts/[stockCode])
    // → revalidate every page under it.
    if (path.includes("[")) revalidatePath(path, "page");
    else revalidatePath(path);
  }

  let flushedKeys = 0;
  for (const target of flushTargets) {
    const prefixes = FLUSH_PREFIXES[target];
    if (!prefixes) continue; // unknown flush name — ignore, keep other work
    // `housing` covers the whole cache:housing: prefix — the drops keys AND the
    // TTL-only overview entries (the admin panel's poisoned-entry clear relies
    // on this being a superset of cache:housing:overview:).
    for (const prefix of prefixes) {
      flushedKeys += await deleteCachedByPrefix(prefix);
    }
  }

  return NextResponse.json({
    revalidated: true,
    tags,
    paths,
    flushedKeys,
    timestamp: Date.now(),
  });
}
