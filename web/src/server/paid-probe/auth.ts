import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { hasInternalSecret } from "~/server/internal-secret";

import type { ProbeEnv } from "./types";

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
  env: ProbeEnv,
): boolean {
  if (hasInternalSecret(request)) return true;
  return bearerMatches(request, env.PAID_PROBE_TOKEN);
}

/**
 * The scheduled run: Vercel Cron calls GET with `Authorization: Bearer
 * $CRON_SECRET`. This is the door the probe normally runs through, so no
 * credential has to live in Telesis — Telesis validates the run through the
 * per-step check-ins (a failed or missed run alerts), not by calling us.
 */
export function isAuthorizedCronRequest(
  request: NextRequest,
  env: ProbeEnv,
): boolean {
  return bearerMatches(request, env.CRON_SECRET);
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
