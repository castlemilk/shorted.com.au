/**
 * Retry utility with exponential backoff
 * Useful for API calls that may fail transiently
 */

import { ConnectError, Code } from "@connectrpc/connect";

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
  // Don't retry ConnectError with specific non-transient codes
  if (error instanceof ConnectError) {
    const nonRetryableCodes = [
      Code.NotFound,
      Code.InvalidArgument,
      Code.PermissionDenied,
      Code.Unauthenticated,
      Code.FailedPrecondition,
      Code.OutOfRange,
      Code.Unimplemented,
    ];
    
    if (nonRetryableCodes.includes(error.code)) {
      return false;
    }
    
    // Retry on transient errors
    const retryableCodes = [
      Code.Unavailable,
      Code.DeadlineExceeded,
      Code.ResourceExhausted,
      Code.Aborted,
      Code.Internal,
      Code.Unknown,
    ];
    
    return retryableCodes.includes(error.code);
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
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
): number {
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

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry this error
      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }

      // Don't retry on the last attempt
      if (attempt < maxRetries) {
        const delay = calculateDelay(
          attempt,
          initialDelayMs,
          maxDelayMs,
          backoffMultiplier,
        );

        console.log(
          `Retry attempt ${attempt + 1}/${maxRetries + 1} after ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}
