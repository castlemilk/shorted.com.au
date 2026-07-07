import {
  buildEdgeReadUrl,
  fetchEdgeReadJson,
  getEdgeReadApiUrl,
} from "../edgeRead";

describe("edgeRead", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.SHORTED_EDGE_API_URL;
    delete process.env.SHORTED_ENABLE_EDGE_READS;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET;
    delete process.env.TF_VAR_rate_limit_testing_bypass_secret;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("stays disabled by default for local development", () => {
    expect(getEdgeReadApiUrl()).toBeUndefined();
  });

  it("uses an explicit edge API base URL when configured", () => {
    process.env.SHORTED_EDGE_API_URL = " https://api.shorted.com.au/ ";

    expect(getEdgeReadApiUrl()).toBe("https://api.shorted.com.au");
  });

  it("auto-enables on Vercel only when the Cloudflare testing bypass secret is available", () => {
    process.env.VERCEL = "1";

    expect(getEdgeReadApiUrl()).toBeUndefined();

    process.env.SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET = "secret";

    expect(getEdgeReadApiUrl()).toBe("https://api.shorted.com.au");
  });

  it("builds stable edge read URLs from path and query parameters", () => {
    expect(
      buildEdgeReadUrl("https://api.shorted.com.au", "/edge/v1/stock/BHP/data", {
        period: "3m",
        empty: "",
        missing: undefined,
      }),
    ).toBe("https://api.shorted.com.au/edge/v1/stock/BHP/data?period=3m");
  });

  it("returns parsed JSON for successful edge reads", async () => {
    process.env.SHORTED_EDGE_API_URL = "https://api.shorted.com.au";
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ productCode: "BHP" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      fetchEdgeReadJson<{ productCode: string }>("/edge/v1/stock/BHP"),
    ).resolves.toEqual({ productCode: "BHP" });

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe("https://api.shorted.com.au/edge/v1/stock/BHP");
    expect(init.method).toBe("GET");
  });

  it("returns undefined so callers can fall back when edge reads fail", async () => {
    process.env.SHORTED_EDGE_API_URL = "https://api.shorted.com.au";
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response("<html>challenge</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(fetchEdgeReadJson("/edge/v1/stock/BHP")).resolves.toBeUndefined();
  });
});
