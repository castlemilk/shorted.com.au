import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "~/server/auth";
import {
  getSubscriptionStatus,
  type SubscriptionInfo,
} from "~/app/actions/subscription";
import { rateLimit, type RateLimitConfig } from "@/lib/rate-limit";

export const ALLOWED_CHAT_METHODS = new Set([
  "SendMessage",
  "GetConversationHistory",
  "ListConversations",
  "DeleteConversation",
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "x-user-id",
  "x-user-email",
  "x-internal-secret",
]);

const DEFAULT_SENDS_PER_MINUTE = 4;
const DEFAULT_SENDS_PER_DAY = 40;
const DEFAULT_READS_PER_MINUTE = 60;
const VALID_CHAT_STATUSES = new Set<SubscriptionInfo["status"]>([
  "active",
  "trialing",
]);
const VALID_CHAT_TIERS = new Set<SubscriptionInfo["tier"]>([
  "premium",
  "pro",
  "enterprise",
]);

export interface AuthorizedChatRequest {
  userID: string;
  userEmail: string;
  internalSecret: string;
}

export async function authorizeChatRequest(
  request: NextRequest,
  method: string,
): Promise<
  | {
      ok: true;
      value: AuthorizedChatRequest;
    }
  | {
      ok: false;
      response: NextResponse;
    }
> {
  const session = await auth();
  const userID = session?.user?.id;
  if (!userID) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      ),
    };
  }

  let subscription: SubscriptionInfo;
  try {
    subscription = await getSubscriptionStatus();
  } catch {
    return { ok: false, response: premiumRequiredResponse() };
  }

  if (!hasValidChatEntitlement(subscription)) {
    return { ok: false, response: premiumRequiredResponse() };
  }

  const rateLimitResponse = await enforceChatRateLimits(request, method);
  if (rateLimitResponse) {
    return { ok: false, response: rateLimitResponse };
  }

  const internalSecret = resolveInternalSecret(process.env);
  if (!internalSecret.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Chat unavailable",
          message: "Chat is temporarily unavailable.",
        },
        {
          status: 503,
          headers: { "Retry-After": "60" },
        },
      ),
    };
  }

  return {
    ok: true,
    value: {
      userID,
      userEmail: session.user.email ?? "",
      internalSecret: internalSecret.value,
    },
  };
}

export function hasValidChatEntitlement(
  subscription: SubscriptionInfo | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!subscription) {
    return false;
  }
  if (!subscription.hasActiveSubscription || !subscription.isPremium) {
    return false;
  }
  if (!VALID_CHAT_STATUSES.has(subscription.status)) {
    return false;
  }
  if (!VALID_CHAT_TIERS.has(subscription.tier)) {
    return false;
  }
  if (
    subscription.currentPeriodEnd &&
    subscription.currentPeriodEnd.getTime() <= now.getTime()
  ) {
    return false;
  }
  return true;
}

export function premiumRequiredResponse(): NextResponse {
  return NextResponse.json(
    { error: "Premium subscription required" },
    { status: 403 },
  );
}

export async function enforceChatRateLimits(
  request: NextRequest,
  method: string,
): Promise<NextResponse | undefined> {
  const configs = chatRateLimitConfigs(method, process.env);
  for (const config of configs) {
    const result = await rateLimit(request, config);
    if (!result.success) {
      return result.response;
    }
  }
  return undefined;
}

export function chatRateLimitConfigs(
  method: string,
  env: NodeJS.ProcessEnv,
): RateLimitConfig[] {
  if (method === "SendMessage") {
    return [
      {
        anonymousLimit: 0,
        authenticatedLimit: positiveIntEnv(
          env.CHAT_SENDS_PER_MINUTE,
          DEFAULT_SENDS_PER_MINUTE,
        ),
        windowSeconds: 60,
      },
      {
        anonymousLimit: 0,
        authenticatedLimit: positiveIntEnv(
          env.CHAT_SENDS_PER_DAY,
          DEFAULT_SENDS_PER_DAY,
        ),
        windowSeconds: 86_400,
      },
    ];
  }

  return [
    {
      anonymousLimit: 0,
      authenticatedLimit: positiveIntEnv(
        env.CHAT_READS_PER_MINUTE,
        DEFAULT_READS_PER_MINUTE,
      ),
      windowSeconds: 60,
    },
  ];
}

export function resolveInternalSecret(
  env: NodeJS.ProcessEnv,
): { ok: true; value: string } | { ok: false } {
  const value = env.INTERNAL_SERVICE_SECRET?.trim();
  if (value) {
    return { ok: true, value };
  }
  if (env.NODE_ENV === "production" || env.VERCEL_ENV === "production") {
    return { ok: false };
  }
  return { ok: true, value: "" };
}

export function resolveChatServiceBaseURL(env: NodeJS.ProcessEnv): string {
  const value =
    firstNonEmpty(
      env.CHAT_SERVICE_INTERNAL_URL,
      env.NEXT_PUBLIC_CHAT_SERVICE_ENDPOINT,
    ) ??
    (env.NODE_ENV === "production"
      ? "https://api.shorted.com.au"
      : "http://localhost:8080");
  return value.replace(/\/+$/, "");
}

export function buildUpstreamHeaders(
  source: Headers,
  trusted: {
    internalSecret: string;
    userID: string;
    userEmail: string;
  },
): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  if (trusted.internalSecret) {
    headers.set("x-internal-secret", trusted.internalSecret);
  }
  headers.set("x-user-id", trusted.userID);
  if (trusted.userEmail) {
    headers.set("x-user-email", trusted.userEmail);
  }
  return headers;
}

export function filterResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return headers;
}

function positiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
