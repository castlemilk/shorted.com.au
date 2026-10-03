import { type NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import isrShellPages from "~/config/isr-shell-pages.json";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SHELL_MARKER = 'data-isr-shell="empty"';
const CONCURRENCY = 5;

// Builds deliberately skip live data and prerender empty shells. A deployment
// explicitly invalidates and primes them. The hourly repair only invalidates
// confirmed shells, leaving healthy ISR entries to their own TTL/data events.
export async function GET(request: NextRequest) {
  const expectedSecret = process.env.CACHE_WARM_SECRET;
  const providedSecret = request.headers.get("x-cache-warm-secret") ??
    request.nextUrl.searchParams.get("secret");
  const cronAuthorized = process.env.CRON_SECRET &&
    request.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (expectedSecret && providedSecret !== expectedSecret && !cronAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mode = request.nextUrl.searchParams.get("mode") ?? "repair";
  if (mode !== "repair" && mode !== "deploy") {
    return NextResponse.json({ error: "mode must be repair or deploy" }, { status: 400 });
  }

  // Direct deployment origin avoids Cloudflare challenges. Existing deployment
  // protection credentials stay server-side and are only sent to this origin.
  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : request.nextUrl.origin;
  const headers: Record<string, string> = { "User-Agent": BROWSER_UA };
  if (process.env.VERCEL_URL && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  const start = Date.now();
  // Next commits revalidatePath after this handler returns. Invalidation and
  // priming must be separate HTTP requests; a self-fetch here cannot observe
  // an invalidation queued by this request.
  if (mode === "deploy") {
    for (const path of isrShellPages) revalidatePath(path);
    return NextResponse.json({
      success: false,
      invalidated: true,
      pending: true,
      mode,
      paths: isrShellPages,
      message: "Build shells invalidated; call repair after this response to prime them",
    }, { headers: { "Cache-Control": "no-store" } });
  }
  const results: Record<string, {
    success: boolean;
    action: "checked" | "repair-pending";
    ms: number;
    error?: string;
  }> = {};

  async function readPage(path: string): Promise<boolean> {
    const response = await fetch(`${origin}${path}`, {
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.text()).includes(SHELL_MARKER);
  }

  for (let offset = 0; offset < isrShellPages.length; offset += CONCURRENCY) {
    await Promise.all(isrShellPages.slice(offset, offset + CONCURRENCY).map(async (path) => {
      const pageStart = Date.now();
      let action: "checked" | "repair-pending" = "checked";
      try {
        const shell = await readPage(path);
        if (shell) {
          revalidatePath(path);
          action = "repair-pending";
        }
        results[path] = {
          success: !shell,
          action,
          ms: Date.now() - pageStart,
        };
      } catch (error) {
        results[path] = {
          success: false,
          action,
          ms: Date.now() - pageStart,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
  }

  const successCount = Object.values(results).filter((result) => result.success).length;
  const success = successCount === isrShellPages.length;
  const pending = Object.values(results).some((result) => result.action === "repair-pending");
  const failed = Object.values(results).some((result) => result.error);
  return NextResponse.json({
    success,
    pending,
    mode,
    message: `Ready ${successCount}/${isrShellPages.length} static pages`,
    results,
    duration: `${Date.now() - start}ms`,
    timestamp: new Date().toISOString(),
  }, { status: failed ? 503 : pending ? 202 : 200, headers: { "Cache-Control": "no-store" } });
}
