// The internal transport for a signed-in caller of the shorts API.
//
// Every private RPC a signed-in user reaches from a server action goes through
// createSignedInTransport. It derives the identity and the verified-address flag
// from the session itself: a caller passes the session from auth(), never an
// address or a flag, so no action can assert a verification it did not check.
//
// Only the alerts calls act on the address (the API stores and emails it only
// when x-user-email-verified is "true"). Read-only calls ask for identity alone:
// they send no address and no verification flag, and make no Firebase lookup.

import type { Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { lookupAccountVerification } from "~/server/account-verification";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";

/** The fields of the next-auth session this module reads. */
export interface SignedInSession {
  user?: {
    id?: string;
    email?: string | null;
    emailVerified?: boolean;
  } | null;
}

/** The development secret the Go API accepts outside production. */
const DEV_INTERNAL_SECRET = "dev-internal-secret";

/**
 * The shared secret the API checks. Production fails closed: without
 * INTERNAL_SERVICE_SECRET there is no identity to send, so the call throws
 * instead of falling back to the development secret.
 */
export function internalServiceSecret(): string {
  const configured = process.env.INTERNAL_SERVICE_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("INTERNAL_SERVICE_SECRET is not set");
  }
  return DEV_INTERNAL_SECRET;
}

/**
 * The address the API may email alerts to. Only a verified address is sent: an
 * unverified sign-up keeps its monitors recorded but never emailed, because a
 * mistyped address would otherwise receive mail it never asked for.
 *
 * The session's flag is read once, at sign-in. An unverified session therefore asks
 * Firebase now, so a user who has clicked the link is not blocked until they sign
 * out. A failed lookup reads as unverified.
 */
export async function deliverableEmail(
  session: SignedInSession | null,
): Promise<string> {
  if (session?.user?.emailVerified === true) return session.user.email ?? "";
  const uid = session?.user?.id;
  if (!uid) return "";
  const account = await lookupAccountVerification(uid);
  return account?.verified ? account.email : "";
}

export interface SignedInTransportOptions {
  /**
   * True (the default) for calls that act on the address, such as alerts. False
   * for read-only calls: no address, no verification flag, no Firebase lookup.
   */
  withEmail?: boolean;
}

export interface SignedInTransport {
  transport: Transport;
  /** The verified address the API may email, or "" when none or when withEmail is false. */
  email: string;
}

/**
 * A transport that asserts the signed-in user's identity to the API. The caller
 * cannot choose the address or the flag: both come from the session and from
 * deliverableEmail.
 */
export async function createSignedInTransport(
  session: SignedInSession | null,
  options: SignedInTransportOptions = {},
): Promise<SignedInTransport> {
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("createSignedInTransport needs a signed-in session");
  }
  const secret = internalServiceSecret();
  const withEmail = options.withEmail !== false;
  const address = withEmail ? await deliverableEmail(session) : "";

  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
    interceptors: [
      (next) => async (req) => {
        req.header.set("x-internal-secret", secret);
        req.header.set("x-user-id", userId);
        if (withEmail) {
          req.header.set("x-user-email", address);
          req.header.set(
            "x-user-email-verified",
            address !== "" ? "true" : "false",
          );
        }
        return await next(req);
      },
    ],
  });
  return { transport, email: address };
}
