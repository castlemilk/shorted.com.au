/**
 * Google ID Token helper for service-to-service authentication
 *
 * This module provides functions to obtain Google ID tokens for authenticating
 * server actions with backend Cloud Run services.
 *
 * Environment variables:
 * - GOOGLE_SERVICE_ACCOUNT_KEY: JSON string of service account credentials
 * - SHORTS_SERVICE_URL: Target audience (Cloud Run service URL)
 */

import { GoogleAuth, type IdTokenClient } from "google-auth-library";

// Cache the auth client to avoid re-initialization
let authClient: IdTokenClient | null = null;
let authClientPromise: Promise<IdTokenClient> | null = null;

/**
 * Get the target audience for the ID token.
 * For Cloud Run, this should be the service URL.
 */
function getTargetAudience(): string {
  // Use the shorts service URL as the audience
  // Cloud Run services expect the service URL as the audience
  return (
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
    process.env.SHORTS_SERVICE_URL ??
    "https://shorts-service-pr-44-ak2zgjnhlq-km.a.run.app"
  );
}

/**
 * Initialize the Google Auth client for ID tokens.
 * Uses Application Default Credentials (ADC) which works with:
 * - GOOGLE_APPLICATION_CREDENTIALS env var pointing to a key file
 * - GOOGLE_SERVICE_ACCOUNT_KEY env var containing JSON credentials
 * - Metadata server on GCP (Cloud Run, GKE, etc.)
 */
async function initAuthClient(): Promise<IdTokenClient> {
  const targetAudience = getTargetAudience();

  // Check for JSON credentials in environment variable
  const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  let auth: GoogleAuth;

  if (serviceAccountKey) {
    // Parse JSON credentials from environment variable
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const credentials = JSON.parse(serviceAccountKey);
      auth = new GoogleAuth({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        credentials,
        // Required for ID tokens
      });
    } catch (e) {
      console.error("Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY:", e);
      throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT_KEY format");
    }
  } else {
    // Use Application Default Credentials
    auth = new GoogleAuth();
  }

  // Get an ID token client for the target audience
  const client = await auth.getIdTokenClient(targetAudience);
  return client;
}

/**
 * Get a Google ID token for authenticating with backend services.
 * The token is automatically refreshed when needed.
 *
 * @returns Promise<string> The ID token
 * @throws Error if credentials are not available
 */
export async function getGoogleIdToken(): Promise<string> {
  // For local development, skip Google auth
  if (
    process.env.NODE_ENV === "development" &&
    !process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  ) {
    console.log("[getGoogleIdToken] Skipping Google auth in development mode");
    return "";
  }

  try {
    // Initialize client if not already done (singleton pattern)
    if (!authClient) {
      if (!authClientPromise) {
        authClientPromise = initAuthClient();
      }
      authClient = await authClientPromise;
    }

    // Get headers which includes the ID token
    const responseHeaders = await authClient.getRequestHeaders();
    const authHeader = responseHeaders.Authorization ?? responseHeaders.authorization;

    if (!authHeader) {
      throw new Error("No Authorization header in response");
    }

    // Extract token from "Bearer <token>"
    const token = authHeader.replace(/^Bearer\s+/i, "");
    return token;
  } catch (error) {
    console.error("[getGoogleIdToken] Failed to get ID token:", error);
    // Reset client on error to allow retry
    authClient = null;
    authClientPromise = null;
    throw error;
  }
}

/**
 * Check if Google authentication is available.
 * Returns true if credentials are configured.
 */
export function isGoogleAuthAvailable(): boolean {
  return !!(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY ??
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}
