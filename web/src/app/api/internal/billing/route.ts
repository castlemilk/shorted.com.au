import { type NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";

import { stripe } from "~/lib/stripe";
import {
  idOf,
  isoFromUnix,
  listCustomerSubscriptions,
  nonEmpty,
  pickBestSubscription,
  planForPrice,
  syncCustomerFromStripe,
} from "~/lib/billing-sync";
import { hasInternalSecret } from "~/server/internal-secret";

/**
 * POST /api/internal/billing — billing state for the admin MCP server.
 *
 *   { "action": "customer", "email" | "customerId" } → customer, subscriptions (every one, with
 *                                                       `representative` on the one the sync writes), latest invoice
 *   { "action": "alive" }                             → every live subscription (capped)
 *   { "action": "reconcile", "customerId" }           → re-sync that customer once, from its best subscription
 *
 * Server-to-server only (INTERNAL_SERVICE_SECRET). Only this app holds a Stripe
 * key, and the API has already checked that the caller is an administrator.
 *
 * Returns the fewest fields that say what state a customer is in. Nothing here
 * carries a name, address, phone number, card, payment method, or a hosted
 * invoice URL. Invoice links are how a customer's details leak, so they are
 * left out on purpose.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The Go caller gives up after 20s. The 15s catch-all would cut a slow lookup
// before the caller does, so this route carries its own budget.
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };
const LIST_CAP = 500;
const LIVE_STATUSES = ["active", "trialing", "past_due", "unpaid"] as const;
const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{1,100}$/;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasInternalSecret(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  try {
    if (body.action === "customer") return await customerAction(body);
    if (body.action === "alive") return await aliveAction();
    if (body.action === "reconcile") return await reconcileAction(body);
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (error) {
    console.error("[internal-billing] stripe lookup failed", error);
    return NextResponse.json({ error: "lookup failed" }, { status: 503 });
  }
}

async function customerAction(body: Record<string, unknown>): Promise<NextResponse> {
  const customerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (customerId) {
    if (!CUSTOMER_ID.test(customerId)) {
      return NextResponse.json({ error: "customerId is invalid" }, { status: 400 });
    }
    const customer = await retrieveCustomer(customerId);
    return NextResponse.json(await describeCustomer(customer), { headers: NO_STORE });
  }

  if (!email || email.length > 254 || !email.includes("@")) {
    return NextResponse.json({ error: "email or customerId is required" }, { status: 400 });
  }

  const matches = await customersForEmail(email);
  // Two customers under one address is a data problem, not something to pick
  // between. Report the ids and leave the decision to the operator.
  if (matches.length > 1) {
    return NextResponse.json(
      {
        customer: null,
        subscriptions: [],
        latestInvoice: null,
        ambiguous: true,
        customerIds: matches.map((customer) => customer.id),
      },
      { headers: NO_STORE },
    );
  }
  return NextResponse.json(
    await describeCustomer(matches[0] ?? null),
    { headers: NO_STORE },
  );
}

/**
 * Customers whose Stripe email matches the address as given, or in lowercase.
 *
 * Stripe's email filter is case-sensitive, and checkout stores the session email
 * exactly as the sign-in provider returned it. So the address as given is
 * searched, and so is its lowercase form when the two differ. Both are read and
 * merged by customer id, and not only the second when the first is empty. A
 * customer that differs from another only by case is a second customer, and
 * reporting one of two would hide the ambiguity this route exists to surface.
 */
async function customersForEmail(email: string): Promise<Stripe.Customer[]> {
  const addresses = [...new Set([email, email.toLowerCase()])];
  const lists = await Promise.all(
    addresses.map((address) => stripe.customers.list({ email: address, limit: 3 })),
  );
  const byId = new Map<string, Stripe.Customer>();
  for (const list of lists) {
    for (const customer of list.data) byId.set(customer.id, customer);
  }
  return [...byId.values()];
}

async function aliveAction(): Promise<NextResponse> {
  const subscriptions: Stripe.Subscription[] = [];
  let truncated = false;

  for (const status of LIVE_STATUSES) {
    for await (const subscription of stripe.subscriptions.list({
      status,
      limit: 100,
      expand: ["data.customer"],
    })) {
      if (subscriptions.length === LIST_CAP) {
        truncated = true;
        break;
      }
      subscriptions.push(subscription);
    }
    if (truncated) break;
  }

  return NextResponse.json(
    {
      subscriptions: subscriptions.map((subscription) => {
        const item = subscription.items.data[0];
        return {
          customerId: idOf(subscription.customer),
          subscriptionId: subscription.id,
          status: subscription.status,
          tier: planForPrice(item?.price.id),
          currentPeriodEnd: isoFromUnix(item?.current_period_end),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          metadataUserId: nonEmpty(subscription.metadata?.userId),
          email:
            nonEmpty(subscription.metadata?.userEmail) ??
            customerEmail(subscription.customer),
        };
      }),
      truncated,
    },
    { headers: NO_STORE },
  );
}

async function reconcileAction(body: Record<string, unknown>): Promise<NextResponse> {
  const customerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
  if (!CUSTOMER_ID.test(customerId)) {
    return NextResponse.json({ error: "customerId is required" }, { status: 400 });
  }

  // One write for the customer, from the subscription that represents it. Syncing
  // each subscription in turn would let the last one written decide.
  const subscription = await syncCustomerFromStripe(customerId);
  return NextResponse.json({ customerId, subscription }, { headers: NO_STORE });
}

/** A deleted customer is treated as absent, not as an error. */
async function retrieveCustomer(
  customerId: string,
): Promise<Stripe.Customer | null> {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return "deleted" in customer && customer.deleted ? null : customer;
  } catch (error) {
    if ((error as { code?: string })?.code === "resource_missing") return null;
    throw error;
  }
}

async function describeCustomer(customer: Stripe.Customer | null): Promise<object> {
  if (!customer) {
    return { customer: null, subscriptions: [], latestInvoice: null };
  }

  // Every subscription the customer has, not the first page. The drift check
  // reads this list to decide whether a customer has a live subscription, so a
  // payer whose live subscription sits past a page boundary would read as having
  // none.
  const [subscriptions, invoices] = await Promise.all([
    listCustomerSubscriptions(customer.id),
    stripe.invoices.list({ customer: customer.id, limit: 1 }),
  ]);
  const latest = invoices.data[0];
  // The subscription the sync writes for this customer, picked by the same rule
  // the sync uses, so the view and the mirror cannot disagree about which one
  // represents the customer.
  const representative = pickBestSubscription(subscriptions);

  return {
    customer: { id: customer.id, created: isoFromUnix(customer.created) },
    subscriptions: subscriptions.map((subscription) => {
      const item = subscription.items.data[0];
      const price = item?.price;
      return {
        id: subscription.id,
        representative: subscription.id === representative?.id,
        status: subscription.status,
        tier: planForPrice(price?.id),
        priceId: price?.id ?? null,
        amount: price?.unit_amount ?? null,
        currency: price?.currency ?? subscription.currency,
        interval: price?.recurring?.interval ?? null,
        currentPeriodStart: isoFromUnix(item?.current_period_start),
        currentPeriodEnd: isoFromUnix(item?.current_period_end),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        created: isoFromUnix(subscription.created),
        metadataUserId: nonEmpty(subscription.metadata?.userId),
      };
    }),
    latestInvoice: latest
      ? {
          status: latest.status,
          amountPaid: latest.amount_paid,
          currency: latest.currency,
          created: isoFromUnix(latest.created),
          paidAt: isoFromUnix(latest.status_transitions?.paid_at),
        }
      : null,
  };
}

/** The customer's email when Stripe expanded the customer, else null. */
function customerEmail(customer: string | Stripe.Customer | Stripe.DeletedCustomer): string | null {
  return typeof customer === "object" && "email" in customer
    ? customer.email ?? null
    : null;
}
