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
 * Rate limit error information parsed from server response
 */
export interface RateLimitInfo {
  /** Whether this is a rate limit error */
  isRateLimited: boolean;
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
  /** Error message from server */
  message?: string;
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
 * Extract rate limit information from a ConnectError
 * The backend sends rate limit details in error metadata headers
 */
export function parseRateLimitInfo(error: unknown): RateLimitInfo {
  if (!isConnectErrorSync(error)) {
    return { isRateLimited: false };
  }

  const connectError = error as { code: number; metadata: { get: (key: string) => string | null } };

  // ResourceExhausted code is 8
  if (connectError.code !== 8) {
    return { isRateLimited: false };
  }

  const metadata = connectError.metadata;

  return {
    isRateLimited: true,
    limit: parseIntHeader(metadata.get("X-RateLimit-Limit")),
    remaining: parseIntHeader(metadata.get("X-RateLimit-Remaining")),
    resetAt: parseIntHeader(metadata.get("X-RateLimit-Reset")),
    monthlyLimit: parseIntHeader(metadata.get("X-RateLimit-Monthly-Limit")),
    monthlyUsed: parseIntHeader(metadata.get("X-RateLimit-Monthly-Used")),
    monthlyResetAt: parseIntHeader(metadata.get("X-RateLimit-Monthly-Reset")),
    retryAfter: parseIntHeader(metadata.get("Retry-After")),
    message: error.message,
  };
}

function parseIntHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? undefined : parsed;
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
