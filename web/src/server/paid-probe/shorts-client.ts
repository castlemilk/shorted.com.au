import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import type { SubscriptionInfo } from "~/app/actions/subscription";
import {
  BillingService,
  SubscriptionStatus as ProtoSubscriptionStatus,
  SubscriptionTier as ProtoSubscriptionTier,
} from "~/gen/shorts/v1alpha1/billing_pb";
import {
  canMintApiTokensForTier,
  isPremiumTier,
  SUBSCRIPTION_TIERS,
  type SubscriptionStatus,
  type SubscriptionTier,
} from "~/lib/stripe";

import { PAID_PROBE_EMAIL, PAID_PROBE_USER_ID } from "./constants";
import { ProbeFailure, type ProbeContext } from "./types";
import { isEntitledSubscription } from "~/lib/subscription-entitlement";

/**
 * Connect calls to the Go API as the probe identity.
 *
 * subscription.ts and mintToken.ts hold the same wiring, but both are being
 * edited on other branches and neither exports the mapping, so the probe owns a
 * copy. Keep the status and tier mapping in step with subscription.ts.
 */

function requireInternalSecret(ctx: ProbeContext): string {
  if (!ctx.internalSecret) {
    // subscription.ts falls back to a dev secret when the variable is unset. The
    // probe fails closed instead, so a missing prod variable shows up as the
    // probe's own failure, not as a confusing 401 from the Go API.
    throw new ProbeFailure("INTERNAL_SERVICE_SECRET is not configured");
  }
  return ctx.internalSecret;
}

function internalTransport(ctx: ProbeContext, secret: string) {
  return createConnectTransport({
    fetch: ctx.fetch,
    baseUrl: ctx.shortsApiUrl,
    interceptors: [
      (next) => async (req) => {
        req.header.set("x-internal-secret", secret);
        req.header.set("x-user-id", PAID_PROBE_USER_ID);
        req.header.set("x-user-email", PAID_PROBE_EMAIL);
        return await next(req);
      },
    ],
  });
}

/** The fields of GetMySubscriptionResponse the mapping reads. */
export interface MySubscriptionFields {
  hasSubscription: boolean;
  status: ProtoSubscriptionStatus;
  tier: ProtoSubscriptionTier;
  currentPeriodEnd?: { seconds: bigint; nanos: number };
  pastDueSince?: { seconds: bigint; nanos: number };
  cancelAtPeriodEnd?: boolean;
}

export async function getMySubscription(
  ctx: ProbeContext,
  signal: AbortSignal,
): Promise<SubscriptionInfo> {
  const client = createClient(
    BillingService,
    internalTransport(ctx, requireInternalSecret(ctx)),
  );
  const response = await client.getMySubscription({}, { signal });
  return toSubscriptionInfo(response);
}

export async function mintApiToken(
  ctx: ProbeContext,
  signal: AbortSignal,
): Promise<string> {
  const client = createClient(
    BillingService,
    internalTransport(ctx, requireInternalSecret(ctx)),
  );
  const response = await client.mintToken({}, { signal });
  return response.token;
}

/**
 * Map the proto response to the SubscriptionInfo shape the chat guard reads,
 * the same way subscription.ts does. Exported so the mapping has a unit test.
 */
export function toSubscriptionInfo(fields: MySubscriptionFields): SubscriptionInfo {
  if (!fields.hasSubscription) {
    return freeSubscription();
  }

  const status = mapStatus(fields.status);
  const tier = mapTier(fields.tier);
  const tierConfig = SUBSCRIPTION_TIERS[tier] ?? SUBSCRIPTION_TIERS.free;

  let currentPeriodEnd: Date | null = null;
  if (fields.currentPeriodEnd) {
    currentPeriodEnd = new Date(
      Number(fields.currentPeriodEnd.seconds) * 1000 +
        Math.floor((fields.currentPeriodEnd.nanos ?? 0) / 1_000_000),
    );
  }

  const pastDueSince = fields.pastDueSince
    ? new Date(
        Number(fields.pastDueSince.seconds) * 1000 +
          Math.floor((fields.pastDueSince.nanos ?? 0) / 1_000_000),
      )
    : null;
  const hasActiveSubscription = isEntitledSubscription({ status, pastDueSince });
  return {
    status,
    tier,
    hasActiveSubscription,
    isPremium: hasActiveSubscription && isPremiumTier(tier),
    canMintTokens: hasActiveSubscription && canMintApiTokensForTier(tier),
    currentPeriodEnd,
    pastDueSince,
    cancelAtPeriodEnd: fields.cancelAtPeriodEnd ?? false,
    features: tierConfig.features,
    requestsPerDay: tierConfig.requestsPerDay,
  };
}

function freeSubscription(): SubscriptionInfo {
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

function mapStatus(status: ProtoSubscriptionStatus): SubscriptionStatus {
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

function mapTier(tier: ProtoSubscriptionTier): SubscriptionTier {
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
