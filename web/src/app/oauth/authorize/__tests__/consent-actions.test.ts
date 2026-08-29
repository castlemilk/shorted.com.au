/**
 * The consent screen's server side.
 *
 * These tests are about ONE property: the browser cannot cause a consent
 * ticket to exist. Everything else here (describe, deny) is supporting cast.
 */

const mockAuth = jest.fn();

jest.mock("~/server/auth", () => ({
  auth: () => mockAuth() as unknown,
}));

jest.mock("~/app/actions/config", () => ({
  getServerShortsApiUrl: () => "https://api.test",
}));

import {
  approveAuthorization,
  denyAuthorization,
  describeAuthorizationRequest,
  type AuthorizationRequest,
} from "../actions";

const request: AuthorizationRequest = {
  clientId: "client-abc",
  redirectUri: "http://127.0.0.1:51763/callback",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  codeChallengeMethod: "S256",
  resource: "https://api.test/mcp",
  scope: "shorts:read housing:read",
  state: "opaque-state",
};

const describeBody = {
  issuer: "https://api.test",
  client_id: "client-abc",
  client_name: "Claude Desktop",
  redirect_uri: "http://127.0.0.1:51763/callback",
  scope: "shorts:read housing:read",
  scopes: [
    { scope: "shorts:read", description: "Read short positions" },
    { scope: "housing:read", description: "Read house prices" },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Records every outbound call so a test can assert what did NOT happen. */
function stubFetch(handlers: Record<string, () => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected fetch to ${path}`);
    return handler();
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "uid-1", email: "a@example.test" } });
});

describe("describeAuthorizationRequest", () => {
  it("renders what the authorization server says, not what the URL claims", async () => {
    stubFetch({
      "/oauth/consent/describe": () => jsonResponse(200, describeBody),
    });

    const result = await describeAuthorizationRequest(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.details.clientName).toBe("Claude Desktop");
    expect(result.details.redirectUri).toBe("http://127.0.0.1:51763/callback");
    expect(result.details.scopes).toHaveLength(2);
  });

  it("carries the internal secret, which is what makes the endpoint reachable", async () => {
    const calls = stubFetch({
      "/oauth/consent/describe": () => jsonResponse(200, describeBody),
    });
    await describeAuthorizationRequest(request);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-internal-secret"]).toBeTruthy();
    expect(headers.Authorization).toContain("Bearer ");
  });

  it("surfaces the server's refusal instead of inventing one", async () => {
    stubFetch({
      "/oauth/consent/describe": () =>
        jsonResponse(400, {
          error: "invalid_request",
          error_description: "redirect_uri does not exactly match",
        }),
    });

    const result = await describeAuthorizationRequest(request);
    expect(result).toEqual({
      ok: false,
      error: "invalid_request",
      description: "redirect_uri does not exactly match",
    });
  });
});

describe("approveAuthorization", () => {
  it("mints a ticket with the SESSION's user, never a browser-supplied one", async () => {
    const calls = stubFetch({
      "/oauth/consent/ticket": () =>
        jsonResponse(200, { consent_ticket: "ticket-value", expires_in: 120 }),
      "/oauth/authorize/grant": () =>
        jsonResponse(200, { redirect_to: "http://127.0.0.1:51763/callback?code=x" }),
    });

    const result = await approveAuthorization({
      ...request,
      // Even if the caller smuggles one in, the action must not use it.
      ...({ userId: "uid-attacker" } as Partial<AuthorizationRequest>),
    });

    expect(result).toEqual({
      ok: true,
      redirectTo: "http://127.0.0.1:51763/callback?code=x",
    });
    const ticketBody = JSON.parse(calls[0]!.init.body as string) as {
      user_id: string;
    };
    expect(ticketBody.user_id).toBe("uid-1");
  });

  // The gate. A server action is addressable by action id, so the page's own
  // session check is not what protects this.
  it("refuses without a session, and calls nothing", async () => {
    mockAuth.mockResolvedValue(null);
    const calls = stubFetch({});

    const result = await approveAuthorization(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("access_denied");
    expect(calls).toHaveLength(0);
  });

  it("never returns the consent ticket to the browser", async () => {
    stubFetch({
      "/oauth/consent/ticket": () =>
        jsonResponse(200, { consent_ticket: "ticket-value", expires_in: 120 }),
      "/oauth/authorize/grant": () =>
        jsonResponse(200, { redirect_to: "http://127.0.0.1:51763/callback?code=x" }),
    });

    const result = await approveAuthorization(request);
    expect(JSON.stringify(result)).not.toContain("ticket-value");
  });

  it("does not attempt a grant when the ticket was refused", async () => {
    const calls = stubFetch({
      "/oauth/consent/ticket": () =>
        jsonResponse(403, {
          error: "access_denied",
          error_description: "callable only by the consent screen",
        }),
    });

    const result = await approveAuthorization(request);
    expect(result.ok).toBe(false);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/oauth/consent/ticket",
    ]);
  });

  it("reports a grant refusal rather than redirecting anyway", async () => {
    stubFetch({
      "/oauth/consent/ticket": () =>
        jsonResponse(200, { consent_ticket: "ticket-value" }),
      "/oauth/authorize/grant": () =>
        jsonResponse(401, {
          error: "access_denied",
          error_description: "the consent ticket is not valid",
        }),
    });

    const result = await approveAuthorization(request);
    expect(result).toEqual({
      ok: false,
      error: "access_denied",
      description: "the consent ticket is not valid",
    });
  });
});

describe("denyAuthorization", () => {
  it("returns the client's registered URI with error, state and iss", async () => {
    stubFetch({
      "/oauth/consent/describe": () => jsonResponse(200, describeBody),
    });

    const result = await denyAuthorization(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const url = new URL(result.redirectTo);
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:51763/callback");
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("opaque-state");
    // RFC 9207 — the client must know which authorization server refused.
    expect(url.searchParams.get("iss")).toBe("https://api.test");
  });

  // Deny must not be an open redirect: the destination comes from the
  // validated registration, not from the query string.
  it("redirects to the REGISTERED uri, not the one in the request", async () => {
    stubFetch({
      "/oauth/consent/describe": () => jsonResponse(200, describeBody),
    });

    const result = await denyAuthorization({
      ...request,
      redirectUri: "https://evil.example/steal",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.redirectTo).toContain("127.0.0.1:51763");
    expect(result.redirectTo).not.toContain("evil.example");
  });

  it("sends nobody anywhere when the request is not valid", async () => {
    stubFetch({
      "/oauth/consent/describe": () =>
        jsonResponse(400, {
          error: "invalid_client",
          error_description: "unknown client_id",
        }),
    });

    const result = await denyAuthorization(request);
    expect(result.ok).toBe(false);
  });
});
