import { type NextRequest } from "next/server";

/** Accept both existing manual warm credentials and Vercel's cron header. */
export function isCacheWarmAuthorized(
  request: Pick<NextRequest, "headers" | "nextUrl">,
): boolean {
  const expectedSecret = process.env.CACHE_WARM_SECRET;
  // Preserve the existing optional-secret behavior for local installations.
  if (!expectedSecret) return true;

  const providedSecret = request.headers.get("x-cache-warm-secret") ??
    request.nextUrl.searchParams.get("secret");
  if (providedSecret === expectedSecret) return true;

  const cronSecret = process.env.CRON_SECRET;
  return !!cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`;
}
