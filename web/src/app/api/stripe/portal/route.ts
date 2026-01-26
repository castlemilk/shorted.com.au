import { NextResponse } from "next/server";
import { stripe } from "~/lib/stripe";
import { auth } from "~/server/auth";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";

// Shorts API URL
const SHORTS_API_URL = process.env.SHORTS_SERVICE_ENDPOINT ?? "http://localhost:9091";

// Create transport and client for gRPC calls
const transport = createConnectTransport({
  baseUrl: SHORTS_API_URL,
});
const client = createClient(ShortedStocksService, transport);

export async function POST() {
  try {
    const session = await auth();

    if (!session?.user?.email || !session?.user?.id) {
      return NextResponse.json(
        { error: "You must be signed in" },
        { status: 401 }
      );
    }

    // Get the user's Stripe customer ID via gRPC
    const internalSecret = process.env.INTERNAL_SECRET ?? "dev-internal-secret";
    
    const subscriptionResponse = await client.getMySubscription(
      {},
      {
        headers: {
          "x-user-id": session.user.id,
          "x-user-email": session.user.email,
          "x-internal-secret": internalSecret,
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

    return NextResponse.json({ url: portalSession.url });
  } catch (error) {
    console.error("Portal session error:", error);
    return NextResponse.json(
      { error: "Failed to create portal session" },
      { status: 500 }
    );
  }
}
