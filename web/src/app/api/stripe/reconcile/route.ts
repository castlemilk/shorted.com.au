import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "~/lib/stripe";
import {
  isLiveStripeStatus,
  syncSubscriptionFromStripe,
} from "~/lib/billing-sync";

/**
 * GET /api/stripe/reconcile — daily Vercel cron.
 *
 * Heals a lost webhook. Stripe stops retrying a failed delivery after about
 * three days, and the mirror then stays wrong until a later event for that
 * subscription happens to arrive. This re-reads every live subscription and every
 * one that ended in the last seven days, and writes Stripe's current state.
 *
 * Authorised by `Authorization: Bearer $CRON_SECRET` and nothing else. The
 * cache-warm helper is deliberately not reused: it allows every request when
 * CACHE_WARM_SECRET is unset, and it accepts a secret in the query string. This
 * route writes subscription state and calls Stripe, so it fails closed.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Stripe lists newest first. Past this many, the run reports `truncated`. */
const MAX_EXAMINED = 500;
const RECENTLY_ENDED_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounded so 500 syncs stay inside the function's 60s budget. */
const SYNC_CONCURRENCY = 5;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = Date.now();
    const candidates: string[] = [];
    let examined = 0;
    let truncated = false;

    for await (const subscription of stripe.subscriptions.list({
      status: "all",
      limit: 100,
    })) {
      if (examined === MAX_EXAMINED) {
        truncated = true;
        break;
      }
      examined += 1;
      if (needsReconcile(subscription, now)) {
        candidates.push(subscription.id);
      }
    }

    let synced = 0;
    let failed = 0;
    for (let start = 0; start < candidates.length; start += SYNC_CONCURRENCY) {
      const batch = candidates.slice(start, start + SYNC_CONCURRENCY);
      const outcomes = await Promise.allSettled(
        batch.map((id) => syncSubscriptionFromStripe(id)),
      );
      outcomes.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") {
          synced += 1;
          return;
        }
        failed += 1;
        const message =
          outcome.reason instanceof Error ? outcome.reason.message : "unknown";
        console.error(`[stripe-reconcile] sync failed for ${batch[index]}: ${message}`);
      });
    }

    return NextResponse.json(
      { examined, synced, failed, truncated },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error(`[stripe-reconcile] run failed: ${message}`);
    return NextResponse.json(
      { error: "reconcile failed" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function needsReconcile(subscription: Stripe.Subscription, now: number): boolean {
  if (isLiveStripeStatus(subscription.status)) return true;
  const endedAt = subscription.ended_at ?? subscription.canceled_at;
  return endedAt != null && endedAt * 1000 >= now - RECENTLY_ENDED_MS;
}

function isCronAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // Fail closed: an unset secret must not make the route public.
  if (!secret) return false;
  const expected = digest(`Bearer ${secret}`);
  const provided = digest(request.headers.get("authorization") ?? "");
  return timingSafeEqual(provided, expected);
}

/** Fixed-size digests, so a length difference neither leaks nor throws. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
