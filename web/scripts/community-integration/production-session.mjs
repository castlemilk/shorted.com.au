import assert from "node:assert/strict";
import { encode } from "next-auth/jwt";

// Test-only local session. No application code imports this module. The caller
// supplies the disposable app's freshly generated secret, never an ambient one.
/** @returns {Promise<import("@playwright/test").Cookie>} */
export async function syntheticSessionCookie(secret, driver) {
  assert(["postgres", "firestore"].includes(driver));
  assert(secret && secret.length >= 32);
  const name = "__Secure-next-auth.session-token";
  const id = `synthetic-community-${driver}`;
  return {
    name,
    value: await encode({
      secret,
      salt: name,
      maxAge: 600,
      token: {
        id,
        sub: id,
        name: "Synthetic community writer",
        email: `community-integration-${driver}@example.test`,
        emailVerified: true,
        isAdmin: false,
      },
    }),
    domain: "127.0.0.1",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: Math.floor(Date.now() / 1000) + 600,
  };
}
