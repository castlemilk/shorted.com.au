import type Stripe from "stripe";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  BillingService,
  SubscriptionStatus,
  SubscriptionTier,
} from "~/gen/shorts/v1alpha1/billing_pb";
import { stripe } from "~/lib/stripe";
import { CHECKOUT_PLAN_CONFIG, type CheckoutTier } from "~/lib/stripe-plans";
import { retryWithBackoff, type RetryOptions } from "@/lib/retry";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "~/app/actions/config";

/**
 * Stripe -> Shorted subscription sync.
 *
 * Every webhook delivery, and every reconcile, is reduced to one question: which
 * subscription changed? The answer is re-read from Stripe and Stripe's CURRENT
 * state is written. The event payload is never applied as a diff, so delivery
 * order and retries stop mattering. Applied as they arrived, payloads were wrong
 * in both directions: a retried customer.subscription.updated (active) landing
 * after customer.subscription.deleted re-granted Premium, and a late
 * invoice.payment_failed marked a paying customer past_due.
 *
 * The two writes are safe to run together. The checkout RPC upserts the row by
 * user id, which is what creates it when subscription.created beat
 * checkout.session.completed. It runs only for live subscriptions, so it cannot
 * resurrect a canceled one. The update RPC then always lands the true status and
 * period, keyed by customer.
 *
 * A customer with a live subscription is represented by it, even when the event
 * is about an ended sibling (canceled, then resubscribed). The row is keyed by
 * customer, so writing the ended one would flip a paying customer to canceled.
 */

// Internal auth for the webhook/reconcile -> backend calls. Header names are
// lowercase for HTTP/2 compatibility.
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

const transport = createConnectTransport({
  fetch: serverFetchWithUserAgent,
  baseUrl: SHORTS_API_URL,
  interceptors: [
    (next) => async (req) => {
      req.header.set("x-internal-secret", INTERNAL_SECRET);
      req.header.set("x-user-id", "stripe-webhook");
      req.header.set("x-user-email", "webhook@shorted.com.au");
      return await next(req);
    },
  ],
});

const client = createClient(BillingService, transport);

const SYNC_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  shouldRetry: () => true,
};

/** Stripe statuses that still entitle the customer or can still be paid. */
const LIVE_STRIPE_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
]);

export function isLiveStripeStatus(status: string): boolean {
  return LIVE_STRIPE_STATUSES.has(status);
}

/** Stripe status -> the enum the backend stores, and the name we report. */
const STATUS_MAP: Record<string, { proto: SubscriptionStatus; name: string }> = {
  active: { proto: SubscriptionStatus.ACTIVE, name: "active" },
  trialing: { proto: SubscriptionStatus.TRIALING, name: "trialing" },
  past_due: { proto: SubscriptionStatus.PAST_DUE, name: "past_due" },
  canceled: { proto: SubscriptionStatus.CANCELED, name: "canceled" },
  // Unpaid is an overdue customer, so it reads as past due.
  unpaid: { proto: SubscriptionStatus.PAST_DUE, name: "past_due" },
  incomplete: { proto: SubscriptionStatus.INACTIVE, name: "inactive" },
  incomplete_expired: { proto: SubscriptionStatus.INACTIVE, name: "inactive" },
  paused: { proto: SubscriptionStatus.INACTIVE, name: "inactive" },
};
const UNKNOWN_STATUS = { proto: SubscriptionStatus.INACTIVE, name: "inactive" };

export type ShortedPlan = "premium" | "api_access" | "unknown";

/**
 * Every price id configured for a plan, through the same env names checkout
 * reads. The legacy premium env is included, so a subscription bought on it
 * still maps to premium.
 */
function configuredPriceIds(tier: CheckoutTier): string[] {
  return CHECKOUT_PLAN_CONFIG[tier].priceEnvNames
    .map((name) => process.env[name]?.trim())
    .filter((value): value is string => Boolean(value));
}

/**
 * Which Shorted plan a Stripe price is. It reads the same env names checkout
 * uses, so checkout and the sync cannot disagree about a price.
 */
export function planForPrice(priceId: string | null | undefined): ShortedPlan {
  if (!priceId) return "unknown";
  if (configuredPriceIds("premium").includes(priceId)) return "premium";
  if (configuredPriceIds("api_access").includes(priceId)) return "api_access";
  return "unknown";
}

/** Stripe fields are either an id or the expanded object. Both carry the id. */
export function idOf(
  ref: string | { id: string } | null | undefined,
): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/** Stripe metadata is strings, and an empty one means the key is not set. */
export function nonEmpty(value: string | null | undefined): string | null {
  return value ? value : null;
}

/** Unix seconds to ISO, or null when Stripe did not send the field. */
export function isoFromUnix(seconds: number | null | undefined): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

export interface SubscriptionSyncHint {
  userId?: string | null;
  userEmail?: string | null;
}

export interface SubscriptionSyncResult {
  subscriptionId: string;
  status: string;
  tier: "premium" | "free";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /**
   * True when this sync created or linked the Shorted row. False when the
   * subscription carried no user identity, so only an existing row can be
   * updated.
   */
  ensuredRow: boolean;
}

/**
 * Read a subscription from Stripe and write its current state to the backend.
 * Throws when a write fails, so the webhook returns 500 and Stripe retries.
 */
export async function syncSubscriptionFromStripe(
  subscriptionId: string,
  hint: SubscriptionSyncHint = {},
): Promise<SubscriptionSyncResult> {
  const requested = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = idOf(requested.customer);
  if (!customerId) {
    throw new Error(`Stripe subscription ${subscriptionId} has no customer`);
  }

  const subscription = isLiveStripeStatus(requested.status)
    ? requested
    : ((await liveSubscriptionFor(customerId)) ?? requested);

  const status = STATUS_MAP[subscription.status] ?? UNKNOWN_STATUS;
  const isDeleted = subscription.status === "canceled";
  const item = subscription.items.data[0];
  const priceId = item?.price.id;
  const userId = nonEmpty(subscription.metadata?.userId) ?? nonEmpty(hint.userId);
  const userEmail =
    nonEmpty(subscription.metadata?.userEmail) ?? nonEmpty(hint.userEmail);

  if (!isDeleted && planForPrice(priceId) === "unknown") {
    console.warn(
      `[billing-sync] subscription ${subscription.id} is on a price that is not a configured Shorted plan (${priceId ?? "none"}); written as premium`,
    );
  }

  // Step 1: create or link the Shorted row. Live only, so a canceled
  // subscription is never written back to active here.
  let ensuredRow = false;
  if (isLiveStripeStatus(subscription.status) && userId && userEmail) {
    await retryWithBackoff(
      async () => {
        return await client.handleStripeCheckoutCompleted({
          userId,
          userEmail,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          tier: SubscriptionTier.PREMIUM,
        });
      },
      SYNC_RETRY_OPTIONS,
    );
    ensuredRow = true;
  }

  // Step 2: always write the full current state. This is the write that carries
  // the true status, so it must land even when step 1 ran.
  const periodStart = item?.current_period_start;
  const periodEnd = item?.current_period_end;
  await retryWithBackoff(
    async () => {
      return await client.handleStripeSubscriptionUpdated({
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        status: status.proto,
        tier: SubscriptionTier.PREMIUM,
        currentPeriodStart: periodStart
          ? timestampFromDate(new Date(periodStart * 1000))
          : undefined,
        currentPeriodEnd: periodEnd
          ? timestampFromDate(new Date(periodEnd * 1000))
          : undefined,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        isDeleted,
      });
    },
    SYNC_RETRY_OPTIONS,
  );

  return {
    subscriptionId: subscription.id,
    status: status.name,
    tier: isDeleted ? "free" : "premium",
    currentPeriodEnd: isoFromUnix(periodEnd),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    ensuredRow,
  };
}

/**
 * The customer's newest live subscription, if any. Stripe lists newest first.
 */
async function liveSubscriptionFor(
  customerId: string,
): Promise<Stripe.Subscription | null> {
  const list = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 10,
  });
  return list.data.find((candidate) => isLiveStripeStatus(candidate.status)) ?? null;
}

/**
 * The subscription an invoice belongs to, or null for an invoice that has none
 * (a one-off charge).
 *
 * The id lives under `parent.subscription_details` on the 2025-12-15 API. The
 * top-level `subscription` field is the legacy location, read only as a
 * fallback. Last resort is the customer's newest non-expired subscription.
 */
export async function resolveSubscriptionIdForInvoice(
  invoice: Stripe.Invoice,
): Promise<string | null> {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  if (fromParent) return idOf(fromParent);

  const legacy = (invoice as unknown as {
    subscription?: string | { id: string } | null;
  }).subscription;
  if (legacy) return idOf(legacy);

  const customerId = idOf(invoice.customer);
  if (!customerId) return null;
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 5,
  });
  const newest = subscriptions.data.find(
    (candidate) => candidate.status !== "incomplete_expired",
  );
  return newest?.id ?? null;
}
