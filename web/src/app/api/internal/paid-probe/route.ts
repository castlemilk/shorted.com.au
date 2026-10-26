import { NextResponse, type NextRequest } from "next/server";

import { getServerShortsApiUrl } from "~/app/actions/config";
import {
  isAuthorizedCronRequest,
  isAuthorizedProbeRequest,
} from "~/server/paid-probe/auth";
import { reportCheckins, type CheckinStatus } from "~/server/paid-probe/checkins";
import { buildProbeContext } from "~/server/paid-probe/context";
import { runIfIdle } from "~/server/paid-probe/run-lock";
import { runPaidProbe } from "~/server/paid-probe/steps";

/**
 * GET|POST /api/internal/paid-probe
 *
 * Runs the paid-feature probe: entitlement, a real chat send, the API token
 * path and the anonymous gates, as the svc-paid-probe identity. 200 when every
 * step passed and every Telesis check-in was accepted; 503 when a step failed,
 * 502 when the steps passed but a check-in was refused or misconfigured (see
 * statusFor). Each step's result is in the body.
 *
 * Callers: Vercel Cron (GET, every two hours, with CRON_SECRET) is the normal
 * schedule, and each run reports to its Telesis cron monitors, which alert on a
 * failed or missed run. On demand: the admin MCP's run_paid_probe via the shorts
 * API (POST, INTERNAL_SERVICE_SECRET), or PAID_PROBE_TOKEN. Nothing else
 * reaches it.
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request, process.env)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  return runProbe(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedProbeRequest(request, process.env)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  return runProbe(request);
}

async function runProbe(request: NextRequest): Promise<NextResponse> {
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
    statusFor(run.ok, checkins),
  );
}

/**
 * 200 when every step passed and every check-in was accepted (or none is
 * configured). 503 when a step failed. 502 when the steps passed but Telesis
 * refused a check-in or the check-in map is unusable: the monitors would then
 * miss this run, so the cron must show it as a failure, not a success.
 */
function statusFor(runOk: boolean, checkins: CheckinStatus): number {
  if (!runOk) return 503;
  return checkins === "sent" || checkins === "disabled" ? 200 : 502;
}

function jsonResponse(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
