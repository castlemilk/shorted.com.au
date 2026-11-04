// The internal transport for a signed-in caller of the shorts API.
//
// Every private RPC a signed-in user reaches from a server action goes through
// createSignedInTransport. It reads the session itself (auth()) and derives the
// identity and the verified-address flag from that session: a caller passes
// options only, never an address, a flag or a session object, so no action can
// assert a verification it did not check.
//
// Only the alerts calls act on the address (the API stores and emails it only
// when x-user-email-verified is "true"). Read-only calls ask for identity alone:
// they send no address and no verification flag, and make no Firebase lookup.

import type { Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { auth } from "~/server/auth";
import { lookupAccountVerification } from "~/server/account-verification";
import { internalServiceSecret } from "~/server/internal-service-secret";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";

/** The fields of the signed-in session this module reads. */
interface SignedInSession {
  user?: {
    id?: string;
    email?: string | null;
    emailVerified?: boolean;
  } | null;
}

/**
 * The address the API may email alerts to. Only a verified address is sent: an
 * unverified sign-up keeps its monitors recorded but never emailed, because a
 * mistyped address would otherwise receive mail it never asked for.
 *
 * The session's flag is read once, at sign-in. An unverified session therefore asks
 * Firebase now, so a user who has clicked the link is not blocked until they sign
 * out. A failed lookup reads as unverified: it returns "" and never asserts a
 * verification.
 */
async function deliverableEmail(session: SignedInSession): Promise<string> {
  if (session.user?.emailVerified === true) return session.user.email ?? "";
  const uid = session.user?.id;
  if (!uid) return "";
  try {
    const account = await lookupAccountVerification(uid);
    return account?.verified ? account.email : "";
  } catch {
    return "";
  }
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
 * A transport that asserts the signed-in user's identity to the API, for the
 * session of the current request. The only input is the options; the identity,
 * the address and the verification flag all come from auth() and Firebase.
 *
 * Throws when there is no signed-in session, and when the internal secret is not
 * configured outside development (the shared helper fails closed).
 */
export async function createSignedInTransport(
  options: SignedInTransportOptions = {},
): Promise<SignedInTransport> {
  const session = (await auth()) as SignedInSession | null;
  const userId = session?.user?.id;
  if (!session || !userId) {
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
