import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "~/lib/stripe";
import { auth } from "~/server/auth";
import { rateLimit } from "~/@/lib/rate-limit";
import { recordProductEvent } from "~/@/lib/product-events";
import {
  resolveCheckoutPriceId,
  validateCheckoutPriceForTier,
} from "~/lib/stripe-plans";
import {
  isLiveStripeStatus,
  listCustomerSubscriptions,
  pickBestSubscription,
} from "~/lib/billing-sync";
import { getSubscriptionStatus } from "~/app/actions/subscription";

/**
 * Who a checkout may act for. The only Stripe customer this route ever opens a portal
 * for, or reuses for a new session, is the one on the caller's OWN mirror row, which
 * is keyed by their user id. A customer found by the session email is never used.
 *
 * The session email comes from the sign-in and may be unverified, so an email match
 * proves nothing about who owns that Stripe customer. Acting on one would hand a
 * stranger the billing portal of a paying customer (a portal session can cancel,
 * re-card or read invoices). So an email match can only refuse, never grant.
 */

/** The message a customer sees when they already pay and we cannot change it here. */
const CHECKOUT_REFUSED_MESSAGE =
  "Sign in with the account you subscribed with, or contact support.";
/**
 * The one code for a refused checkout. It does NOT say that a subscription exists:
 * the session email may be unverified, so anyone could otherwise ask which emails pay.
 */
const CHECKOUT_REFUSED_CODE = "checkout_refused";

/**
 * Sends a customer who already pays to a billing-portal session for their own
 * customer, the same customer /api/stripe/portal uses.
 *
 * It first tries a subscription-update flow for the live subscription, which lets
 * the plan change in Stripe's UI. Stripe can refuse that flow for a past_due or
 * unpaid subscription. So a refusal falls back to a plain portal session, where the
 * customer can at least update the card. Only if that also fails does the customer
 * get the contact-support 409.
 */
async function planSwitchResponse({
  customerId,
  subscriptionId,
  tier,
}: {
  customerId: string;
  subscriptionId: string;
  tier: string;
}): Promise<NextResponse> {
  const baseUrl = process.env.NEXTAUTH_URL ?? "https://shorted.com.au";
  const returnUrl = `${baseUrl}/pricing`;

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      flow_data: {
        type: "subscription_update",
        subscription_update: { subscription: subscriptionId },
      },
    });
    recordProductEvent({
      feature: "payment",
      action: "checkout_create",
      status: "success",
      properties: { tier, outcome: "portal_plan_switch" },
    });
    return NextResponse.json({ url: portal.url, outcome: "portal_plan_switch" });
  } catch (error) {
    console.warn(
      `[checkout] plan-switch portal refused (${error instanceof Error ? error.name : "unknown"}); falling back to a card-update portal`,
    );
  }

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    recordProductEvent({
      feature: "payment",
      action: "checkout_create",
      status: "success",
      properties: { tier, outcome: "portal_card_update" },
    });
    return NextResponse.json({ url: portal.url, outcome: "portal_card_update" });
  } catch (error) {
    console.error("Stripe portal session failed:", error);
    recordProductEvent({
      feature: "payment",
      action: "checkout_create",
      status: "error",
      properties: { tier, error_type: CHECKOUT_REFUSED_CODE },
    });
    return NextResponse.json(
      { error: CHECKOUT_REFUSED_CODE, message: CHECKOUT_REFUSED_MESSAGE },
      { status: 409 }
    );
  }
}

/** The subscription a portal should act on: the customer's best live one, if any. */
async function bestLiveSubscription(customerId: string): Promise<Stripe.Subscription | undefined> {
  const live = (await listCustomerSubscriptions(customerId)).filter((subscription) =>
    isLiveStripeStatus(subscription.status),
  );
  return pickBestSubscription(live);
}

/**
 * How long a Checkout Session stays payable. Stripe requires at least 30
 * minutes, measured when the request arrives, so an exact 30 would be refused
 * by any request that takes time to reach Stripe. The margin keeps the floor
 * honest. Shorter sessions shrink the window in which a second checkout can be
 * paid for.
 */
const CHECKOUT_SESSION_LIFETIME_SECONDS = 31 * 60;

export async function POST(request: NextRequest) {
  const started = Date.now();
  let tier = "premium";

  try {
    const session = await auth();

    if (!session?.user?.email) {
      recordProductEvent({
        feature: "payment",
        action: "checkout_create",
        status: "unauthenticated",
      });
      return NextResponse.json(
        { error: "You must be signed in to subscribe" },
        { status: 401 }
      );
    }

    // Look up the price ID server-side; price IDs are never trusted from clients.
    const body = (await request.json().catch(() => ({}))) as { tier?: unknown };
    const priceResolution = resolveCheckoutPriceId(body.tier);
    tier = priceResolution.tier;

    recordProductEvent({
      feature: "payment",
      action: "checkout_create",
      status: "attempt",
      properties: { tier },
    });

    const rateLimitResult = await rateLimit(request, {
      anonymousLimit: 2,
      authenticatedLimit: 12,
      windowSeconds: 60,
    });
    if (!rateLimitResult.success) {
      recordProductEvent({
        feature: "payment",
        action: "checkout_create",
        status: "rate_limited",
        properties: {
          tier,
          limit_kind: "per_minute",
          route_group: "/api/stripe/*",
        },
      });
      return rateLimitResult.response;
    }

    if (!priceResolution.ok) {
      recordProductEvent({
        feature: "payment",
        action: "checkout_create",
        status: "error",
        properties: { tier, error_type: priceResolution.errorType },
      });
      return NextResponse.json(
        { error: priceResolution.message },
        { status: priceResolution.status }
      );
    }

    const { priceId } = priceResolution;
    const stripePrice = await stripe.prices.retrieve(priceId);
    const priceValidation = validateCheckoutPriceForTier(
      priceResolution.tier,
      stripePrice
    );
    if (!priceValidation.ok) {
      recordProductEvent({
        feature: "payment",
        action: "checkout_create",
        status: "error",
        properties: { tier, error_type: priceValidation.errorType },
      });
      return NextResponse.json(
        {
          error:
            "Payment pricing is misconfigured. Please contact support before subscribing.",
        },
        { status: 500 }
      );
    }

    // The caller's own customer, from their mirror row. Without it we cannot tell a
    // first purchase from a second one, so refuse for now rather than risk a second
    // charge. The customer is told to try again.
    const mirror = await getSubscriptionStatus();
    if (mirror.lookupFailed) {
      recordProductEvent({
        feature: "payment",
        action: "checkout_create",
        status: "error",
        properties: { tier, error_type: "subscription_lookup_failed" },
      });
      return NextResponse.json(
        {
          error: "subscription_lookup_failed",
          message: "We couldn't confirm your subscription just now. Try again in a moment.",
        },
        { status: 503 }
      );
    }
    const ownCustomerId = mirror.stripeCustomerId ?? null;

    if (ownCustomerId) {
      const current = await bestLiveSubscription(ownCustomerId);
      if (current) {
        return planSwitchResponse({
          customerId: ownCustomerId,
          subscriptionId: current.id,
          tier,
        });
      }
    }

    // A Stripe customer found by the session email may already pay. The caller does
    // not own it (the email is unverified), so it is never opened or reused. It can
    // only refuse: a live subscription there sends the caller to support.
    const emailMatches = await stripe.customers.list({
      email: session.user.email,
      limit: 10,
    });
    for (const emailCustomer of emailMatches.data) {
      if (emailCustomer.id === ownCustomerId) continue;
      const live = await bestLiveSubscription(emailCustomer.id);
      if (live) {
        recordProductEvent({
          feature: "payment",
          action: "checkout_create",
          status: "error",
          properties: { tier, error_type: CHECKOUT_REFUSED_CODE },
        });
        return NextResponse.json(
          { error: CHECKOUT_REFUSED_CODE, message: CHECKOUT_REFUSED_MESSAGE },
          { status: 409 }
        );
      }
    }

    // Determine the base URL for redirects
    const baseUrl = process.env.NEXTAUTH_URL ?? "https://shorted.com.au";

    // Create Stripe checkout session. It reuses only the caller's own customer. With
    // none, Stripe takes the email for a new customer.
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer: ownCustomerId ?? undefined,
      customer_email: ownCustomerId ? undefined : session.user.email,
      client_reference_id: session.user.id,
      metadata: {
        userId: session.user.id,
        userEmail: session.user.email,
        tier,
      },
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_SESSION_LIFETIME_SECONDS,
      success_url: `${baseUrl}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pricing?canceled=true`,
      subscription_data: {
        metadata: {
          userId: session.user.id,
          userEmail: session.user.email,
          tier,
        },
      },
    });

    recordProductEvent({
      feature: "payment",
      action: "checkout_create",
      status: "success",
      properties: {
        tier,
        duration_ms: Date.now() - started,
      },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    console.error("Stripe checkout error:", error);
    recordProductEvent({
      feature: "payment",
      action: "checkout_create",
      status: "error",
      properties: {
        tier,
        duration_ms: Date.now() - started,
        error_name: error instanceof Error ? error.name : "Unknown",
      },
    });

    // Check for missing Stripe key
    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json(
        { error: "Payment processing is not configured. Please contact support." },
        { status: 503 }
      );
    }

    const message =
      error instanceof Error ? error.message : "Failed to create checkout session";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
