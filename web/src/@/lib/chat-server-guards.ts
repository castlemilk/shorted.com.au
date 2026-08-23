import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "~/server/auth";
import {
  getSubscriptionStatus,
  type SubscriptionInfo,
} from "~/app/actions/subscription";
import { rateLimit, type RateLimitConfig } from "@/lib/rate-limit";
import { recordProductEvent } from "@/lib/product-events";
import { routeGroupFromPath } from "@/lib/analytics-events";

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
  "authorization",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "x-user-id",
  "x-user-email",
  "x-internal-secret",
]);

const DEFAULT_SENDS_PER_MINUTE = 4;
const DEFAULT_SENDS_PER_DAY = 40;
const DEFAULT_SENDS_PER_MONTH = 600;
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
  chatServiceBaseURL: string;
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

  const originResponse = enforceSameOriginChatRequest(request, process.env);
  if (originResponse) {
    return { ok: false, response: originResponse };
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

  const chatServiceBaseURL = resolveChatServiceBaseURLConfig(process.env);
  if (!chatServiceBaseURL.ok) {
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
      chatServiceBaseURL: chatServiceBaseURL.value,
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

/**
 * Which window a chat bucket enforces, in the `product_event` vocabulary.
 *
 * Chat is the one web surface with buckets that are neither per-minute nor
 * monthly — sends are additionally capped per *day*. Mapping that to
 * `per_minute` would be a lie and mapping it to `unknown` would throw away the
 * only interesting thing about it, so `limit_kind` carries `daily` too (closed
 * value set; see LIMIT_KINDS in product-events.ts).
 */
export function limitKindForBucket(windowSeconds: number): string {
  if (windowSeconds <= 60) return "per_minute";
  if (windowSeconds <= 86_400) return "daily";
  return "monthly";
}

/**
 * Chat methods as `product_event` actions.
 *
 * Mapped through a closed set rather than normalising the raw method string:
 * this function is reachable with an arbitrary `method` from the proxy route,
 * and an unbounded `action` label is a cardinality hole in the metric.
 */
export function chatActionForMethod(method: string): string {
  return ALLOWED_CHAT_METHODS.has(method) ? method.toLowerCase() : "other";
}

/** First-segment route group for the request, defensively. */
function chatRouteGroup(request: NextRequest): string {
  try {
    return routeGroupFromPath(new URL(request.url).pathname);
  } catch {
    return "/other";
  }
}

export async function enforceChatRateLimits(
  request: NextRequest,
  method: string,
): Promise<NextResponse | undefined> {
  const configs = chatRateLimitConfigs(method, process.env);
  for (const config of configs) {
    const result = await rateLimit(request, config);
    if (!result.success) {
      // Chat is entitlement-gated, so a 429 here is always a *paying* user
      // being told no — the single most important rate-limit signal we have,
      // and until now it was returned with no telemetry at all.
      recordProductEvent({
        feature: "chat",
        action: chatActionForMethod(method),
        status: "rate_limited",
        properties: {
          // Two entry routes proxy to the same guard (`/api/chat` and
          // `/chat.v1.ChatService/[method]`), so the group is derived rather
          // than hard-coded — it is still a first-segment group, never a path.
          route_group: chatRouteGroup(request),
          limit_kind: limitKindForBucket(config.windowSeconds),
          tier: result.tier,
        },
      });
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
        bucketName: "chat-send-minute",
        anonymousLimit: 0,
        authenticatedLimit: positiveIntEnv(
          env.CHAT_SENDS_PER_MINUTE,
          DEFAULT_SENDS_PER_MINUTE,
        ),
        windowSeconds: 60,
      },
      {
        bucketName: "chat-send-day",
        anonymousLimit: 0,
        authenticatedLimit: positiveIntEnv(
          env.CHAT_SENDS_PER_DAY,
          DEFAULT_SENDS_PER_DAY,
        ),
        windowSeconds: 86_400,
      },
      {
        bucketName: "chat-send-month",
        anonymousLimit: 0,
        authenticatedLimit: positiveIntEnv(
          env.CHAT_SENDS_PER_MONTH,
          DEFAULT_SENDS_PER_MONTH,
        ),
        windowSeconds: 2_592_000,
      },
    ];
  }

  return [
    {
      bucketName: "chat-read-minute",
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
  const result = resolveChatServiceBaseURLConfig(env);
  if (result.ok) {
    return result.value;
  }
  throw new Error("CHAT_SERVICE_INTERNAL_URL is required in production");
}

export function resolveChatServiceBaseURLConfig(
  env: NodeJS.ProcessEnv,
): { ok: true; value: string } | { ok: false } {
  const internalURL = firstNonEmpty(env.CHAT_SERVICE_INTERNAL_URL);
  if (internalURL) {
    return { ok: true, value: internalURL.replace(/\/+$/, "") };
  }
  if (isProductionEnvironment(env)) {
    return { ok: false };
  }
  const value =
    firstNonEmpty(
      env.NEXT_PUBLIC_CHAT_SERVICE_ENDPOINT,
    ) ??
    "http://localhost:8080";
  return { ok: true, value: value.replace(/\/+$/, "") };
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

function enforceSameOriginChatRequest(
  request: NextRequest,
  env: NodeJS.ProcessEnv,
): NextResponse | undefined {
  const requestOrigin = new URL(request.url).origin;
  const allowedOrigins = new Set([
    requestOrigin,
    ...configuredAllowedOrigins(env),
  ]);

  const origin = normalizeOrigin(request.headers.get("origin"));
  if (origin) {
    return allowedOrigins.has(origin) ? undefined : forbiddenOriginResponse();
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return allowedOrigins.has(new URL(referer).origin)
        ? undefined
        : forbiddenOriginResponse();
    } catch {
      return forbiddenOriginResponse();
    }
  }

  return isProductionEnvironment(env) ? forbiddenOriginResponse() : undefined;
}

function configuredAllowedOrigins(env: NodeJS.ProcessEnv): string[] {
  return [
    "https://shorted.com.au",
    "https://www.shorted.com.au",
    env.NEXTAUTH_URL,
    csvValues(env.CHAT_ALLOWED_ORIGINS),
  ]
    .flat()
    .map((value) => normalizeOrigin(value))
    .filter((value): value is string => Boolean(value));
}

function csvValues(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function forbiddenOriginResponse(): NextResponse {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

function normalizeOrigin(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function isProductionEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
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
