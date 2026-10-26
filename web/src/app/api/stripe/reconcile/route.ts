import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "~/lib/stripe";
import {
  idOf,
  isLiveStripeStatus,
  syncCustomerFromStripe,
} from "~/lib/billing-sync";
import { notifyOperator } from "~/@/lib/operator-notify";
import {
  isTelesisCheckinURL,
  postCheckin,
} from "~/server/paid-probe/checkins";

/**
 * GET /api/stripe/reconcile — daily Vercel cron.
 *
 * Heals a lost webhook. Stripe stops retrying a failed delivery after about
 * three days, and the mirror then stays wrong until a later event for that
 * customer happens to arrive. This finds every customer with a live subscription
 * or one that ended in the last seven days, and writes each customer's current
 * state once.
 *
 * Authorised by `Authorization: Bearer $CRON_SECRET` and nothing else. The
 * cache-warm helper is deliberately not reused: it allows every request when
 * CACHE_WARM_SECRET is unset, and it accepts a secret in the query string. This
 * route writes subscription state and calls Stripe, so it fails closed.
 *
 * A run that fails a customer, truncates its listing or cannot list at all
 * notifies the operator with counts only. Without that alert a cron that fails
 * every night is indistinguishable from one that has nothing to do.
 *
 * Every run also checks in with its Telesis cron monitor (`stripe-reconcile`),
 * carrying the same counts. A run that never fires sends nothing, so the monitor
 * reports it missed; a run that fires with problems sends /fail.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Stripe lists newest first. Past this many, the run reports `truncated`. */
const MAX_EXAMINED = 500;
const RECENTLY_ENDED_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounded so the customer syncs stay inside the function's 60s budget. */
const SYNC_CONCURRENCY = 5;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const now = Date.now();
    const customerIds = new Set<string>();
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
        const customerId = idOf(subscription.customer);
        if (customerId) customerIds.add(customerId);
      }
    }

    // One sync per customer. A customer with two subscriptions is written from
    // its best one, so syncing each subscription would race them for the row.
    const customers = [...customerIds];
    let synced = 0;
    let failed = 0;
    for (let start = 0; start < customers.length; start += SYNC_CONCURRENCY) {
      const batch = customers.slice(start, start + SYNC_CONCURRENCY);
      const outcomes = await Promise.allSettled(
        batch.map((customerId) => syncCustomerFromStripe(customerId)),
      );
      outcomes.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") {
          if (outcome.value) synced += 1;
          return;
        }
        failed += 1;
        const message =
          outcome.reason instanceof Error ? outcome.reason.message : "unknown";
        console.error(
          `[stripe-reconcile] sync failed for ${batch[index]}: ${message}`,
        );
      });
    }

    if (failed > 0 || truncated) {
      await notifyReconcileProblem({
        examined,
        customers: customers.length,
        synced,
        failed,
        truncated,
      });
    }

    await reportCheckin(
      startedAt,
      failed === 0 && !truncated,
      `examined=${examined} customers=${customers.length} synced=${synced} failed=${failed} truncated=${truncated ? "yes" : "no"}`,
    );

    return NextResponse.json(
      { examined, customers: customers.length, synced, failed, truncated },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error(`[stripe-reconcile] run failed: ${message}`);
    await reportCheckin(startedAt, false, "run failed: could not list subscriptions");
    await notifyOperator({
      subject: "Shorted Stripe reconcile: run failed",
      text: [
        "The daily Stripe reconcile could not list subscriptions, so this run synced nothing.",
        "The error is in the Vercel function log for /api/stripe/reconcile.",
        "",
        "— shorted.com.au",
      ].join("\n"),
    });
    return NextResponse.json(
      { error: "reconcile failed" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * Telesis heartbeat for this run, in the paid probe's check-in protocol
 * (`/complete` or `/fail`, `terminal_reason` carries the counts). Dormant when the
 * variable is unset. A value that is set but is not a Telesis check-in URL is
 * reported by name only, and nothing is sent, so the monitor reports the run missed.
 */
async function reportCheckin(startedAt: number, ok: boolean, reason: string): Promise<void> {
  const raw = process.env.TELESIS_STRIPE_RECONCILE_CHECKIN?.trim();
  if (!raw) return;
  if (!isTelesisCheckinURL(raw)) {
    console.warn("[stripe-reconcile] TELESIS_STRIPE_RECONCILE_CHECKIN is not a Telesis check-in URL; check-in skipped");
    return;
  }
  await postCheckin(fetch, "stripe-reconcile", raw, ok, Date.now() - startedAt, reason);
}

/** Counts only. The customer ids that failed are in the function log. */
async function notifyReconcileProblem(counts: {
  examined: number;
  customers: number;
  synced: number;
  failed: number;
  truncated: boolean;
}): Promise<void> {
  const problems = [
    counts.failed > 0 ? `${counts.failed} failed` : null,
    counts.truncated ? "list truncated" : null,
  ].filter(Boolean);
  await notifyOperator({
    subject: `Shorted Stripe reconcile: ${problems.join(", ")}`,
    text: [
      "The daily Stripe reconcile finished with problems. Counts only; no customer details are included.",
      "",
      `Subscriptions examined: ${counts.examined}`,
      `Customers found:        ${counts.customers}`,
      `Customers synced:       ${counts.synced}`,
      `Customers failed:       ${counts.failed}`,
      `Listing truncated:      ${counts.truncated ? "yes" : "no"}`,
      "",
      "Failed customers are logged as [stripe-reconcile] in the Vercel function log.",
      "A truncated listing means some customers were not examined at all.",
      "",
      "— shorted.com.au",
    ].join("\n"),
  });
}

function needsReconcile(subscription: Stripe.Subscription, now: number): boolean {
  if (isLiveStripeStatus(subscription.status)) return true;
  const endedAt = subscription.ended_at ?? subscription.canceled_at;
  return endedAt != null && endedAt * 1000 >= now - RECENTLY_ENDED_MS;
}

function isCronAuthorized(request: NextRequest): boolean {
  return bearerMatches(request, process.env.CRON_SECRET);
}

/**
 * Constant-time Bearer check with the same rules as the paid probe's cron door
 * (web/src/server/paid-probe/auth.ts), so the two cron doors agree. The configured
 * secret and the presented token are both trimmed. A blank value on either side
 * never matches, and an unset secret disables the door. Without the trim, a secret
 * stored with a trailing newline would fail here and pass there.
 */
function bearerMatches(request: NextRequest, expected: string | undefined): boolean {
  const configured = expected?.trim();
  if (!configured) return false;

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  if (!presented) return false;

  return timingSafeEqual(digest(presented), digest(configured));
}

/** Fixed-size digests, so a length difference neither leaks nor throws. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
