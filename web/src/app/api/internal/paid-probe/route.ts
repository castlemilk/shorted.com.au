import { NextResponse, type NextRequest } from "next/server";

import { getServerShortsApiUrl } from "~/app/actions/config";
import { isAuthorizedProbeRequest } from "~/server/paid-probe/auth";
import { reportCheckins } from "~/server/paid-probe/checkins";
import { buildProbeContext, resolveProbeOrigin } from "~/server/paid-probe/context";
import { runIfIdle } from "~/server/paid-probe/run-lock";
import { runPaidProbe } from "~/server/paid-probe/steps";

/**
 * POST /api/internal/paid-probe
 *
 * Runs the paid-feature probe: entitlement, a real chat send, the API token
 * path and the anonymous gates, as the svc-paid-probe identity. 200 when every
 * step passed, 503 otherwise, with each step's result in the body.
 *
 * Callers: Telesis with PAID_PROBE_TOKEN as a Bearer token, or the shorts API
 * with INTERNAL_SERVICE_SECRET. Nothing else reaches it.
 *
 * maxDuration is set in two places: the export here, and a web/vercel.json entry
 * placed before the catch-all `src/app` entry. Vercel uses the first matching
 * glob, so without that ordering the catch-all's 15s would end the run early.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedProbeRequest(request, process.env)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const outcome = await runIfIdle(async () => {
    const origin = resolveProbeOrigin(request.url, process.env.PAID_PROBE_BASE_URL);
    const run = await runPaidProbe(
      buildProbeContext(process.env, { origin, shortsApiUrl: getServerShortsApiUrl() }),
    );
    const checkins = await reportCheckins(run, process.env);
    return { run, checkins };
  });
  if (!outcome.ran) {
    return jsonResponse(
      { error: "A paid-feature probe is already running on this instance" },
      409,
    );
  }

  const { run, checkins } = outcome.value;
  return jsonResponse(
    {
      ok: run.ok,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      steps: run.steps,
      checkins,
    },
    run.ok ? 200 : 503,
  );
}

function jsonResponse(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
