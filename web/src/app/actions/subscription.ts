"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { BillingService } from "~/gen/shorts/v1alpha1/billing_pb";
import { SubscriptionStatus as ProtoSubscriptionStatus, SubscriptionTier as ProtoSubscriptionTier } from "~/gen/shorts/v1alpha1/billing_pb";
import { auth } from "~/server/auth";
import {
  SUBSCRIPTION_TIERS,
  canMintApiTokensForTier,
  isPremiumTier,
  type SubscriptionStatus,
  type SubscriptionTier,
} from "~/lib/stripe";
import type { CheckoutTier } from "~/lib/stripe-plans";
import { retryWithBackoff, type RetryOptions } from "@/lib/retry";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { isEntitledSubscription } from "~/lib/subscription-entitlement";
import { timestampToDate } from "~/@/lib/proto-time";

// Internal auth secret for service-to-service calls
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

/**
 * Creates a transport with auth headers for the given user
 */
function createAuthTransport(userId: string, userEmail: string) {
  return createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
    interceptors: [
      (next) => async (req) => {
        req.header.set("x-internal-secret", INTERNAL_SECRET);
        req.header.set("x-user-id", userId);
        req.header.set("x-user-email", userEmail);
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
  isPremium: boolean;
  canMintTokens: boolean;
  currentPeriodEnd: Date | null;
  /** When the current past-due run's first failed charge happened, or null. Starts the grace. */
  pastDueSince: Date | null;
  cancelAtPeriodEnd: boolean;
  features: readonly string[];
  requestsPerDay: number;
  stripeCustomerId?: string;
  /**
   * True when the backend could not be asked (transport or backend error). The
   * answer is then unknown, not "free": a paying user must not be told they are
   * not Premium because of a blip. Absent or false on every real answer,
   * including a genuine "no subscription".
   */
  lookupFailed?: boolean;
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
    case ProtoSubscriptionStatus.UNPAID:
      return "unpaid";
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
    case ProtoSubscriptionTier.PREMIUM:
      return "premium";
    case ProtoSubscriptionTier.PRO:
      return "pro";
    case ProtoSubscriptionTier.ENTERPRISE:
      return "enterprise";
    case ProtoSubscriptionTier.API_ACCESS:
      return "api_access";
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
      isPremium: false,
      canMintTokens: false,
      currentPeriodEnd: null,
      pastDueSince: null,
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
    const client = createClient(BillingService, transport);

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
        isPremium: false,
        canMintTokens: false,
        currentPeriodEnd: null,
        pastDueSince: null,
        cancelAtPeriodEnd: false,
        features: SUBSCRIPTION_TIERS.free.features,
        requestsPerDay: SUBSCRIPTION_TIERS.free.requestsPerDay,
      };
    }

    const status = mapProtoStatusToString(response.status);
    const tier = mapProtoTierToString(response.tier);
    const tierConfig = SUBSCRIPTION_TIERS[tier] ?? SUBSCRIPTION_TIERS.free;

    // Parse timestamp to Date
    let currentPeriodEnd: Date | null = null;
    if (response.currentPeriodEnd) {
      currentPeriodEnd = new Date(
        Number(response.currentPeriodEnd.seconds) * 1000 +
        Math.floor((response.currentPeriodEnd.nanos ?? 0) / 1_000_000)
      );
    }

    const pastDueSince = timestampToDate(response.pastDueSince);
    const hasActiveSubscription = isEntitledSubscription({ status, pastDueSince });

    return {
      status,
      tier,
      hasActiveSubscription,
      isPremium: hasActiveSubscription && isPremiumTier(tier),
      canMintTokens: hasActiveSubscription && canMintApiTokensForTier(tier),
      currentPeriodEnd,
      pastDueSince,
      cancelAtPeriodEnd: response.cancelAtPeriodEnd,
      features: tierConfig.features,
      requestsPerDay: tierConfig.requestsPerDay,
      stripeCustomerId: response.stripeCustomerId || undefined,
    };
  } catch (error) {
    // Fall back to free tier on error, but say so: the caller must not treat
    // this as a confirmed "no subscription".
    return {
      status: "inactive",
      tier: "free",
      hasActiveSubscription: false,
      isPremium: false,
      canMintTokens: false,
      currentPeriodEnd: null,
      pastDueSince: null,
      cancelAtPeriodEnd: false,
      features: SUBSCRIPTION_TIERS.free.features,
      requestsPerDay: SUBSCRIPTION_TIERS.free.requestsPerDay,
      lookupFailed: true,
    };
  }
}

/**
 * Create a checkout session and redirect to Stripe
 */
export async function createCheckoutSession(
  tier: CheckoutTier = "premium",
): Promise<{ url: string | null; error?: string }> {
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
      body: JSON.stringify({ tier }),
    });

    // `message` is the readable text (the 409 "already subscribed" case);
    // `error` is the machine code and is only a fallback.
    const data = await response.json() as { url?: string; error?: string; message?: string };

    if (!response.ok) {
      return { url: null, error: data.message ?? data.error ?? "Failed to create checkout session" };
    }

    return { url: data.url ?? null };
  } catch (error) {
    return { url: null, error: "Failed to create checkout session" };
  }
}

