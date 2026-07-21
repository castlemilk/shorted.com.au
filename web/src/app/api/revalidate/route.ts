import { revalidatePath, revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import {
  deleteCachedByPrefix,
  SHORTS_DATA_CACHE_PREFIXES,
} from "~/@/lib/kv-cache";

/**
 * On-demand revalidation endpoint (event-driven caching).
 *
 * Called by the data pipeline when underlying data actually changes (e.g. the
 * daily sync writes new ASIC short data). Busts the Next.js route/data cache and
 * flushes the Redis layer so the next request re-renders fresh — instead of
 * waiting for a time-based TTL.
 *
 *   POST /api/revalidate?secret=<REVALIDATION_SECRET>
 *        &tag=report-2026-W06,top-shorts      (comma-separated, optional)
 *        &path=/,/top,/news,/shorts/[stockCode]  (comma-separated, optional;
 *                                                 patterns with [..] revalidate
 *                                                 the whole dynamic route)
 *        &flush=shorts|housing                 (flush the shorts-data, or housing-overview, Redis prefixes)
 *
 * Backward compatible with the existing single `?tag=` callers.
 */
export async function POST(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const secret = sp.get("secret");

  const expectedSecret = process.env.REVALIDATION_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  const split = (v: string | null) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const tags = split(sp.get("tag"));
  const paths = split(sp.get("path"));
  const flush = sp.get("flush");

  if (tags.length === 0 && paths.length === 0 && !flush) {
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
  if (flush === "shorts") {
    for (const prefix of SHORTS_DATA_CACHE_PREFIXES) {
      flushedKeys += await deleteCachedByPrefix(prefix);
    }
  } else if (flush === "housing") {
    // Housing overview is TTL-only (24h) and NOT in SHORTS_DATA_CACHE_PREFIXES,
    // so this is the sanctioned way to clear a poisoned/stale entry (e.g. an
    // empty response cached during a backend redeploy) without raw Redis access.
    flushedKeys += await deleteCachedByPrefix("cache:housing:overview:");
  }

  return NextResponse.json({
    revalidated: true,
    tags,
    paths,
    flushedKeys,
    timestamp: Date.now(),
  });
}
