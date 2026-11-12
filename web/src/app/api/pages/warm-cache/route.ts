import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";
import { isCacheWarmAuthorized } from "~/@/lib/cache-warm-auth";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const NO_STORE = { "Cache-Control": "no-store" };

// The invalidation must finish in its own request before the homepage is read.
// Next commits revalidatePath after a route handler returns; fetching the page
// in that same handler can warm the old entry immediately before it is deleted.
export async function POST(request: NextRequest) {
  if (!isCacheWarmAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // On Vercel, untyped "/" invalidation expires pages throughout the site.
  revalidatePath("/", "page");
  return NextResponse.json({ invalidated: true }, { headers: NO_STORE });
}

export async function GET(request: NextRequest) {
  if (!isCacheWarmAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deploymentHost = process.env.VERCEL_URL?.trim();
  let origin: string;
  if (deploymentHost) {
    try {
      const url = new URL(`https://${deploymentHost}`);
      if (!url.hostname.endsWith(".vercel.app") || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        return NextResponse.json({ success: false, stage: "origin" }, { status: 503, headers: NO_STORE });
      }
      origin = url.origin;
    } catch {
      return NextResponse.json({ success: false, stage: "origin" }, { status: 503, headers: NO_STORE });
    }
  } else if (["localhost", "127.0.0.1", "[::1]"].includes(request.nextUrl.hostname)) {
    origin = request.nextUrl.origin;
  } else {
    // Never forward the caller's warm credential to an untrusted Host header.
    return NextResponse.json({ success: false, stage: "origin" }, { status: 503, headers: NO_STORE });
  }
  const pageHeaders = new Headers({ "User-Agent": BROWSER_UA });
  if (deploymentHost && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    pageHeaders.set("x-vercel-protection-bypass", process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
  }
  const invalidateHeaders = new Headers(pageHeaders);
  for (const name of ["authorization", "x-cache-warm-secret"]) {
    const value = request.headers.get(name);
    if (value) invalidateHeaders.set(name, value);
  }

  let stage = "invalidate";
  try {
    const invalidation = await fetch(`${origin}/api/pages/warm-cache`, {
      method: "POST",
      headers: invalidateHeaders,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!invalidation.ok) {
      return NextResponse.json({ success: false, stage }, { status: 502, headers: NO_STORE });
    }
    const result: unknown = await invalidation.json();
    if (!result || typeof result !== "object" || !("invalidated" in result) || result.invalidated !== true) {
      return NextResponse.json({ success: false, stage }, { status: 502, headers: NO_STORE });
    }

    stage = "warm";
    const page = await fetch(`${origin}/`, {
      headers: pageHeaders,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!page.ok) {
      return NextResponse.json({ success: false, stage }, { status: 502, headers: NO_STORE });
    }
    await page.text();
    return NextResponse.json({ success: true, warmed: "/" }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ success: false, stage }, { status: 502, headers: NO_STORE });
  }
}
