import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
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
 * Sends a customer who already pays to the Stripe billing portal, on a
 * subscription-update flow for the subscription they have. The plan change then
 * happens in Stripe's own UI, so no second subscription is ever created here.
 *
 * Returns the portal URL in the same `url` field a checkout session uses, so the
 * client redirects the same way. If the portal session cannot be created the
 * customer gets a 409 that says what to do, never a silent dead end.
 *
 * Needs the Stripe customer portal to allow subscription updates, a dashboard
 * setting the repo does not manage. The PR that added this route lists it.
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
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${baseUrl}/pricing`,
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
    console.error("Stripe portal plan switch failed:", error);
    recordProductEvent({
      feature: "payment",
      action: "checkout_create",
      status: "error",
      properties: { tier, error_type: "already_subscribed" },
    });
    return NextResponse.json(
      {
        error: "already_subscribed",
        message:
          "You already have a Shorted subscription. Contact support to change it.",
      },
      { status: 409 }
    );
  }
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

    // Check for existing Stripe customer
    const existingCustomers = await stripe.customers.list({
      email: session.user.email,
      limit: 1,
    });

    let customerId: string | undefined;
    const firstCustomer = existingCustomers.data[0];
    if (firstCustomer) {
      customerId = firstCustomer.id;
    }

    // Two places can say a customer already pays: the Stripe customer matched by
    // this email, and the customer id on the user's own mirror row. The mirror
    // catches a customer whose Stripe email differs from the session email.
    const mirror = await getSubscriptionStatus();
    if (mirror.lookupFailed) {
      // Continue with the Stripe-side check alone. The email-matched customer
      // above already catches almost every second subscription; the mirror only
      // adds a customer whose Stripe email differs from the session email.
      // Refusing here would turn every billing-backend blip into lost sales from
      // new customers, which is the more common and costlier failure.
      console.warn(
        "[checkout] subscription mirror unavailable; checking Stripe customer only",
      );
    }

    const existingCustomerIds = [
      ...new Set(
        [customerId, mirror.lookupFailed ? undefined : mirror.stripeCustomerId].filter(
          (id): id is string => Boolean(id)
        )
      ),
    ];
    for (const existingCustomerId of existingCustomerIds) {
      // Checkout does not stop a second live subscription on its own, and a second
      // one is a second charge the customer did not ask for. So a customer who
      // already pays is never sent a new session. They are sent to the billing
      // portal to change the plan they have.
      const liveSubscriptions = (await listCustomerSubscriptions(existingCustomerId)).filter(
        (subscription) => isLiveStripeStatus(subscription.status),
      );
      const current = pickBestSubscription(liveSubscriptions);
      if (current) {
        return planSwitchResponse({
          customerId: existingCustomerId,
          subscriptionId: current.id,
          tier,
        });
      }
    }

    // Determine the base URL for redirects
    const baseUrl = process.env.NEXTAUTH_URL ?? "https://shorted.com.au";

    // Create Stripe checkout session
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer: customerId,
      customer_email: customerId ? undefined : session.user.email,
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
