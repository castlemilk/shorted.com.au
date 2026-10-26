import { encode } from "next-auth/jwt";

import {
  PAID_PROBE_EMAIL,
  PAID_PROBE_NAME,
  PAID_PROBE_USER_ID,
} from "./constants";

/** Short on purpose: a probe run mints a fresh cookie and never reuses one. */
export const PROBE_SESSION_MAX_AGE_SECONDS = 15 * 60;

export interface ProbeCookie {
  name: string;
  value: string;
}

/**
 * The session cookie name auth.ts configures. Keep the two in lockstep: a
 * mismatch makes the middleware and auth() both ignore the probe's cookie, and
 * every chat step then fails with a 401 that looks like a product regression.
 */
export function sessionCookieName(nodeEnv: string | undefined): string {
  return `${nodeEnv === "production" ? "__Secure-" : ""}next-auth.session-token`;
}

/**
 * Mint the session cookie auth() would have issued for the probe identity.
 *
 * Auth.js v5 encrypts the JWT with a key derived from the secret, and the
 * derivation salt is the cookie name (@auth/core `getToken` and `session`
 * both pass `salt = cookieName`). The middleware reads the same cookie with
 * NEXTAUTH_SECRET, so that is the secret used here, with no AUTH_SECRET
 * fallback that the middleware does not have.
 *
 * `sub` is required: the middleware rejects an API-auth path when the token has
 * no sub, and `id` is what the session callback copies to session.user.id.
 */
export async function mintProbeSessionCookie(options: {
  secret: string;
  nodeEnv: string | undefined;
}): Promise<ProbeCookie> {
  const name = sessionCookieName(options.nodeEnv);
  const value = await encode({
    token: {
      sub: PAID_PROBE_USER_ID,
      id: PAID_PROBE_USER_ID,
      email: PAID_PROBE_EMAIL,
      name: PAID_PROBE_NAME,
    },
    secret: options.secret,
    salt: name,
    maxAge: PROBE_SESSION_MAX_AGE_SECONDS,
  });
  return { name, value };
}
