/**
 * Action retry wrapper
 *
 * Wraps server actions with automatic retry logic to handle cold start failures
 * and transient network errors. Works seamlessly with React's cache().
 *
 * Note: Uses duck-typing for ConnectError instead of direct imports from
 * @connectrpc/connect to avoid SSR failures (see CLAUDE.md SSR Issues section).
 */

import {
  retryWithBackoff,
  shouldRetryConnectError,
  type RetryOptions,
} from "@/lib/retry";

// gRPC/Connect error code for NotFound - hardcoded to avoid SSR-breaking import
const CODE_NOT_FOUND = 5;

// Duck-type check for ConnectError shape (avoids importing @connectrpc/connect)
function isConnectError(error: unknown): error is { code: number; message: string } {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as Record<string, unknown>).code === "number" &&
    "message" in error
  );
}

/**
 * Default retry configuration optimized for cold start scenarios
 */
const DEFAULT_ACTION_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  shouldRetry: shouldRetryConnectError,
};

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
 * Creates a retry-wrapped action that gracefully handles errors
 *
 * Returns undefined instead of throwing when:
 * - The resource is not found (NotFound error)
 * - All retries are exhausted (to prevent SSR crashes)
 *
 * This is the recommended wrapper for most data fetching actions in
 * Server Components, as it prevents crashes and allows fallback UI.
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
 * @returns A wrapped function that returns undefined on errors
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
      // Return undefined for NotFound errors (expected case)
      if (isConnectError(err) && err.code === CODE_NOT_FOUND) {
        return undefined;
      }

      // For other errors after all retries exhausted, log and return undefined
      // This prevents Server Component crashes in production
      console.error(
        "[withRetryAndNotFound] All retries exhausted, returning undefined:",
        err instanceof Error ? err.message : String(err),
        {
          args: args
            .map((a) => (typeof a === "string" ? a : "[object]"))
            .join(", "),
        },
      );
      return undefined;
    }
  };
}

/**
 * Sentinel error indicating a resource was not found (Connect NotFound / gRPC code 5).
 * Caught by callers who need to distinguish 404 from transient failures.
 */
export class NotFoundError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * Like withRetryAndNotFound, but throws NotFoundError for NotFound responses
 * instead of returning undefined. Returns undefined only for transient errors.
 *
 * Use this when the caller needs to distinguish "resource doesn't exist"
 * from "backend temporarily unavailable".
 */
export function withRetryAndThrowNotFound<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options?: Partial<RetryOptions>,
): (...args: TArgs) => Promise<TReturn | undefined> {
  const retryOptions = { ...DEFAULT_ACTION_RETRY_OPTIONS, ...options };

  return async (...args: TArgs): Promise<TReturn | undefined> => {
    try {
      return await retryWithBackoff(() => fn(...args), retryOptions);
    } catch (err) {
      // Throw NotFoundError so callers can trigger notFound()
      if (isConnectError(err) && err.code === CODE_NOT_FOUND) {
        throw new NotFoundError(err.message);
      }

      // For other errors, return undefined to let components show retry UI
      console.error(
        "[withRetryAndThrowNotFound] All retries exhausted, returning undefined:",
        err instanceof Error ? err.message : String(err),
        {
          args: args
            .map((a) => (typeof a === "string" ? a : "[object]"))
            .join(", "),
        },
      );
      return undefined;
    }
  };
}

export { type RetryOptions };
