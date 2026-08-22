/**
 * Retry utility with exponential backoff
 * Useful for API calls that may fail transiently
 *
 * Note: This module uses duck-typing for ConnectError instead of direct imports
 * to avoid SSR issues with @connectrpc/connect. The error codes are hardcoded
 * to match gRPC/Connect-RPC codes.
 */

// gRPC/Connect error codes - hardcoded to avoid importing @connectrpc/connect
// which causes SSR issues during Next.js server-side rendering
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CONNECT_ERROR_CODES = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

// Type for duck-typed ConnectError
interface ConnectErrorLike {
  code: number;
  message: string;
  metadata: { get: (key: string) => string | null };
}

// Synchronous check that works without the module loaded
function isConnectErrorSync(error: unknown): error is ConnectErrorLike {
  // Duck-type check for ConnectError shape
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as Record<string, unknown>).code === "number" &&
    "message" in error &&
    "metadata" in error
  );
}

/**
 * Which limit the caller actually tripped.
 *
 * - `per_minute` — a short, self-healing burst limit. Enforced at the
 *   Cloudflare edge (`X-RateLimit-Scope: edge-minute`). Retrying works.
 * - `monthly` — the caller's monthly quota is exhausted. Enforced by the Go
 *   API. Retrying is pointless until the quota resets; this is the upgrade
 *   moment.
 * - `unknown` — a 429 we can't classify (missing/garbage headers). Treated as
 *   transient, because the generous browser buckets mean an unclassified 429 is
 *   far more likely to be a burst than an exhausted quota.
 */
export type RateLimitKind = "per_minute" | "monthly" | "unknown";

/** Caller tier as reported by the API. */
export type RateLimitTier = "anonymous" | "free" | "paid";

/** Canonical upgrade destination — matches premium-gate.tsx. */
export const DEFAULT_UPGRADE_URL = "/pricing";

/**
 * Rate limit error information parsed from server response
 */
export interface RateLimitInfo {
  /** Whether this is a rate limit error */
  isRateLimited: boolean;
  /** Which limit was tripped — drives retry policy and which UI is shown */
  kind: RateLimitKind;
  /** Per-minute limit */
  limit?: number;
  /** Remaining requests in current window */
  remaining?: number;
  /** When the minute-window resets (Unix timestamp) */
  resetAt?: number;
  /** Monthly limit */
  monthlyLimit?: number;
  /** Monthly usage count */
  monthlyUsed?: number;
  /** When the monthly window resets (Unix timestamp) */
  monthlyResetAt?: number;
  /** Suggested retry delay in seconds */
  retryAfter?: number;
  /** Caller tier, when the server reports it */
  tier?: RateLimitTier;
  /** Absolute or relative upgrade URL, when the server supplies one */
  upgradeUrl?: string;
  /** Error message from server */
  message?: string;
}

const VALID_TIERS: readonly string[] = ["anonymous", "free", "paid"];

/** Narrow an arbitrary string to a known tier, or undefined. */
function parseTier(value: string | null | undefined): RateLimitTier | undefined {
  if (!value) return undefined;
  const normalised = value.trim().toLowerCase();
  return VALID_TIERS.includes(normalised)
    ? (normalised as RateLimitTier)
    : undefined;
}

/**
 * Accept only same-origin-relative paths or absolute http(s) URLs. Anything
 * else (javascript:, data:, protocol-relative) is dropped — this value ends up
 * in an href.
 */
function parseUpgradeUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("//")) return undefined;
  if (trimmed.startsWith("/")) return trimmed;
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) return trimmed;
  return undefined;
}

/**
 * Check if an error is a rate limit error (429 / ResourceExhausted)
 */
export function isRateLimitError(error: unknown): boolean {
  if (!isConnectErrorSync(error)) return false;
  // ResourceExhausted code is 8 in gRPC/Connect
  const connectError = error as { code: number };
  return connectError.code === 8; // Code.ResourceExhausted
}

/**
 * Optional structured 429 payload.
 *
 * The header contract (X-RateLimit-*) is the source of truth and is what the
 * API and edge emit today. If the server additionally attaches a structured
 * payload, we prefer its explicit fields (notably `kind`, `tier` and
 * `upgrade_url`, which the headers cannot express). Both snake_case and
 * camelCase spellings are accepted so we don't break on a naming choice.
 */
interface StructuredRateLimitPayload {
  kind?: unknown;
  limit?: unknown;
  used?: unknown;
  reset?: unknown;
  tier?: unknown;
  upgrade_url?: unknown;
  upgradeUrl?: unknown;
  resetAt?: unknown;
  retry_after?: unknown;
  retryAfter?: unknown;
}

/** Pull a structured payload off the error, if one is present. */
function extractStructuredPayload(
  error: unknown,
): StructuredRateLimitPayload | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;

  // Common shapes: err.rateLimit, err.details[], err.cause.rateLimit
  const direct = record.rateLimit ?? record.rate_limit;
  if (direct && typeof direct === "object") {
    return direct as StructuredRateLimitPayload;
  }

  const details = record.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (detail && typeof detail === "object") {
        const d = detail as Record<string, unknown>;
        // A detail is ours if it carries a limit-kind discriminator.
        if ("kind" in d || "upgrade_url" in d || "upgradeUrl" in d) {
          return d as StructuredRateLimitPayload;
        }
      }
    }
  }

  return undefined;
}

/** Coerce an unknown payload value to a finite non-negative integer. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") return parseIntHeader(value);
  return undefined;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Decide which limit was tripped.
 *
 * Order matters: an explicit server-declared kind wins; otherwise monthly is
 * only claimed when we can actually prove exhaustion from the numbers. We
 * never *infer* monthly from a bare 429, because falsely showing the upgrade
 * panel to a browsing user is the worst failure mode here.
 */
function classifyKind(
  declaredKind: string | undefined,
  scope: string | null,
  monthlyLimit: number | undefined,
  monthlyUsed: number | undefined,
  perMinuteLimit: number | undefined,
): RateLimitKind {
  const normalised = declaredKind?.trim().toLowerCase();
  if (normalised === "monthly") return "monthly";
  if (normalised === "per_minute" || normalised === "per-minute") {
    return "per_minute";
  }

  // The edge stamps its own scope on every per-minute 429.
  if (scope && scope.trim().toLowerCase() === "edge-minute") {
    return "per_minute";
  }

  // Provable monthly exhaustion: a real quota that has been met or exceeded.
  if (
    typeof monthlyLimit === "number" &&
    monthlyLimit > 0 &&
    typeof monthlyUsed === "number" &&
    monthlyUsed >= monthlyLimit
  ) {
    return "monthly";
  }

  if (typeof perMinuteLimit === "number" && perMinuteLimit > 0) {
    return "per_minute";
  }

  return "unknown";
}

/**
 * Extract rate limit information from a ConnectError.
 *
 * Reads the X-RateLimit-* / Retry-After metadata contract, and layers any
 * structured payload fields on top. Every field is optional and defensively
 * parsed — a malformed header degrades to `undefined` rather than throwing or
 * producing NaN in the UI.
 */
export function parseRateLimitInfo(error: unknown): RateLimitInfo {
  if (!isConnectErrorSync(error)) {
    return { isRateLimited: false, kind: "unknown" };
  }

  const connectError = error as {
    code: number;
    metadata: { get: (key: string) => string | null };
  };

  // ResourceExhausted code is 8
  if (connectError.code !== 8) {
    return { isRateLimited: false, kind: "unknown" };
  }

  const metadata = connectError.metadata;
  // A hand-rolled/duck-typed error may not carry a working metadata bag.
  const get = (key: string): string | null => {
    try {
      return metadata?.get?.(key) ?? null;
    } catch {
      return null;
    }
  };

  const payload = extractStructuredPayload(error) ?? {};

  const limit = toNumber(payload.limit) ?? parseIntHeader(get("X-RateLimit-Limit"));
  const monthlyLimit = parseIntHeader(get("X-RateLimit-Monthly-Limit"));
  const monthlyUsed =
    toNumber(payload.used) ?? parseIntHeader(get("X-RateLimit-Monthly-Used"));
  const monthlyResetAt = parseIntHeader(get("X-RateLimit-Monthly-Reset"));
  const resetAt =
    toNumber(payload.reset) ??
    toNumber(payload.resetAt) ??
    parseIntHeader(get("X-RateLimit-Reset"));
  const retryAfter =
    toNumber(payload.retry_after) ??
    toNumber(payload.retryAfter) ??
    parseIntHeader(get("Retry-After"));

  const declaredKind = toStringOrUndefined(payload.kind);
  const kind = classifyKind(
    declaredKind,
    get("X-RateLimit-Scope"),
    monthlyLimit,
    monthlyUsed,
    limit,
  );

  // A monthly 429 reports its reset via the monthly header; a per-minute one
  // via Retry-After / X-RateLimit-Reset. Expose whichever applies as `resetAt`
  // fallback so the countdown always has something sane to render.
  return {
    isRateLimited: true,
    kind,
    limit,
    remaining: parseIntHeader(get("X-RateLimit-Remaining")),
    resetAt,
    monthlyLimit,
    monthlyUsed,
    monthlyResetAt,
    retryAfter,
    tier:
      parseTier(toStringOrUndefined(payload.tier)) ??
      parseTier(get("X-RateLimit-Tier")),
    upgradeUrl:
      parseUpgradeUrl(
        toStringOrUndefined(payload.upgrade_url) ??
          toStringOrUndefined(payload.upgradeUrl),
      ) ?? parseUpgradeUrl(get("X-RateLimit-Upgrade-Url")),
    message: error.message,
  };
}

/**
 * True when the caller's monthly quota is exhausted. This is the only case
 * where retrying is pointless and the upgrade panel should be shown.
 */
export function isMonthlyQuotaExhausted(error: unknown): boolean {
  return parseRateLimitInfo(error).kind === "monthly";
}

function parseIntHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  // Reject NaN and negatives — a negative limit/countdown is garbage, and
  // letting it through produces "-3 seconds" in the UI.
  if (isNaN(parsed) || parsed < 0) return undefined;
  return parsed;
}

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Whether to retry on specific error types (default: uses shouldRetryConnectError) */
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Determines if an error should trigger a retry.
 *
 * This function is smart about Connect-RPC errors:
 * - NOT retried: NotFound, InvalidArgument, PermissionDenied, etc. (deterministic failures)
 * - Retried: Unavailable, DeadlineExceeded, Internal, etc. (transient failures)
 * - Network errors are always retried
 *
 * @param error - The error to check
 * @returns true if the error is transient and should be retried
 */
export function shouldRetryConnectError(error: unknown): boolean {
  // gRPC/Connect error codes (used as numeric values to avoid SSR import issues)
  const NON_RETRYABLE_CODES = [
    5,  // NotFound
    3,  // InvalidArgument
    7,  // PermissionDenied
    16, // Unauthenticated
    9,  // FailedPrecondition
    11, // OutOfRange
    12, // Unimplemented
  ];

  const RETRYABLE_CODES = [
    14, // Unavailable
    4,  // DeadlineExceeded
    8,  // ResourceExhausted
    10, // Aborted
    13, // Internal
    2,  // Unknown
  ];

  // Don't retry ConnectError with specific non-transient codes
  if (isConnectErrorSync(error)) {
    const connectError = error as { code: number };

    if (NON_RETRYABLE_CODES.includes(connectError.code)) {
      return false;
    }

    // ResourceExhausted is retryable ONLY when it's a per-minute burst.
    // A monthly quota does not refill for days or weeks — retrying just burns
    // requests and delays showing the user the one thing that helps (upgrade).
    if (connectError.code === 8) {
      return parseRateLimitInfo(error).kind !== "monthly";
    }

    return RETRYABLE_CODES.includes(connectError.code);
  }
  
  // Retry on network errors (fetch failures, timeouts, etc.)
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true;
  }
  
  // Retry on generic Error with network-related messages
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("econnrefused") ||
      message.includes("econnreset") ||
      message.includes("socket")
    ) {
      return true;
    }
  }
  
  // Default: retry unknown errors (conservative approach for cold starts)
  return true;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "shouldRetry">> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

/**
 * Sleep for the specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay for exponential backoff
 * For rate limit errors, uses Retry-After header if available
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
  error?: unknown,
): number {
  // For rate limit errors, check for Retry-After header
  if (error && isRateLimitError(error)) {
    const rateLimitInfo = parseRateLimitInfo(error);
    if (rateLimitInfo.retryAfter) {
      // Use the server-suggested retry delay (in seconds, convert to ms)
      // Cap at maxDelayMs to prevent extremely long waits
      return Math.min(rateLimitInfo.retryAfter * 1000, maxDelayMs);
    }
  }

  // Standard exponential backoff
  const delay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
  return Math.min(delay, maxDelayMs);
}

/**
 * Retry a function with exponential backoff
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration options
 * @returns The result of the function if successful
 * @throws The last error if all retries fail
 *
 * @example
 * ```ts
 * const result = await retryWithBackoff(
 *   () => fetchData(),
 *   { maxRetries: 3, initialDelayMs: 500 }
 * );
 * ```
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    backoffMultiplier,
    shouldRetry,
  } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  let lastError: unknown;
  const shouldRetryError = shouldRetry ?? shouldRetryConnectError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry this error
      if (!shouldRetryError(error)) {
        throw error;
      }

      // Don't retry on the last attempt
      if (attempt < maxRetries) {
        const delay = calculateDelay(
          attempt,
          initialDelayMs,
          maxDelayMs,
          backoffMultiplier,
          error,
        );

        const isRateLimit = isRateLimitError(error);
        console.log(
          `Retry attempt ${attempt + 1}/${maxRetries + 1} after ${delay}ms${isRateLimit ? " (rate limited)" : ""}`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}
