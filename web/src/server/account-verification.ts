import { adminAuth } from "~/@/lib/firebase-admin";

/**
 * The account's email verification as Firebase holds it today.
 *
 * The next-auth session copy (token.emailVerified) is read once, at sign-in, so it
 * stays false after the user clicks the verification link. Anything that decides
 * whether an address may receive mail asks Firebase instead, through this module.
 *
 * This module imports only firebase-admin. auth.ts depends on it, so it must not
 * import auth (or rate-limit, which imports auth).
 */
export interface AccountVerification {
  email: string;
  verified: boolean;
  hasPassword: boolean;
}

/**
 * Reads the Firebase account for a uid. Returns null when there is no usable
 * account (unknown uid, disabled, no address, or the lookup failed). Callers treat
 * null as unverified, so a lookup failure can never make an address deliverable.
 *
 * Never logs the address: only the error code is logged.
 */
export async function lookupAccountVerification(
  uid: string,
): Promise<AccountVerification | null> {
  if (!uid) return null;
  try {
    const user = await adminAuth.getUser(uid);
    if (user.disabled) return null;
    const email = user.email?.trim() ?? "";
    if (!email) return null;
    return {
      email,
      verified: user.emailVerified === true,
      hasPassword: user.providerData.some(
        (provider) => provider.providerId === "password",
      ),
    };
  } catch (error) {
    // Expected for uids that are not Firebase accounts, such as the E2E identity.
    const code = (error as { code?: unknown } | null)?.code;
    console.warn(
      `[account-verification] lookup unavailable (${typeof code === "string" ? code : "unknown"})`,
    );
    return null;
  }
}
