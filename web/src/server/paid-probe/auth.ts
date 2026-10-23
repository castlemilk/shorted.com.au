import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { hasInternalSecret } from "~/server/internal-secret";

/**
 * Who may start a probe run.
 *
 * Two doors, both fail closed:
 * - the internal service secret (`x-internal-secret` or a Bearer token), so the
 *   shorts API can trigger a run;
 * - a dedicated PAID_PROBE_TOKEN as a Bearer token, so Telesis can call the
 *   route without holding the all-powerful internal secret.
 */
export function isAuthorizedProbeRequest(
  request: NextRequest,
  env: NodeJS.ProcessEnv,
): boolean {
  if (hasInternalSecret(request)) return true;
  return bearerMatches(request, env.PAID_PROBE_TOKEN);
}

/**
 * Constant-time Bearer check. An unset or blank expected token disables this
 * door outright, and a blank presented token never matches. The comparison
 * hashes both sides first so a length difference neither throws nor leaks.
 */
export function bearerMatches(
  request: NextRequest,
  expected: string | undefined,
): boolean {
  const configured = expected?.trim();
  if (!configured) return false;

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  if (!presented) return false;

  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured).digest();
  return timingSafeEqual(a, b);
}
