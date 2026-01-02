"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { auth } from "~/server/auth";
import { SHORTS_API_URL } from "./config";

export async function mintApiTokenAction() {
  const session = await auth();

  if (!session?.user) {
    throw new Error(
      "Unauthorized: You must be signed in to mint an API token.",
    );
  }

  // Note: In a real production environment, we would pass the user's
  // ID token (Firebase/Google) to the backend to authorize the minting.
  // For this implementation, we'll assume the backend trusts the server action
  // if it provides a specific internal secret or if we've configured it to do so.

  const transport = createConnectTransport({
    fetch,
    baseUrl: SHORTS_API_URL,
  });

  const client = createClient(ShortedStocksService, transport);

  try {
    // We pass the user context through headers if the backend supports it
    // Or we rely on the backend's MintToken implementation which we just added
    const response = await client.mintToken(
      {},
      {
        headers: {
          // In a real app, we'd pass an internal service token here
          "X-Internal-Secret": "dev-internal-secret",
          "X-User-Id": session.user.id,
          "X-User-Email": session.user.email ?? "",
        },
      },
    );

    return { token: response.token };
  } catch (error) {
    console.error("Error minting API token:", error);
    throw new Error("Failed to generate API token. Please try again later.");
  }
}
