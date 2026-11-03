import { createHash, timingSafeEqual } from "node:crypto";
import { type NextRequest } from "next/server";

/**
 * Who may run the warm-cache routes: api/about, api/homepage, api/pages and
 * api/static-pages warm-cache, and api/warm-pages. A request passes when it
 * carries one of these. A secret in the query string never counts.
 *
 * - `Authorization: Bearer <CRON_SECRET>`: Vercel Cron.
 * - `Authorization: Bearer <REVALIDATION_SECRET>`: the deploy's prime step. The
 *   deploy already holds this secret for /api/revalidate, so accepting it here
 *   adds no privilege.
 * - `X-Cache-Warm-Secret: <CACHE_WARM_SECRET>`: manual runs.
 *
 * With none of the three configured, the routes answer everyone off Vercel, so
 * local dev, scripts/local-verify.sh and the tests keep working. On Vercel the
 * same state refuses every request. A deployment counts as Vercel when VERCEL,
 * VERCEL_ENV or VERCEL_REGION is set. An empty or blank variable counts as unset.
 */
export function isCacheWarmAuthorized(request: Pick<NextRequest, "headers">): boolean {
  const cronSecret = configured("CRON_SECRET");
  const revalidationSecret = configured("REVALIDATION_SECRET");
  const warmSecret = configured("CACHE_WARM_SECRET");

  if (!cronSecret && !revalidationSecret && !warmSecret) {
    return !onVercel();
  }

  const bearer = bearerToken(request.headers.get("authorization"));
  if (sameSecret(bearer, cronSecret) || sameSecret(bearer, revalidationSecret)) {
    return true;
  }
  return sameSecret(request.headers.get("x-cache-warm-secret")?.trim(), warmSecret);
}

/** A configured variable, trimmed. An empty or blank variable is not configured. */
function configured(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
}

/**
 * Whether this is a Vercel deployment: VERCEL, VERCEL_ENV or VERCEL_REGION set
 * to a non-blank value. config.ts and edgeRead.ts test these with `??`, where
 * VERCEL set to an empty string hides the rest, so this check reads each one.
 * config.ts does not export its check, so this module keeps its own.
 */
function onVercel(): boolean {
  return ["VERCEL", "VERCEL_ENV", "VERCEL_REGION"].some((name) => configured(name) !== undefined);
}

/** The token after `Bearer `, or undefined. The scheme is matched exactly, as Vercel sends it. */
function bearerToken(header: string | null): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? undefined : token;
}

/**
 * Constant-time equality. Both sides are hashed first, so a length difference
 * neither throws nor leaks, and a blank value on either side never matches.
 */
function sameSecret(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}
