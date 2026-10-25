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
import { isEntitledSubscription } from "~/lib/subscription-entitlement";
import type {
  ChatErrorBody,
  ChatErrorCode,
  ChatLimitKind,
} from "@/hooks/chat-ui-message-adapter";

/**
 * The longest message the chat service will accept, in characters. It mirrors
 * the chat service's CHAT_MAX_INPUT_CHARS default. Checked before any rate
 * limit token is spent, so an oversized message costs its sender nothing.
 */
export const CHAT_MAX_MESSAGE_CHARS = 2000;

/**
 * Connect's numeric codes, for the ones the chat contract tells apart. Connect
 * sends these as numbers over the stream and names them in JSON. The numbers
 * are used because this module must not import @connectrpc/connect.
 */
const CONNECT_INVALID_ARGUMENT = 3;
const CONNECT_NOT_FOUND = 5;
const CONNECT_PERMISSION_DENIED = 7;
/** The chat service's refusal for a limit. */
const CONNECT_RESOURCE_EXHAUSTED = 8;
const CONNECT_OUT_OF_RANGE = 11;
const CONNECT_UNAUTHENTICATED = 16;

/** The metadata key the chat service puts the limit under. */
export const CHAT_LIMIT_HEADER = "x-chat-limit";

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
  "x-user-roles",
  "x-internal-secret",
  // Vercel's deployment-protection bypass is a credential. A caller that sends
  // it to this route (the paid-feature probe does, to its own deployment) must
  // not have it passed on to the chat service, which is not that deployment.
  "x-vercel-protection-bypass",
  "x-vercel-set-bypass-cookie",
]);

/**
 * Response headers that describe the bytes as the chat service sent them. fetch
 * has already decoded that body by the time the proxy copies it on, so a
 * Content-Encoding copied across makes the caller decode it a second time, and
 * the caller fails with "TypeError: terminated" (cause Z_DATA_ERROR). Content-Length
 * is already in HOP_BY_HOP_HEADERS for the same reason.
 */
const ENCODED_BODY_HEADERS = new Set(["content-encoding"]);

const DEFAULT_SENDS_PER_MINUTE = 4;
const DEFAULT_SENDS_PER_DAY = 40;
const DEFAULT_SENDS_PER_MONTH = 600;
const DEFAULT_READS_PER_MINUTE = 60;
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
      response: chatErrorResponse(
        401,
        chatErrorBody(
          "unauthenticated",
          "Authentication required",
          "Sign in to use Shorted AI.",
        ),
      ),
    };
  }

  let subscription: SubscriptionInfo;
  try {
    subscription = await getSubscriptionStatus();
  } catch {
    return { ok: false, response: premiumRequiredResponse() };
  }

  // A failed lookup is not evidence the user is free. Answering 403 here told
  // paying customers they were not Premium during a backend blip, so say the
  // service is unavailable and let the client retry.
  if (subscription.lookupFailed) {
    return {
      ok: false,
      response: chatErrorResponse(
        503,
        chatErrorBody(
          "unavailable",
          "Chat unavailable",
          "Chat is temporarily unavailable. Please try again shortly.",
          { retryAfterSeconds: 30 },
        ),
        { "Retry-After": "30" },
      ),
    };
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
      response: chatUnavailableResponse(),
    };
  }

  const chatServiceBaseURL = resolveChatServiceBaseURLConfig(process.env);
  if (!chatServiceBaseURL.ok) {
    return {
      ok: false,
      response: chatUnavailableResponse(),
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

/**
 * Whether the API's answer entitles this user to chat.
 *
 * The API applies the one entitlement rule for every paid surface, including the
 * grace after a period ends, and reports a lapsed subscription as inactive. The
 * status and tier here are that answer. Re-checking the period against the clock
 * would deny paying customers at every renewal boundary while the rest of the
 * product allows them.
 */
export function hasValidChatEntitlement(
  subscription: SubscriptionInfo | null | undefined,
): boolean {
  if (!subscription) {
    return false;
  }
  if (!subscription.hasActiveSubscription || !subscription.isPremium) {
    return false;
  }
  // Chat is entitled while the subscription is, the same rule the banner and the
  // premium checks use: active, trialing, or past_due inside the grace from the
  // failed charge. Reading it through isEntitledSubscription keeps chat in step
  // with isPremium and the banner, so a customer in grace is not refused here.
  if (
    !isEntitledSubscription({
      status: subscription.status,
      pastDueSince: subscription.pastDueSince,
    })
  ) {
    return false;
  }
  if (!VALID_CHAT_TIERS.has(subscription.tier)) {
    return false;
  }
  return true;
}

export function premiumRequiredResponse(): NextResponse {
  return chatErrorResponse(
    403,
    chatErrorBody(
      "premium_required",
      "Premium subscription required",
      "Shorted AI is included with a paid subscription.",
    ),
  );
}

/**
 * The body every non-2xx chat response carries. The web chat UI renders from
 * this shape, so the field names and codes are a contract (see ChatErrorBody).
 */
export function chatErrorBody(
  code: ChatErrorCode,
  error: string,
  message: string,
  extra: Pick<
    ChatErrorBody,
    "retryAfterSeconds" | "limitKind" | "resetAt"
  > = {},
): ChatErrorBody {
  return { error, code, message, ...extra };
}

/** A JSON chat error response with the contract body. */
export function chatErrorResponse(
  status: number,
  body: ChatErrorBody,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json(body, { status, headers });
}

/**
 * The 503 for a server that is not configured for chat. It is not a limit, so
 * the client should retry later rather than read a window off it.
 */
function chatUnavailableResponse(): NextResponse {
  return chatErrorResponse(
    503,
    chatErrorBody(
      "unavailable",
      "Chat unavailable",
      "Chat is temporarily unavailable.",
      { retryAfterSeconds: 60 },
    ),
    { "Retry-After": "60" },
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
export function limitKindForBucket(windowSeconds: number): ChatLimitKind {
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
      return chatRateLimitResponse(result.response, config);
    }
  }
  return undefined;
}

/**
 * Translates the shared limiter's 429 into the chat contract. The shared body
 * also serves non-chat routes, so it is left alone. The window comes from the
 * bucket that refused, and the wait from the Retry-After header the limiter
 * already set.
 */
function chatRateLimitResponse(
  refused: NextResponse | undefined,
  config: RateLimitConfig,
): NextResponse {
  const limitKind = limitKindForBucket(config.windowSeconds);
  const retryAfterSeconds = retryAfterSecondsFrom(
    refused,
    config.windowSeconds,
  );
  return chatErrorResponse(
    429,
    chatErrorBody(
      "rate_limited",
      "Rate limit exceeded",
      chatRateLimitMessage(
        limitKind,
        config.authenticatedLimit,
        retryAfterSeconds,
      ),
      {
        retryAfterSeconds,
        limitKind,
        resetAt: Math.floor(Date.now() / 1000) + retryAfterSeconds,
      },
    ),
    { "Retry-After": String(retryAfterSeconds) },
  );
}

function retryAfterSecondsFrom(
  refused: NextResponse | undefined,
  fallback: number,
): number {
  const header = Number.parseInt(refused?.headers.get("Retry-After") ?? "", 10);
  return Number.isFinite(header) && header > 0 ? header : fallback;
}

/**
 * The sentence shown for a refused send. The wording matches the chat service's
 * own refusal, so a limit reads the same whichever layer refused it.
 */
export function chatRateLimitMessage(
  kind: ChatLimitKind,
  limit: number,
  retryAfterSeconds: number,
): string {
  const wait = formatWait(retryAfterSeconds);
  switch (kind) {
    case "per_minute":
      return `You can send ${limit} messages per minute. Try again in ${wait}.`;
    case "daily":
      return `You have reached the limit of ${limit} messages in 24 hours. Try again in ${wait}.`;
    case "monthly":
      return `You have reached the limit of ${limit} messages in 30 days. Try again in ${wait}.`;
    case "global":
      return `Shorted AI is busy right now. Try again in ${wait}.`;
  }
}

export function formatWait(seconds: number): string {
  const plural = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (seconds < 90) {
    return plural(seconds, "second");
  }
  if (seconds < 90 * 60) {
    return plural(Math.ceil(seconds / 60), "minute");
  }
  return plural(Math.ceil(seconds / 3600), "hour");
}

/**
 * The chat buckets, all of which FAIL OPEN when the distributed store is absent
 * or throws. The chat service enforces the authoritative per-user and global
 * limits in Postgres (chat_usage_events), so a Redis outage must not 503 a
 * paying user. These buckets are the first line on the normal path, not the
 * only one. Rate limiting does not depend on Upstash (CLAUDE.md, "Rate
 * Limiting"), and this is the web half of that rule.
 */
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
        failOpenWithoutStore: true,
      },
      {
        bucketName: "chat-send-day",
        anonymousLimit: 0,
        authenticatedLimit: positiveIntEnv(
          env.CHAT_SENDS_PER_DAY,
          DEFAULT_SENDS_PER_DAY,
        ),
        windowSeconds: 86_400,
        failOpenWithoutStore: true,
      },
      {
        bucketName: "chat-send-month",
        anonymousLimit: 0,
        authenticatedLimit: positiveIntEnv(
          env.CHAT_SENDS_PER_MONTH,
          DEFAULT_SENDS_PER_MONTH,
        ),
        windowSeconds: 2_592_000,
        failOpenWithoutStore: true,
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
      failOpenWithoutStore: true,
    },
  ];
}

/** The limit a refused send was held by, as the chat service reports it. */
export interface ChatLimitDetail {
  kind: ChatLimitKind;
  limit: number;
  retryAfterSeconds: number;
  resetAt: number;
}

/**
 * Parses the chat service's x-chat-limit payload. Returns undefined for anything
 * malformed, so a bad header degrades to a generic rate-limit message rather
 * than a thrown error.
 */
export function parseChatLimitDetail(
  raw: string | null | undefined,
): ChatLimitDetail | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  // The wire names are snake_case; they are read by property, not destructured
  // into variables that would break the camelCase naming rule.
  const wire = parsed as Record<string, unknown>;
  const kind = wire.kind;
  if (
    kind !== "per_minute" &&
    kind !== "daily" &&
    kind !== "monthly" &&
    kind !== "global"
  ) {
    return undefined;
  }
  if (
    !isPositiveNumber(wire.limit) ||
    !isPositiveNumber(wire.retry_after_seconds) ||
    !isPositiveNumber(wire.reset_at)
  ) {
    return undefined;
  }
  return {
    kind,
    limit: wire.limit,
    retryAfterSeconds: wire.retry_after_seconds,
    resetAt: wire.reset_at,
  };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Maps an error from the chat service's stream to the contract. It is used for
 * failures after the stream has started, which arrive as an in-stream error
 * chunk. The error is recognised by its numeric Connect code, not by its
 * class, because this module must not import @connectrpc/connect (CLAUDE.md,
 * "SSR Issues with @connectrpc/connect").
 */
export function chatErrorFromUpstreamError(error: unknown): ChatErrorBody {
  const code = connectCodeOf(error);
  if (code === CONNECT_RESOURCE_EXHAUSTED) {
    return rateLimitedBody(
      parseChatLimitDetail(metadataGet(error, CHAT_LIMIT_HEADER)),
    );
  }
  if (code === CONNECT_NOT_FOUND || code === CONNECT_PERMISSION_DENIED) {
    return conversationUnavailableBody();
  }
  return contractBody(contractCodeForConnectCode(code));
}

/**
 * The conversation id the client sent is one it cannot use: deleted, or not the
 * caller's. Sent as its own copy, so the client can offer a new chat instead of
 * repeating the same refused id on every send.
 */
function conversationUnavailableBody(): ChatErrorBody {
  return chatErrorBody(
    "invalid_request",
    "Conversation not found",
    "This conversation is no longer available. Start a new chat.",
  );
}

/**
 * Rebuilds a non-2xx response from the chat service into the contract. The
 * service answers a unary error as Connect JSON, `{"code": "resource_exhausted"}`,
 * and its own auth guard as plain text. Both are read here, and the upstream
 * message text is never passed to the client: the copy is ours.
 */
export async function chatErrorResponseFromUpstream(
  upstream: Response,
): Promise<NextResponse> {
  const text = await upstream.text().catch(() => "");
  const name = connectNameFrom(text);
  const code = contractCodeForConnectName(name, upstream.status);
  const body =
    code === "rate_limited"
      ? rateLimitedBody(
          parseChatLimitDetail(upstream.headers.get(CHAT_LIMIT_HEADER)),
        )
      : name === "not_found" || name === "permission_denied"
        ? conversationUnavailableBody()
        : contractBody(code);
  const headers: Record<string, string> = {};
  if (body.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(body.retryAfterSeconds);
  }
  return chatErrorResponse(httpStatusFor(code, upstream.status), body, headers);
}

function rateLimitedBody(detail: ChatLimitDetail | undefined): ChatErrorBody {
  if (!detail) {
    return chatErrorBody(
      "rate_limited",
      "Rate limit exceeded",
      "You have reached a limit on how many messages you can send. Try again shortly.",
    );
  }
  return chatErrorBody(
    "rate_limited",
    "Rate limit exceeded",
    chatRateLimitMessage(detail.kind, detail.limit, detail.retryAfterSeconds),
    {
      retryAfterSeconds: detail.retryAfterSeconds,
      limitKind: detail.kind,
      resetAt: detail.resetAt,
    },
  );
}

/** The fixed copy for each code. Limits are the only body built from data. */
function contractBody(code: ChatErrorCode): ChatErrorBody {
  switch (code) {
    case "unauthenticated":
      return chatErrorBody(
        code,
        "Authentication required",
        "Your session has ended. Sign in again to keep chatting.",
      );
    case "premium_required":
      return chatErrorBody(
        code,
        "Premium subscription required",
        "Shorted AI is included with a paid subscription.",
      );
    case "rate_limited":
      return rateLimitedBody(undefined);
    case "invalid_request":
      return chatErrorBody(
        code,
        "Invalid chat request",
        "That request could not be completed.",
      );
    case "unavailable":
      return chatErrorBody(
        code,
        "Chat unavailable",
        "Chat is temporarily unavailable.",
        { retryAfterSeconds: 60 },
      );
  }
}

/**
 * The chat service answers Unauthenticated only for the server-to-server
 * credential (X-Internal-Secret) and the user header this module sets. It sets
 * both after it has verified a signed-in caller, so an Unauthenticated that
 * reaches here is a misconfigured deploy, not a session that ended. It is
 * unavailable to the client, and an error to the operator.
 */
function serviceCredentialRejected(): ChatErrorCode {
  console.error(
    "chat: the chat service rejected this server's credentials (Unauthenticated). Check INTERNAL_SERVICE_SECRET on both services.",
  );
  return "unavailable";
}

function contractCodeForConnectCode(code: number | undefined): ChatErrorCode {
  switch (code) {
    case CONNECT_RESOURCE_EXHAUSTED:
      return "rate_limited";
    case CONNECT_UNAUTHENTICATED:
      return serviceCredentialRejected();
    case CONNECT_INVALID_ARGUMENT:
    case CONNECT_NOT_FOUND:
    case CONNECT_PERMISSION_DENIED:
    case CONNECT_OUT_OF_RANGE:
      return "invalid_request";
    default:
      return "unavailable";
  }
}

/**
 * Connect names a code in JSON. An unknown name is unavailable, because a
 * failure we cannot name is a server failure. A missing name falls back to the
 * HTTP status the chat service answered with.
 */
function contractCodeForConnectName(
  name: string | undefined,
  httpStatus: number,
): ChatErrorCode {
  switch (name) {
    case "resource_exhausted":
      return "rate_limited";
    case "unauthenticated":
      return serviceCredentialRejected();
    case "invalid_argument":
    case "not_found":
    case "permission_denied":
    case "out_of_range":
      return "invalid_request";
    case undefined:
      if (httpStatus === 401) return serviceCredentialRejected();
      if (httpStatus === 429) return "rate_limited";
      if (httpStatus >= 400 && httpStatus < 500) return "invalid_request";
      return "unavailable";
    default:
      return "unavailable";
  }
}

function httpStatusFor(code: ChatErrorCode, upstreamStatus: number): number {
  switch (code) {
    case "rate_limited":
      return 429;
    case "unauthenticated":
      return 401;
    case "premium_required":
      return 403;
    case "invalid_request":
      return upstreamStatus >= 400 && upstreamStatus < 500
        ? upstreamStatus
        : 400;
    case "unavailable":
      return 503;
  }
}

function connectCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function metadataGet(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const metadata = (error as { metadata?: { get?: unknown } }).metadata;
  if (!metadata || typeof metadata.get !== "function") {
    return undefined;
  }
  const value: unknown = metadata.get.call(metadata, key);
  return typeof value === "string" ? value : undefined;
}

function connectNameFrom(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      const name = (parsed as { code?: unknown }).code;
      return typeof name === "string" ? name : undefined;
    }
  } catch {
    // Plain text, not Connect JSON.
  }
  return undefined;
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
  // The proxy reads the chat service's answer and does not pass its encoding on,
  // so the answer is asked for uncompressed. Forwarding the browser's
  // Accept-Encoding made connect-go gzip every unary answer; fetch decoded it
  // here, and the response had to be rebuilt to match (filterResponseHeaders).
  headers.set("accept-encoding", "identity");
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
    const name = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(name) && !ENCODED_BODY_HEADERS.has(name)) {
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
  return chatErrorResponse(
    403,
    chatErrorBody(
      "invalid_request",
      "Forbidden",
      "Shorted AI can only be used from shorted.com.au.",
    ),
  );
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
