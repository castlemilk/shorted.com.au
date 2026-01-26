/**
 * Retry utility with exponential backoff
 * Useful for API calls that may fail transiently
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** Whether to retry on specific error types (default: retry on all errors) */
  shouldRetry?: (error: unknown) => boolean;
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
