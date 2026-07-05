import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import type Stripe from "stripe";
import { stripe } from "~/lib/stripe";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { SubscriptionStatus, SubscriptionTier } from "~/gen/shorts/v1alpha1/shorts_pb";
import { retryWithBackoff, type RetryOptions } from "@/lib/retry";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { recordProductEvent } from "~/@/lib/product-events";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "~/app/actions/config";

// Internal auth secret for service-to-service calls
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

// Create transport for gRPC calls with internal auth headers
const transport = createConnectTransport({
  fetch: serverFetchWithUserAgent,
  baseUrl: SHORTS_API_URL,
  // Add internal auth headers for webhook -> backend calls
  // Use lowercase header names for HTTP/2 compatibility
  interceptors: [
    (next) => async (req) => {
      req.header.set("x-internal-secret", INTERNAL_SECRET);
      req.header.set("x-user-id", "stripe-webhook");
      req.header.set("x-user-email", "webhook@shorted.com.au");
      return await next(req);
    },
  ],
});

// Create gRPC client
const client = createClient(ShortedStocksService, transport);

// Webhook secret for verifying Stripe signatures
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Retry configuration for backend calls
const WEBHOOK_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  shouldRetry: (error: unknown) => {
    // Retry on network errors and transient failures
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (
        message.includes("network") ||
        message.includes("timeout") ||
        message.includes("econnrefused") ||
        message.includes("econnreset") ||
        message.includes("socket") ||
        message.includes("unavailable")
      ) {
        return true;
      }
    }
    return true; // Default: retry on unknown errors
  },
};

export async function POST(request: NextRequest) {
  const started = Date.now();

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set");
    recordProductEvent({
      feature: "payment",
      action: "webhook_process",
      status: "error",
      properties: { error_type: "webhook_secret_missing" },
    });
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  const body = await request.text();
  const headersList = headers();
  const signature = headersList.get("stripe-signature");

  if (!signature) {
    recordProductEvent({
      feature: "payment",
      action: "webhook_process",
      status: "error",
      properties: { error_type: "missing_signature" },
    });
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Webhook signature verification failed: ${message}`);
    recordProductEvent({
      feature: "payment",
      action: "webhook_process",
      status: "error",
      properties: { error_type: "signature_verification_failed" },
    });
    return NextResponse.json(
      { error: `Webhook Error: ${message}` },
      { status: 400 }
    );
  }

  try {
    recordProductEvent({
      feature: "payment",
      action: "webhook_process",
      status: "attempt",
      properties: { event_type: normalizeStripeEventType(event.type) },
    });

    switch (event.type) {
      case "checkout.session.completed": {
        await handleCheckoutCompleted(event.data.object);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        await handleSubscriptionUpdate(event.data.object, false);
        break;
      }

      case "customer.subscription.deleted": {
        await handleSubscriptionUpdate(event.data.object, true);
        break;
      }

      case "invoice.payment_succeeded": {
        await handlePaymentSucceeded(event.data.object);
        break;
      }

      case "invoice.payment_failed": {
        await handlePaymentFailed(event.data.object);
        break;
      }

      default:
        // Unhandled event type - ignore
    }

    recordProductEvent({
      feature: "payment",
      action: "webhook_process",
      status: "success",
      properties: {
        event_type: normalizeStripeEventType(event.type),
        duration_ms: Date.now() - started,
      },
    });

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Error processing webhook:", error);
    recordProductEvent({
      feature: "payment",
      action: "webhook_process",
      status: "error",
      properties: {
        event_type: normalizeStripeEventType(event.type),
        duration_ms: Date.now() - started,
        error_name: error instanceof Error ? error.name : "Unknown",
      },
    });
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
}

function normalizeStripeEventType(type: string): string {
  return type.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_");
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId ?? session.client_reference_id;
  const userEmail = session.metadata?.userEmail ?? session.customer_email;
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;

  if (!userId || !userEmail) {
    console.error("Missing user information in checkout session");
    return;
  }

  // Call backend API with retry
  await retryWithBackoff(
    async () => {
      return await client.handleStripeCheckoutCompleted({
        userId,
        userEmail,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        tier: SubscriptionTier.PREMIUM,
      });
    },
    WEBHOOK_RETRY_OPTIONS
  );
}

async function handleSubscriptionUpdate(subscription: Stripe.Subscription, isDeleted: boolean) {
  const customerId = subscription.customer as string;

  // Map Stripe status to our status enum
  const statusMap: Record<string, SubscriptionStatus> = {
    active: SubscriptionStatus.ACTIVE,
    trialing: SubscriptionStatus.TRIALING,
    past_due: SubscriptionStatus.PAST_DUE,
    canceled: SubscriptionStatus.CANCELED,
    unpaid: SubscriptionStatus.PAST_DUE,
    incomplete: SubscriptionStatus.INACTIVE,
    incomplete_expired: SubscriptionStatus.INACTIVE,
    paused: SubscriptionStatus.INACTIVE,
  };

  const status = statusMap[subscription.status] ?? SubscriptionStatus.INACTIVE;
  const cancelAtPeriodEnd = subscription.cancel_at_period_end;

  // Access period dates - they may be on the subscription or items
  const periodStartUnix = subscription.items?.data[0]?.current_period_start;
  const periodEndUnix = subscription.items?.data[0]?.current_period_end;

  // Call backend API with retry
  await retryWithBackoff(
    async () => {
      return await client.handleStripeSubscriptionUpdated({
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        status,
        tier: SubscriptionTier.PREMIUM,
        currentPeriodStart: periodStartUnix
          ? timestampFromDate(new Date(periodStartUnix * 1000))
          : undefined,
        currentPeriodEnd: periodEndUnix
          ? timestampFromDate(new Date(periodEndUnix * 1000))
          : undefined,
        cancelAtPeriodEnd,
        isDeleted,
      });
    },
    WEBHOOK_RETRY_OPTIONS
  );
}

async function handlePaymentSucceeded(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;

  // Mark subscription as active after successful payment
  await retryWithBackoff(
    async () => {
      return await client.handleStripeSubscriptionUpdated({
        stripeCustomerId: customerId,
        stripeSubscriptionId: "",
        status: SubscriptionStatus.ACTIVE,
        tier: SubscriptionTier.UNSPECIFIED,
        cancelAtPeriodEnd: false,
        isDeleted: false,
      });
    },
    WEBHOOK_RETRY_OPTIONS
  );
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;

  // Mark subscription as past_due
  await retryWithBackoff(
    async () => {
      return await client.handleStripeSubscriptionUpdated({
        stripeCustomerId: customerId,
        stripeSubscriptionId: "",
        status: SubscriptionStatus.PAST_DUE,
        tier: SubscriptionTier.UNSPECIFIED,
        cancelAtPeriodEnd: false,
        isDeleted: false,
      });
    },
    WEBHOOK_RETRY_OPTIONS
  );
}
