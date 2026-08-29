/**
 * The server card is how MCP clients discover this server. It used to
 * hand-list four tools, three of which no longer exist under those names —
 * exactly the drift Phase 1 hit with the OpenAPI spec. It now renders from
 * the Go server's own catalog, so these tests are about two things: that the
 * catalog actually drives it, and that a catalog outage degrades the card
 * instead of breaking discovery outright.
 */
import { GET } from "../mcp-server-card/route";

const catalogFixture = {
  server: {
    name: "shorted-au-market-data",
    title: "Shorted — Australian market and public-interest data",
    version: "1.0.0",
    description: "Read-only MCP access to Australian market data.",
    protocolVersion: "2026-07-28",
    endpoint: "https://api.shorted.com.au/mcp",
    transport: "streamable-http",
    documentation: "https://shorted.com.au/docs/mcp.md",
    website: "https://shorted.com.au",
    contact: "support@shorted.com.au",
  },
  authentication: { required: false, note: "Anonymous access." },
  toolCount: 2,
  tools: [
    {
      name: "list_top_shorts",
      title: "List most shorted ASX stocks",
      description: "List the most shorted ASX-listed stocks.",
      domain: "market",
      rpc: "shorts.v1alpha1.MarketService.GetTopShorts",
      readOnly: true,
      inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
    },
    {
      name: "get_suburb_profile",
      title: "Suburb profile",
      description: "Prices, Census and overlays for one Australian suburb.",
      domain: "housing",
      rpc: "shorts.v1alpha1.HousingService.GetSuburbProfile",
      readOnly: true,
      inputSchema: { type: "object" },
    },
  ],
  resources: [
    {
      uri: "shorted://guide/reading-the-data",
      name: "reading-the-data",
      title: "Reading Shorted's data",
      description: "How to interpret short-interest figures.",
      mimeType: "text/markdown",
    },
  ],
  prompts: [
    {
      name: "short_interest_briefing",
      title: "Short interest briefing",
      description: "Brief one ASX company's short interest.",
      arguments: [{ name: "ticker", description: "ASX ticker", required: true }],
      tools: ["get_stock"],
    },
  ],
};

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function mockCatalog(body: unknown, ok = true) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 502,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("MCP server card", () => {
  it("renders every tool the catalog holds, not a hand-written list", async () => {
    mockCatalog(catalogFixture);
    const card = await (await GET()).json();

    expect(card.tools).toHaveLength(2);
    expect(card.tools.map((t: { name: string }) => t.name)).toEqual([
      "list_top_shorts",
      "get_suburb_profile",
    ]);
    expect(card.tools[0].description).toBe(
      "List the most shorted ASX-listed stocks.",
    );
    // The input schema travels: a client reading only the card can call the tool.
    expect(card.tools[0].inputSchema).toEqual({
      type: "object",
      properties: { limit: { type: "integer" } },
    });
  });

  it("points at the Go endpoint over streamable HTTP", async () => {
    mockCatalog(catalogFixture);
    const card = await (await GET()).json();

    expect(card.transport.endpoint).toBe("https://api.shorted.com.au/mcp");
    expect(card.transport.type).toBe("streamable-http");
  });

  it("preserves the SEP-1649 shape", async () => {
    mockCatalog(catalogFixture);
    const card = await (await GET()).json();

    expect(card.$schema).toContain("server-card.json");
    expect(card.serverInfo.name).toBe("shorted-au-market-data");
    expect(card.serverInfo.version).toBe("1.0.0");
    expect(card.serverInfo.websiteUrl).toBe("https://shorted.com.au");
    expect(card.capabilities.tools).toEqual({ listChanged: false });
    // Anonymous works. Claiming authentication is REQUIRED would stop every
    // client that has not been through a browser; OAuth is advertised as
    // optional, separately.
    expect(card.authentication).toMatchObject({ required: false });
    expect(card.contact).toBe("support@shorted.com.au");
  });

  it("advertises resources and prompts when the catalog has them", async () => {
    mockCatalog(catalogFixture);
    const card = await (await GET()).json();

    expect(card.capabilities.resources).toEqual({ listChanged: false });
    expect(card.capabilities.prompts).toEqual({ listChanged: false });
    expect(card.resources[0].uri).toBe("shorted://guide/reading-the-data");
    expect(card.prompts[0].name).toBe("short_interest_briefing");
  });

  it("degrades rather than hanging when the catalog never answers", async () => {
    // The one fail-soft mode the original implementation missed. Without a
    // timeout the render blocks until the platform's function timeout, and a
    // promote resets ISR pages to placeholders — so the first request after
    // every deploy takes exactly this path.
    global.fetch = jest.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    ) as unknown as typeof fetch;
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await GET();

    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.degraded).toBe(true);
    expect(card.serverInfo.name).toBe("shorted-au-market-data");
  }, 10_000);

  it("serves a minimal valid card when the catalog fetch fails", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await GET();
    // A 500 here breaks discovery for every client at once. Degrade instead.
    expect(res.status).toBe(200);

    const card = await res.json();
    expect(card.serverInfo.name).toBe("shorted-au-market-data");
    expect(card.transport.endpoint).toBe("https://api.shorted.com.au/mcp");
    expect(card.authentication).toMatchObject({ required: false });
    // Better to advertise no tools than to advertise a stale guess at them.
    expect(card.tools).toEqual([]);
    // And say so, so a client knows the list is incomplete rather than empty.
    expect(card.degraded).toBe(true);
  });

  it("degrades when the catalog responds with a non-OK status", async () => {
    mockCatalog({ error: "bad gateway" }, false);
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const card = await (await GET()).json();
    expect(card.degraded).toBe(true);
    expect(card.tools).toEqual([]);
  });

  it("degrades when the catalog is well-formed JSON but the wrong shape", async () => {
    mockCatalog({ unexpected: true });
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const card = await (await GET()).json();
    expect(card.degraded).toBe(true);
    expect(card.tools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OAuth advertising
//
// The card is what an agent reads before it has spoken to the server at all.
// If it does not say a higher ceiling exists and where the flow starts, the
// only way to find out is to be refused.
// ---------------------------------------------------------------------------

describe("the card's OAuth advertising", () => {
  const catalogWithOAuth = {
    server: { name: "shorted", version: "1.0.0" },
    authentication: {
      required: false,
      note: "Anonymous access.",
      optional: "oauth2",
      protectedResourceMetadata:
        "https://api.shorted.com.au/.well-known/oauth-protected-resource/mcp",
      authorizationServerMetadata:
        "https://api.shorted.com.au/.well-known/oauth-authorization-server",
      scopes: ["shorts:read", "housing:read"],
      rateLimits: {
        unit: "tool call",
        anonymous: "30 per minute, 500 per month",
        free: "60 per minute, 1000 per month",
        paid: "120 per minute, 10000 per month",
        upgradeUrl: "https://shorted.com.au/pricing",
      },
    },
    tools: [],
  };

  it("passes the discovery documents, scopes and quotas through verbatim", async () => {
    mockCatalog(catalogWithOAuth);
    const card = await (await GET()).json();

    expect(card.authentication.required).toBe(false);
    expect(card.authentication.optional).toBe("oauth2");
    expect(card.authentication.protectedResourceMetadata).toBe(
      catalogWithOAuth.authentication.protectedResourceMetadata,
    );
    expect(card.authentication.authorizationServerMetadata).toBe(
      catalogWithOAuth.authentication.authorizationServerMetadata,
    );
    expect(card.authentication.scopes).toEqual(["shorts:read", "housing:read"]);
    // Verbatim, not recomputed: the API derives these from the limiter that
    // enforces them, and a second copy here is a second thing to drift.
    expect(card.authentication.rateLimits).toEqual(
      catalogWithOAuth.authentication.rateLimits,
    );
  });

  // A degraded catalog must not make the server look like it needs a
  // credential it does not — that would stop every anonymous client cold.
  it("never claims authentication is required when the catalog is silent", async () => {
    mockCatalog({ server: { name: "shorted", version: "1.0.0" }, tools: [] });
    const card = await (await GET()).json();
    expect(card.authentication.required).toBe(false);
    expect(card.authentication.optional).toBeUndefined();
  });
});
