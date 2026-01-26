"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { SubscriptionStatus as ProtoSubscriptionStatus, SubscriptionTier as ProtoSubscriptionTier } from "~/gen/shorts/v1alpha1/shorts_pb";
import { auth } from "~/server/auth";
import { SUBSCRIPTION_TIERS, type SubscriptionStatus, type SubscriptionTier } from "~/lib/stripe";
import { retryWithBackoff, type RetryOptions } from "@/lib/retry";

// Shorts API URL - falls back to local dev if not set
const SHORTS_API_URL = process.env.SHORTS_SERVICE_ENDPOINT ?? "http://localhost:9091";

// Internal auth secret for service-to-service calls
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

/**
 * Creates a transport with auth headers for the given user
 */
function createAuthTransport(userId: string, userEmail: string) {
  console.log(`[subscription.ts] Creating transport with auth for user: ${userId}, email: ${userEmail}`);
  console.log(`[subscription.ts] Using internal secret: ${INTERNAL_SECRET.substring(0, 8)}...`);
  
  return createConnectTransport({
    baseUrl: SHORTS_API_URL,
    // Add internal auth headers for server action -> backend calls
    // Use lowercase header names for HTTP/2 compatibility
    interceptors: [
      (next) => async (req) => {
        console.log(`[subscription.ts] Interceptor called - setting headers`);
        req.header.set("x-internal-secret", INTERNAL_SECRET);
        req.header.set("x-user-id", userId);
        req.header.set("x-user-email", userEmail);
        console.log(`[subscription.ts] Headers set: x-internal-secret=${INTERNAL_SECRET.substring(0, 8)}..., x-user-id=${userId}`);
        return await next(req);
      },
    ],
  });
}

// Retry configuration
const RETRY_OPTIONS: RetryOptions = {
  maxRetries: 2,
  initialDelayMs: 200,
  maxDelayMs: 2000,
  backoffMultiplier: 2,
};

export interface SubscriptionInfo {
  status: SubscriptionStatus;
  tier: SubscriptionTier;
  hasActiveSubscription: boolean;
  canMintTokens: boolean;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  features: readonly string[];
  requestsPerDay: number;
  stripeCustomerId?: string;
}

/**
 * Map protobuf status enum to string
 */
function mapProtoStatusToString(status: ProtoSubscriptionStatus): SubscriptionStatus {
  switch (status) {
    case ProtoSubscriptionStatus.ACTIVE:
      return "active";
    case ProtoSubscriptionStatus.TRIALING:
      return "trialing";
    case ProtoSubscriptionStatus.PAST_DUE:
      return "past_due";
    case ProtoSubscriptionStatus.CANCELED:
      return "canceled";
    case ProtoSubscriptionStatus.INACTIVE:
    default:
      return "inactive";
  }
}

/**
 * Map protobuf tier enum to string
 */
function mapProtoTierToString(tier: ProtoSubscriptionTier): SubscriptionTier {
  switch (tier) {
    case ProtoSubscriptionTier.PRO:
      return "pro";
    case ProtoSubscriptionTier.ENTERPRISE:
      return "enterprise";
    case ProtoSubscriptionTier.FREE:
    default:
      return "free";
  }
}

/**
 * Get the current user's subscription status via gRPC
 */
export async function getSubscriptionStatus(): Promise<SubscriptionInfo> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      status: "inactive",
      tier: "free",
      hasActiveSubscription: false,
      canMintTokens: false,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      features: SUBSCRIPTION_TIERS.free.features,
      requestsPerDay: SUBSCRIPTION_TIERS.free.requestsPerDay,
    };
  }

  try {
    // Create transport with auth headers for this user
    const transport = createAuthTransport(
      session.user.id,
      session.user.email ?? ""
    );
    const client = createClient(ShortedStocksService, transport);

    const response = await retryWithBackoff(
      async () => {
        return await client.getMySubscription({});
      },
      RETRY_OPTIONS
    );

    if (!response.hasSubscription) {
      return {
        status: "inactive",
        tier: "free",
        hasActiveSubscription: false,
        canMintTokens: false,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        features: SUBSCRIPTION_TIERS.free.features,
        requestsPerDay: SUBSCRIPTION_TIERS.free.requestsPerDay,
      };
    }

    const status = mapProtoStatusToString(response.status);
    const tier = mapProtoTierToString(response.tier);
    const hasActiveSubscription = status === "active" || status === "trialing";
    const tierConfig = SUBSCRIPTION_TIERS[tier] ?? SUBSCRIPTION_TIERS.free;

    // Parse timestamp to Date
    let currentPeriodEnd: Date | null = null;
    if (response.currentPeriodEnd) {
      currentPeriodEnd = new Date(
        Number(response.currentPeriodEnd.seconds) * 1000 +
        Math.floor((response.currentPeriodEnd.nanos ?? 0) / 1_000_000)
      );
    }

    return {
      status,
      tier,
      hasActiveSubscription,
      canMintTokens: hasActiveSubscription && tier !== "free",
      currentPeriodEnd,
      cancelAtPeriodEnd: response.cancelAtPeriodEnd,
      features: tierConfig.features,
      requestsPerDay: tierConfig.requestsPerDay,
      stripeCustomerId: response.stripeCustomerId || undefined,
    };
  } catch (error) {
    console.error("Error fetching subscription status via gRPC:", error);
    // Fall back to free tier on error
    return {
      status: "inactive",
      tier: "free",
      hasActiveSubscription: false,
      canMintTokens: false,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      features: SUBSCRIPTION_TIERS.free.features,
      requestsPerDay: SUBSCRIPTION_TIERS.free.requestsPerDay,
    };
  }
}

/**
 * Create a checkout session and redirect to Stripe
 */
export async function createCheckoutSession(priceId: string): Promise<{ url: string | null; error?: string }> {
  const session = await auth();

  if (!session?.user?.email) {
    return { url: null, error: "You must be signed in to subscribe" };
  }

  try {
    const baseUrl = process.env.NEXTAUTH_URL ?? "https://shorted.com.au";
    const response = await fetch(`${baseUrl}/api/stripe/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ priceId }),
    });

    const data = await response.json() as { url?: string; error?: string };

    if (!response.ok) {
      return { url: null, error: data.error ?? "Failed to create checkout session" };
    }

    return { url: data.url ?? null };
  } catch (error) {
    console.error("Checkout error:", error);
    return { url: null, error: "Failed to create checkout session" };
  }
}

/**
 * Create a customer portal session for managing subscription
 */
export async function createPortalSession(): Promise<{ url: string | null; error?: string }> {
  const session = await auth();

  if (!session?.user?.email) {
    return { url: null, error: "You must be signed in" };
  }

  try {
    const baseUrl = process.env.NEXTAUTH_URL ?? "https://shorted.com.au";
    const response = await fetch(`${baseUrl}/api/stripe/portal`, {
      method: "POST",
    });

    const data = await response.json() as { url?: string; error?: string };

    if (!response.ok) {
      return { url: null, error: data.error ?? "Failed to create portal session" };
    }

    return { url: data.url ?? null };
  } catch (error) {
    console.error("Portal error:", error);
    return { url: null, error: "Failed to create portal session" };
  }
}
