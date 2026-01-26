/**
 * API Client for server actions
 *
 * Provides authenticated access to backend services using Google ID tokens
 * for service-to-service authentication.
 */

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient, type Client } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { getGoogleIdToken, isGoogleAuthAvailable } from "./getGoogleIdToken";
import { auth } from "./auth";

// Get the Shorts API URL
function getShortsApiUrl(): string {
  return (
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
    "http://localhost:9091"
  );
}

export type AuthenticatedClient = Client<typeof ShortedStocksService>;

/**
 * Get authentication headers for API calls.
 *
 * In production: Uses Google ID token for service-to-service auth
 * In development: Falls back to internal secret header
 *
 * Also passes user information from the session for authorization.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const session = await auth();
  const headers: Record<string, string> = {};

  // Add user info headers for authorization
  if (session?.user) {
    headers["X-User-Email"] = session.user.email ?? "";
    headers["X-User-Id"] = session.user.id ?? "";
  }

  // Try to get Google ID token for service-to-service auth
  if (isGoogleAuthAvailable()) {
    try {
      const idToken = await getGoogleIdToken();
      if (idToken) {
        headers.Authorization = `Bearer ${idToken}`;
        return headers;
      }
    } catch (error) {
      console.warn(
        "[getAuthHeaders] Failed to get Google ID token, falling back to internal auth:",
        error,
      );
    }
  }

  // Fallback: Use internal secret for local development or when Google auth unavailable
  // This should only be used in development
  if (process.env.NODE_ENV === "development") {
    headers["X-Internal-Secret"] = "dev-internal-secret";
  } else {
    // In production, if we don't have Google auth, we need to fail
    // unless we have the internal secret explicitly set
    const internalSecret = process.env.INTERNAL_SECRET;
    if (internalSecret) {
      headers["X-Internal-Secret"] = internalSecret;
    } else {
      console.warn(
        "[getAuthHeaders] No authentication method available in production",
      );
    }
  }

  return headers;
}

/**
 * Create an authenticated API client for server actions.
 *
 * Usage:
 * ```typescript
 * const client = await createAuthenticatedClient();
 * const response = await client.getTopShorts({ limit: 10 });
 * ```
 */
export async function createAuthenticatedClient(): Promise<AuthenticatedClient> {
  const headers = await getAuthHeaders();

  const transport = createConnectTransport({
    fetch,
    baseUrl: getShortsApiUrl(),
  });

  // Create a client with default headers
  const client = createClient(ShortedStocksService, transport);

  // Return a proxy that adds auth headers to all calls
  return new Proxy(client, {
    get(target, prop) {
      const value = target[prop as keyof typeof target];
      if (typeof value === "function") {
        return async (...args: unknown[]) => {
          // If the last argument is an options object, merge headers
          const lastArg = args[args.length - 1];
          if (lastArg && typeof lastArg === "object" && "headers" in lastArg) {
            (lastArg as { headers: Record<string, string> }).headers = {
              ...headers,
              ...(lastArg as { headers: Record<string, string> }).headers,
            };
          } else {
            // Add options with headers
            args.push({ headers });
          }
          return (value as (...args: unknown[]) => Promise<unknown>).apply(
            target,
            args,
          );
        };
      }
      return value;
    },
  }) as AuthenticatedClient;
}
