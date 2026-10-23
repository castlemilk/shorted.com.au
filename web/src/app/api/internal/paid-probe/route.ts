import { NextResponse, type NextRequest } from "next/server";

import { getServerShortsApiUrl } from "~/app/actions/config";
import { isAuthorizedProbeRequest } from "~/server/paid-probe/auth";
import { reportCheckins } from "~/server/paid-probe/checkins";
import { buildProbeContext } from "~/server/paid-probe/context";
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
 * The probe's own worst case is 72s (probeWorstCaseMs in steps.ts). It sits inside
 * the 75s ceiling of the admin tool that starts a run. maxDuration below is
 * headroom above that, not the budget. The built value is checked in CI by
 * scripts/verify-vercel-function-limits.mjs (EXPECTED_LIMITS), so a build that
 * drops it fails the deploy.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedProbeRequest(request, process.env)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const outcome = await runIfIdle(async () => {
    const run = await runPaidProbe(
      buildProbeContext(process.env, {
        requestUrl: request.url,
        shortsApiUrl: getServerShortsApiUrl(),
      }),
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
