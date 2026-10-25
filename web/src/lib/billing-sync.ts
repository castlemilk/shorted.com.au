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
import { notifyOperator } from "~/@/lib/operator-notify";

/**
 * Stripe -> Shorted subscription sync.
 *
 * Every webhook delivery, and every reconcile, is reduced to one question: what
 * is this customer's state right now? The answer is re-read from Stripe and
 * Stripe's CURRENT state is written. The event payload is never applied as a
 * diff, so delivery order and retries stop mattering. Applied as they arrived,
 * payloads were wrong in both directions: a retried customer.subscription.updated
 * (active) landing after customer.subscription.deleted re-granted Premium, and a
 * late invoice.payment_failed marked a paying customer past_due.
 *
 * The unit is the CUSTOMER. The backend row is keyed by customer, so one customer
 * has one answer, and that answer cannot depend on which of its subscriptions an
 * event named. Every sync lists the customer's subscriptions and writes the best
 * one: live beats ended (active, then trialing, past_due, unpaid), and within a
 * rank the newest wins. So an ended subscription's event writes its live sibling,
 * and an unpaid subscription's event does not demote an active one.
 *
 * Identity follows the subscription that is written. A hint (checkout session
 * metadata, the event's own metadata) describes the subscription the event named,
 * so it is used only when that subscription is the one that wins. Otherwise an
 * unrelated sibling's user would be written onto this customer's row.
 *
 * The two writes are safe to run together. The checkout RPC upserts the row by
 * user id, which is what creates it when subscription.created beat
 * checkout.session.completed, and it also repoints that user's row to the
 * customer it is given. So it runs only for an active or trialing subscription.
 * A past_due or unpaid subscription on a second customer that carries the same
 * user id would otherwise move a paying user's row onto a customer that is not
 * paying. The update RPC then always lands the true status and period, keyed by
 * customer, and it changes only a row that already belongs to that customer.
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

/**
 * Stripe statuses that entitle the customer. Only these may create a Shorted row
 * or repoint one to a customer (step 1 of a sync). A past_due or unpaid
 * subscription still writes its state by customer, but it never claims a user.
 */
const ENTITLING_STRIPE_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
]);

export function isEntitlingStripeStatus(status: string): boolean {
  return ENTITLING_STRIPE_STATUSES.has(status);
}

/**
 * Preference order among live subscriptions. Anything not listed is ended and
 * ranks after all of these.
 */
const LIVE_RANK: readonly string[] = ["active", "trialing", "past_due", "unpaid"];

/** Stripe status -> the enum the backend stores, and the name we report. */
const STATUS_MAP: Record<string, { proto: SubscriptionStatus; name: string }> = {
  active: { proto: SubscriptionStatus.ACTIVE, name: "active" },
  trialing: { proto: SubscriptionStatus.TRIALING, name: "trialing" },
  past_due: { proto: SubscriptionStatus.PAST_DUE, name: "past_due" },
  canceled: { proto: SubscriptionStatus.CANCELED, name: "canceled" },
  // Unpaid means Stripe has stopped retrying the invoices. The grace period covers
  // past_due only, so unpaid is stored as inactive and grants nothing.
  unpaid: { proto: SubscriptionStatus.INACTIVE, name: "inactive" },
  incomplete: { proto: SubscriptionStatus.INACTIVE, name: "inactive" },
  incomplete_expired: { proto: SubscriptionStatus.INACTIVE, name: "inactive" },
  paused: { proto: SubscriptionStatus.INACTIVE, name: "inactive" },
};
const UNKNOWN_STATUS = { proto: SubscriptionStatus.INACTIVE, name: "inactive" };

export type ShortedPlan = "premium" | "api_access" | "unknown";

/**
 * The backend tier a Shorted plan is written as. An unknown plan has no tier that
 * grants anything, so it is written as FREE and the operator is told.
 */
export function tierForPlan(plan: ShortedPlan): SubscriptionTier {
  switch (plan) {
    case "premium":
      return SubscriptionTier.PREMIUM;
    case "api_access":
      return SubscriptionTier.API_ACCESS;
    case "unknown":
      return SubscriptionTier.FREE;
  }
}

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
  /** The subscription that was written, which is the customer's best one. */
  subscriptionId: string;
  status: string;
  tier: "premium" | "api_access" | "free";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /**
   * True when this sync created or linked the Shorted row. False when the
   * written subscription is not entitling (past_due, unpaid, ended) or carries
   * no user identity, so only an existing row for its customer is updated.
   */
  ensuredRow: boolean;
}

/**
 * The subscription that represents a customer: the best live one, else the
 * newest ended one. Live ranks by LIVE_RANK; among equal ranks the newest wins.
 */
export function pickBestSubscription(
  subscriptions: readonly Stripe.Subscription[],
): Stripe.Subscription | undefined {
  let best: Stripe.Subscription | undefined;
  for (const candidate of subscriptions) {
    if (!best) {
      best = candidate;
      continue;
    }
    const byRank = rankOf(candidate.status) - rankOf(best.status);
    if (byRank < 0 || (byRank === 0 && candidate.created > best.created)) {
      best = candidate;
    }
  }
  return best;
}

function rankOf(status: string): number {
  const index = LIVE_RANK.indexOf(status);
  return index === -1 ? LIVE_RANK.length : index;
}

/**
 * Every subscription a customer has, newest first, read page by page up to a
 * cap. A customer with a long history still gets its live subscriptions ranked;
 * past the cap the ranking covers the newest that were read, which is far beyond
 * any history this business produces.
 */
const CUSTOMER_SUBSCRIPTION_CAP = 500;

export async function listCustomerSubscriptions(
  customerId: string,
): Promise<Stripe.Subscription[]> {
  let page = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });
  const all = [...page.data];
  while (page.has_more && all.length < CUSTOMER_SUBSCRIPTION_CAP) {
    const last = all[all.length - 1];
    if (!last) break;
    page = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      starting_after: last.id,
    });
    all.push(...page.data);
  }
  if (page.has_more) {
    console.warn(
      `[billing-sync] customer has more than ${CUSTOMER_SUBSCRIPTION_CAP} subscriptions; ranking covers the newest ${all.length}`,
    );
  }
  return all;
}

/**
 * Sync from a subscription event. The subscription named by the event is read
 * from Stripe, then the customer's best subscription is written, which may be a
 * sibling of the one named. Throws when Stripe or the backend fails, so the
 * webhook returns 500 and Stripe retries.
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

  const siblings = await listCustomerSubscriptions(customerId);
  const chosen = pickBestSubscription(siblings) ?? requested;
  // The hint describes the requested subscription. It is used only when that
  // subscription is the one being written.
  const identity = chosen.id === requested.id ? hint : {};
  return writeSubscriptionState(customerId, chosen, identity);
}

/**
 * Sync a customer that has no event to name, such as the daily reconcile or an
 * operator's re-sync. Writes the customer's best subscription, using only that
 * subscription's own metadata for identity. Returns null when the customer has
 * no subscriptions, which leaves the row as it is.
 */
export async function syncCustomerFromStripe(
  customerId: string,
): Promise<SubscriptionSyncResult | null> {
  const chosen = pickBestSubscription(await listCustomerSubscriptions(customerId));
  if (!chosen) return null;
  return writeSubscriptionState(customerId, chosen, {});
}

/**
 * Write one subscription's current state to the backend. Step 1 links the row
 * to the subscription, but only when it is entitling (active or trialing) and
 * carries an identity. Step 2 always writes the status and period, by customer.
 */
async function writeSubscriptionState(
  customerId: string,
  subscription: Stripe.Subscription,
  hint: SubscriptionSyncHint,
): Promise<SubscriptionSyncResult> {
  const status = STATUS_MAP[subscription.status] ?? UNKNOWN_STATUS;
  const isDeleted = subscription.status === "canceled";
  const item = subscription.items.data[0];
  const priceId = item?.price.id;
  const userId = nonEmpty(subscription.metadata?.userId) ?? nonEmpty(hint.userId);
  const userEmail =
    nonEmpty(subscription.metadata?.userEmail) ?? nonEmpty(hint.userEmail);

  // The plan decides the tier. A price that is not one of ours grants nothing:
  // it is written as FREE, and nothing creates or links a row for it.
  const plan = planForPrice(priceId);
  const tier = tierForPlan(plan);
  const unknownPlan = !isDeleted && plan === "unknown";

  // Step 1: create or link the Shorted row. Entitling only, so a past_due or
  // unpaid subscription can never create or repoint a row, and a canceled one is
  // never written back to active here.
  let ensuredRow = false;
  if (
    isEntitlingStripeStatus(subscription.status) &&
    plan !== "unknown" &&
    userId &&
    userEmail
  ) {
    await retryWithBackoff(
      async () => {
        return await client.handleStripeCheckoutCompleted({
          userId,
          userEmail,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          tier,
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
        tier,
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

  if (unknownPlan) {
    console.error(
      `[billing-sync] subscription ${subscription.id} is on a price that is not a configured Shorted plan (${priceId ?? "none"}); written as free, no access granted`,
    );
    await notifyOperator({
      subject: "Shorted subscription on an unknown Stripe price",
      text: [
        "A subscription is on a Stripe price that is not configured as a Shorted plan.",
        "It has been written as FREE, so it grants no access, until the price is mapped.",
        "",
        `Subscription: ${subscription.id}`,
        `Customer:     ${customerId}`,
        `Price:        ${priceId ?? "(none)"}`,
        `Status:       ${subscription.status}`,
        "",
        "Check STRIPE_PREMIUM_PRICE_ID, STRIPE_PRO_PRICE_ID and STRIPE_API_ACCESS_PRICE_ID.",
        "",
        "— shorted.com.au",
      ].join("\n"),
    });
  }

  return {
    subscriptionId: subscription.id,
    status: status.name,
    tier: isDeleted || plan === "unknown" ? "free" : plan,
    currentPeriodEnd: isoFromUnix(periodEnd),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    ensuredRow,
  };
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
