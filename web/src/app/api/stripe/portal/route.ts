import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { stripe } from "~/lib/stripe";
import { auth } from "~/server/auth";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { BillingService } from "~/gen/shorts/v1alpha1/billing_pb";
import { rateLimit } from "~/@/lib/rate-limit";
import { recordProductEvent } from "~/@/lib/product-events";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "~/app/actions/config";

// Create transport and client for gRPC calls
const transport = createConnectTransport({
  fetch: serverFetchWithUserAgent,
  baseUrl: SHORTS_API_URL,
});
const client = createClient(BillingService, transport);

export async function POST(request: NextRequest) {
  const started = Date.now();

  try {
    const session = await auth();

    if (!session?.user?.email || !session?.user?.id) {
      recordProductEvent({
        feature: "payment",
        action: "portal_create",
        status: "unauthenticated",
      });
      return NextResponse.json(
        { error: "You must be signed in" },
        { status: 401 }
      );
    }

    recordProductEvent({
      feature: "payment",
      action: "portal_create",
      status: "attempt",
    });

    const rateLimitResult = await rateLimit(request, {
      anonymousLimit: 2,
      authenticatedLimit: 12,
      windowSeconds: 60,
    });
    if (!rateLimitResult.success) {
      recordProductEvent({
        feature: "payment",
        action: "portal_create",
        status: "rate_limited",
        properties: {
          tier: rateLimitResult.tier,
          limit_kind: "per_minute",
          route_group: "/api/stripe/*",
        },
      });
      return rateLimitResult.response;
    }

    // Get the user's Stripe customer ID via gRPC
    const internalSecret =
      process.env.INTERNAL_SERVICE_SECRET ?? process.env.INTERNAL_SECRET;
    if (!internalSecret && process.env.NODE_ENV === "production") {
      recordProductEvent({
        feature: "payment",
        action: "portal_create",
        status: "error",
        properties: { error_type: "internal_secret_missing" },
      });
      return NextResponse.json(
        { error: "Portal service is not configured" },
        { status: 500 },
      );
    }
    
    const subscriptionResponse = await client.getMySubscription(
      {},
      {
        headers: {
          "x-user-id": session.user.id,
          "x-user-email": session.user.email,
          "x-internal-secret": internalSecret ?? "dev-internal-secret",
        },
      }
    );

    if (!subscriptionResponse.hasSubscription || !subscriptionResponse.stripeCustomerId) {
      return NextResponse.json(
        { error: "No subscription found" },
        { status: 404 }
      );
    }

    const customerId = subscriptionResponse.stripeCustomerId;
    const baseUrl = process.env.NEXTAUTH_URL ?? "https://shorted.com.au";

    // Create customer portal session
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${baseUrl}/docs/api`,
    });

    recordProductEvent({
      feature: "payment",
      action: "portal_create",
      status: "success",
      properties: { duration_ms: Date.now() - started },
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (error) {
    console.error("Portal session error:", error);
    recordProductEvent({
      feature: "payment",
      action: "portal_create",
      status: "error",
      properties: {
        duration_ms: Date.now() - started,
        error_name: error instanceof Error ? error.name : "Unknown",
      },
    });
    return NextResponse.json(
      { error: "Failed to create portal session" },
      { status: 500 }
    );
  }
}
