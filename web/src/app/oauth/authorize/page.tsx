import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import {
  describeAuthorizationRequest,
  type AuthorizationRequest,
} from "./actions";
import { ConsentScreen } from "./consent-screen";

/**
 * The OAuth 2.1 consent screen — the one part of the authorization server that
 * needs a browser and a human.
 *
 * An MCP client (Claude Desktop, ChatGPT, anything speaking the protocol) opens
 * this URL after discovering it in /.well-known/oauth-authorization-server. The
 * human sees which client is asking, where the credential will be delivered and
 * what it will be able to read, and either approves or declines. Approving is
 * what mints the consent ticket that Go's grant endpoint requires.
 *
 * Rendering rules, both load-bearing:
 *  - DYNAMIC. It reads searchParams and a session; there is nothing here to
 *    cache and caching it would serve one person's authorization request to
 *    another.
 *  - NOINDEX. These URLs contain a client's PKCE challenge and state. They are
 *    not content, and an indexed one is a permanent record of somebody's
 *    in-flight authorization.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Authorize access",
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

function one(params: SearchParams, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) {
    // A repeated OAuth parameter is not a thing a legitimate client sends, and
    // guessing which copy was meant is how a screen ends up describing one
    // request and approving another. Take neither.
    return "";
  }
  return value ?? "";
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  const request: AuthorizationRequest = {
    clientId: one(params, "client_id"),
    redirectUri: one(params, "redirect_uri"),
    codeChallenge: one(params, "code_challenge"),
    // RFC 7636 §4.3 makes an omitted method mean "plain", which Go refuses.
    // Passing the empty string through rather than defaulting to S256 keeps
    // that refusal visible instead of silently upgrading a client's request.
    codeChallengeMethod: one(params, "code_challenge_method"),
    resource: one(params, "resource"),
    scope: one(params, "scope"),
    state: one(params, "state"),
  };

  // Sign-in first, and return HERE with every parameter intact. A consent
  // screen that loses the request on the way through sign-in is a flow that
  // dead-ends for every user who was not already signed in — which, for a
  // first-time MCP connection, is most of them.
  const session = await auth();
  if (!session?.user?.id) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string") query.set(key, value);
    }
    const returnTo = `/oauth/authorize?${query.toString()}`;
    redirect(`/signin?callbackUrl=${encodeURIComponent(returnTo)}`);
  }

  const described = await describeAuthorizationRequest(request);

  return (
    <ConsentScreen
      request={request}
      described={described}
      userEmail={session.user.email ?? null}
    />
  );
}
