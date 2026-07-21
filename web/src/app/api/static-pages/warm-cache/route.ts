import { type NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

// Warm the static, data-backed ISR pages that render a "no data" / "loading"
// shell when their fetch comes back empty.
//
// Why they need warming: at BUILD time `skipForBuild()` forces those fetches to
// return [] (the backend is unreachable during `next build`), so every deploy
// PRERENDERS the empty shell and serves it — for the full `revalidate` window —
// until the first successful regeneration. i.e. the first visitor after each
// deploy would otherwise see "No market snapshot data available" / "House-price
// data is loading". This endpoint busts that shell and re-primes each page with
// real runtime data (where `skipForBuild()` is false), so first load is clean.
//
// Triggered deploy-immediately from the post-deploy pipeline
// (.github/workflows/post-deploy-smoke.yml) and, as a backstop, on a short
// Vercel cron (web/vercel.json). Same revalidate-then-re-prime shape as
// /api/pages/warm-cache.

export const maxDuration = 120;

// Cloudflare's bot protection rejects non-browser user agents, so the
// self-fetches that re-prime the ISR cache must present a browser UA.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// The static ISR pages whose empty-at-build render is a user-visible shell.
// Keep in sync with the "check back shortly" / "No … data available" fallbacks.
const STATIC_PAGES = ["/market", "/housing", "/economy", "/compare", "/price-drops"];

export async function GET(request: NextRequest) {
  // Optional secret gate — same pattern as the other warm-cache routes. When
  // CACHE_WARM_SECRET is unset (as for the Vercel crons) the endpoint runs open.
  const secret = request.nextUrl.searchParams.get("secret");
  const expectedSecret = process.env.CACHE_WARM_SECRET;
  if (expectedSecret && secret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const results: Record<string, { success: boolean; error?: string; ms?: number }> = {};

  // Invalidate first so the re-prime regenerates with live data instead of
  // just touching the stale build shell.
  for (const path of STATIC_PAGES) revalidatePath(path);

  // Re-prime against the INTERNAL deployment URL, never the public host. The
  // public shorted.com.au sits behind Cloudflare bot protection, which 403s any
  // server-side fetch (even with a browser UA — verified). VERCEL_URL is the
  // deployment's own *.vercel.app origin, reached directly (no Cloudflare), so
  // the self-fetch actually triggers regeneration. Falls back to the request
  // origin only in local dev (where VERCEL_URL is unset and there is no edge).
  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : request.nextUrl.origin;
  await Promise.allSettled(
    STATIC_PAGES.map(async (path) => {
      const pageStart = Date.now();
      try {
        const res = await fetch(`${origin}${path}`, {
          headers: { "User-Agent": BROWSER_UA },
          cache: "no-store",
        });
        results[path] = {
          success: res.ok,
          ms: Date.now() - pageStart,
          ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
        };
      } catch (err) {
        results[path] = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const successCount = Object.values(results).filter((r) => r.success).length;
  return NextResponse.json(
    {
      success: true,
      message: `Warmed ${successCount}/${STATIC_PAGES.length} static pages`,
      results,
      duration: `${Date.now() - startTime}ms`,
      timestamp: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
