import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { stripe } from "~/lib/stripe";
import { auth } from "~/server/auth";
import { rateLimit } from "~/@/lib/rate-limit";
import { recordProductEvent } from "~/@/lib/product-events";

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

    // Look up the price ID server-side (env var is not available to client components)
    const body = (await request.json().catch(() => ({}))) as { tier?: string };
    tier = body.tier ?? "premium";

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
        properties: { tier },
      });
      return rateLimitResult.response;
    }

    let priceId: string | null | undefined = null;
    if (tier === "premium") {
      priceId =
        process.env.STRIPE_PRO_PRICE_ID ??
        process.env.STRIPE_PREMIUM_PRICE_ID ??
        null;
    } else if (tier === "api_access") {
      priceId =
        process.env.STRIPE_API_ACCESS_PRICE_ID ??
        process.env.STRIPE_PRO_PRICE_ID ??
        process.env.STRIPE_PREMIUM_PRICE_ID ??
        null;
    }

    if (!priceId) {
      recordProductEvent({
        feature: "payment",
        action: "checkout_create",
        status: "error",
        properties: { tier, error_type: "price_not_configured" },
      });
      return NextResponse.json(
        { error: "Premium pricing not configured" },
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
      },
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/pricing?canceled=true`,
      subscription_data: {
        metadata: {
          userId: session.user.id,
          userEmail: session.user.email,
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
