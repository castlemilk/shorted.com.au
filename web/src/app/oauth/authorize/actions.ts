"use server";

import { auth } from "~/server/auth";
import { getServerShortsApiUrl } from "~/app/actions/config";

/**
 * Server side of the OAuth consent screen.
 *
 * WHERE THE AUTHORITY LIVES. The Go API is the authorization server; this file
 * is the only thing that stands between a human clicking Approve and a consent
 * ticket existing. It does three things nothing else can:
 *
 *  1. It establishes WHO is approving, from the next-auth session cookie —
 *     httpOnly, same-site, and not something a page on another origin can read
 *     or replay.
 *  2. It holds INTERNAL_SERVICE_SECRET, which is what /oauth/consent/ticket
 *     requires. That secret is why a stolen user credential is no longer enough
 *     to obtain an authorization code: minting proof of consent needs something
 *     that lives only on this server.
 *  3. It never lets the browser see either of those. The client component
 *     receives rendered facts and, on approve, a redirect URL — never a token,
 *     never the secret, never the user id it should trust.
 *
 * Everything these actions accept from the browser is re-validated by Go
 * against the client's REGISTRATION, so a tampered form field cannot widen a
 * scope or divert a redirect. This file's job is identity and intent, not
 * validation.
 */

// Dev fallback matches the other internal-secret callers (runJob, getSyncStatus)
// so a local stack works without configuration. Go refuses an unset secret in
// production, so this fallback cannot become a production hole.
const INTERNAL_SECRET =
  process.env.INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";

/** The parameters an OAuth client puts on the authorize URL. */
export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  scope: string;
  state: string;
}

export interface ScopeLine {
  scope: string;
  description: string;
}

/** What the human must be shown. Computed by Go, never by this file. */
export interface ConsentDetails {
  issuer: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  scopes: ScopeLine[];
}

export type ConsentDescribeResult =
  | { ok: true; details: ConsentDetails }
  | { ok: false; error: string; description: string };

export type ConsentDecisionResult =
  | { ok: true; redirectTo: string }
  | { ok: false; error: string; description: string };

interface OAuthErrorBody {
  error?: string;
  error_description?: string;
}

function internalHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${INTERNAL_SECRET}`,
    "x-internal-secret": INTERNAL_SECRET,
    // api.shorted.com.au 403s curl's default UA and anything that looks like a
    // scraper; every server-side caller in this app sends a browser-ish one.
    "User-Agent": "Mozilla/5.0 (compatible; ShortedConsent)",
  };
}

function requestBody(request: AuthorizationRequest, userId?: string) {
  return JSON.stringify({
    ...(userId ? { user_id: userId } : {}),
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: request.codeChallengeMethod,
    resource: request.resource,
    scope: request.scope,
  });
}

async function readError(response: Response): Promise<{
  error: string;
  description: string;
}> {
  const body = (await response.json().catch(() => ({}))) as OAuthErrorBody;
  return {
    error: body.error ?? "server_error",
    description:
      body.error_description ??
      `The request was refused (HTTP ${response.status}).`,
  };
}

/**
 * Ask Go what this authorization request actually is.
 *
 * It is deliberately not this file's job to decide: Go resolves the client
 * (including fetching a Client ID Metadata Document when the client_id is a
 * URL), checks the redirect URI against the registration by exact string match,
 * refuses anything but S256, and computes the granted scope. The screen renders
 * what comes back, so it cannot describe a request the grant would treat
 * differently.
 */
export async function describeAuthorizationRequest(
  request: AuthorizationRequest,
): Promise<ConsentDescribeResult> {
  try {
    const response = await fetch(
      `${getServerShortsApiUrl()}/oauth/consent/describe`,
      {
        method: "POST",
        headers: internalHeaders(),
        body: requestBody(request),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return { ok: false, ...(await readError(response)) };
    }
    const body = (await response.json()) as {
      issuer: string;
      client_id: string;
      client_name?: string;
      redirect_uri: string;
      scope: string;
      scopes?: ScopeLine[];
    };
    return {
      ok: true,
      details: {
        issuer: body.issuer,
        clientId: body.client_id,
        // An unnamed client is shown by its id rather than as a blank. "Approve
        // access for ___" is exactly the prompt a human clicks through.
        clientName: body.client_name?.trim() ?? "",
        redirectUri: body.redirect_uri,
        scope: body.scope,
        scopes: body.scopes ?? [],
      },
    };
  } catch (err) {
    console.error("[oauth] consent describe failed:", err);
    return {
      ok: false,
      error: "temporarily_unavailable",
      description: "Could not reach the authorization server.",
    };
  }
}

/**
 * The approve path: mint a consent ticket, then spend it on the grant.
 *
 * The session is re-read HERE rather than trusted from the page that rendered
 * the form. A server action is addressable by action id, so the page's own auth
 * check is not the gate — this is (see also runJob.ts, which learned the same
 * thing about /admin middleware).
 */
export async function approveAuthorization(
  request: AuthorizationRequest,
): Promise<ConsentDecisionResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return {
      ok: false,
      error: "access_denied",
      description: "Sign in before approving access.",
    };
  }

  try {
    const ticketResponse = await fetch(
      `${getServerShortsApiUrl()}/oauth/consent/ticket`,
      {
        method: "POST",
        headers: internalHeaders(),
        // The user id comes from the SESSION, never from the browser's form.
        body: requestBody(request, userId),
        cache: "no-store",
      },
    );
    if (!ticketResponse.ok) {
      return { ok: false, ...(await readError(ticketResponse)) };
    }
    const { consent_ticket: consentTicket } = (await ticketResponse.json()) as {
      consent_ticket: string;
    };

    // Spend it immediately. The ticket is single-use and short-lived, and it
    // never reaches the browser: the only thing that leaves this function is
    // the redirect URL Go built, which carries a code the CLIENT must still
    // exchange with its PKCE verifier.
    const grantResponse = await fetch(
      `${getServerShortsApiUrl()}/oauth/authorize/grant`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; ShortedConsent)",
        },
        body: JSON.stringify({
          consent_ticket: consentTicket,
          client_id: request.clientId,
          redirect_uri: request.redirectUri,
          code_challenge: request.codeChallenge,
          code_challenge_method: request.codeChallengeMethod,
          resource: request.resource,
          scope: request.scope,
          state: request.state,
        }),
        cache: "no-store",
      },
    );
    if (!grantResponse.ok) {
      return { ok: false, ...(await readError(grantResponse)) };
    }
    const { redirect_to: redirectTo } = (await grantResponse.json()) as {
      redirect_to: string;
    };
    return { ok: true, redirectTo };
  } catch (err) {
    console.error("[oauth] consent approve failed:", err);
    return {
      ok: false,
      error: "temporarily_unavailable",
      description: "Could not reach the authorization server.",
    };
  }
}

/**
 * The deny path (RFC 6749 §4.1.2.1): tell the client, at the URI it registered,
 * that the human said no.
 *
 * The redirect URI is re-validated through describe first. Building this
 * redirect from the query string alone would make the consent screen an open
 * redirector — "click deny" is not a reason to send a browser anywhere the URL
 * asked for.
 */
export async function denyAuthorization(
  request: AuthorizationRequest,
): Promise<ConsentDecisionResult> {
  const described = await describeAuthorizationRequest(request);
  if (!described.ok) {
    return described;
  }

  const url = new URL(described.details.redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set(
    "error_description",
    "The user declined to authorize this client.",
  );
  if (request.state) {
    url.searchParams.set("state", request.state);
  }
  // RFC 9207 applies to the error response too: a client talking to more than
  // one authorization server has to know which one refused.
  url.searchParams.set("iss", described.details.issuer);
  return { ok: true, redirectTo: url.toString() };
}
