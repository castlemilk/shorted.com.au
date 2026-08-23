"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { BillingService } from "~/gen/shorts/v1alpha1/billing_pb";
import { auth } from "~/server/auth";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { recordProductEvent } from "~/@/lib/product-events";

// Server-side counterpart to the GA events in `api-key-manager.tsx`. GA tells us
// what the browser did; this tells us whether the mint actually worked, and
// survives adblockers — which developers run. No token material, no user id.
const MINT_EVENT = { feature: "api_token", action: "mint" } as const;

export async function mintApiTokenAction() {
  const session = await auth();

  if (!session?.user) {
    recordProductEvent({
      ...MINT_EVENT,
      status: "unauthenticated",
      properties: { route_group: "/developer" },
    });
    throw new Error(
      "Unauthorized: You must be signed in to mint an API token.",
    );
  }

  // Note: In a real production environment, we would pass the user's
  // ID token (Firebase/Google) to the backend to authorize the minting.
  // For this implementation, we'll assume the backend trusts the server action
  // if it provides a specific internal secret or if we've configured it to do so.

  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
  });

  const client = createClient(BillingService, transport);

  try {
    const internalSecret =
      process.env.INTERNAL_SERVICE_SECRET ??
      (process.env.NODE_ENV === "development"
        ? "dev-internal-secret"
        : undefined);
    if (!internalSecret) {
      throw new Error(
        "INTERNAL_SERVICE_SECRET not configured for production",
      );
    }

    const response = await client.mintToken(
      {},
      {
        headers: {
          "X-Internal-Secret": internalSecret,
          "X-User-Id": session.user.id,
          "X-User-Email": session.user.email ?? "",
        },
      },
    );

    recordProductEvent({
      ...MINT_EVENT,
      status: "success",
      properties: { route_group: "/developer" },
    });
    return { token: response.token };
  } catch (error) {
    console.error("Error minting API token:", error);
    recordProductEvent({
      ...MINT_EVENT,
      status: "error",
      properties: {
        route_group: "/developer",
        // Constructor name only — an upstream message can carry detail we do
        // not want in a low-cardinality label.
        error_name: error instanceof Error ? error.name : "unknown",
      },
    });
    throw new Error("Failed to generate API token. Please try again later.");
  }
}
