/**
 * Action retry wrapper
 * 
 * Wraps server actions with automatic retry logic to handle cold start failures
 * and transient network errors. Works seamlessly with React's cache().
 */

import { ConnectError, Code } from "@connectrpc/connect";
import { retryWithBackoff, type RetryOptions } from "@/lib/retry";

/**
 * Default retry configuration optimized for cold start scenarios
 */
const DEFAULT_ACTION_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  shouldRetry: shouldRetryError,
};

/**
 * Determines if an error should trigger a retry
 * 
 * @param error - The error to check
 * @returns true if the error is transient and should be retried
 */
function shouldRetryError(error: unknown): boolean {
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

/**
 * Wraps an async action function with retry logic
 * 
 * Use this to wrap action implementations before passing to cache().
 * 
 * @example
 * ```ts
 * export const getStockDetails = cache(
 *   withRetry(async (productCode: string) => {
 *     const client = createClient(ShortedStocksService, transport);
 *     return await client.getStockDetails({ productCode });
 *   })
 * );
 * ```
 * 
 * @param fn - The async function to wrap
 * @param options - Optional retry configuration overrides
 * @returns A wrapped function with retry logic
 */
export function withRetry<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options?: Partial<RetryOptions>,
): (...args: TArgs) => Promise<TReturn> {
  const retryOptions = { ...DEFAULT_ACTION_RETRY_OPTIONS, ...options };
  
  return async (...args: TArgs): Promise<TReturn> => {
    return retryWithBackoff(() => fn(...args), retryOptions);
  };
}

/**
 * Creates a retry-wrapped action that gracefully handles NotFound errors
 * 
 * Returns undefined instead of throwing when the resource is not found.
 * This is the recommended wrapper for most data fetching actions.
 * 
 * @example
 * ```ts
 * export const getStockDetails = cache(
 *   withRetryAndNotFound(async (productCode: string) => {
 *     const client = createClient(ShortedStocksService, transport);
 *     return await client.getStockDetails({ productCode });
 *   })
 * );
 * ```
 * 
 * @param fn - The async function to wrap
 * @param options - Optional retry configuration overrides
 * @returns A wrapped function that returns undefined on NotFound
 */
export function withRetryAndNotFound<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options?: Partial<RetryOptions>,
): (...args: TArgs) => Promise<TReturn | undefined> {
  const retryOptions = { ...DEFAULT_ACTION_RETRY_OPTIONS, ...options };
  
  return async (...args: TArgs): Promise<TReturn | undefined> => {
    try {
      return await retryWithBackoff(() => fn(...args), retryOptions);
    } catch (err) {
      // Return undefined for NotFound errors
      if (err instanceof ConnectError && err.code === Code.NotFound) {
        return undefined;
      }
      throw err;
    }
  };
}

export { type RetryOptions };
