/// <reference types="jest" />
import { TextDecoder, TextEncoder } from "util";

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}

const createConnectTransportMock = jest.fn();
const createClientMock = jest.fn();
const clientMock = {
  getHousingOverview: jest.fn(),
};

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (...args: unknown[]) => createConnectTransportMock(...args),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

describe("housing server actions", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  function withoutTestingBypassEnv() {
    const env = { ...originalEnv };
    delete env.SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET;
    delete env.TF_VAR_rate_limit_testing_bypass_secret;
    return env;
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...withoutTestingBypassEnv(),
      SHORTS_SERVICE_ENDPOINT: "https://shorts-prod.run.app",
      NEXT_PUBLIC_API_URL: "https://api.shorted.com.au",
    };
    createConnectTransportMock.mockReturnValue({});
    createClientMock.mockReturnValue(clientMock);
    clientMock.getHousingOverview.mockResolvedValue({ metrics: [] });
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("uses the direct server endpoint for SSR instead of the Cloudflare API host", async () => {
    const { getHousingOverview } = await import("../getHousing");

    await getHousingOverview("");

    expect(createConnectTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://shorts-prod.run.app",
        fetch: expect.any(Function),
      }),
    );
    expect(clientMock.getHousingOverview).toHaveBeenCalledWith({ regionType: "" });
  });

  it("prefers the public direct-service endpoint over the server Cloudflare API host", async () => {
    delete process.env.SHORTS_SERVICE_ENDPOINT;
    process.env.SHORTS_API_URL = "https://api.shorted.com.au";
    process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT = "https://shorts-prod.run.app";

    const { SERVER_SHORTS_API_URL } = await import("../config");

    expect(SERVER_SHORTS_API_URL).toBe("https://shorts-prod.run.app");
  });

  it("adds the first-party SSR user agent to transport fetches", async () => {
    const { getHousingOverview } = await import("../getHousing");
    await getHousingOverview("");
    const transportFetch = createConnectTransportMock.mock.calls[0]?.[0]?.fetch as typeof fetch;
    const fetchMock = jest.fn().mockResolvedValue(new Response("{}"));
    global.fetch = fetchMock;

    await transportFetch("https://shorts-prod.run.app/health", {
      headers: { "Content-Type": "application/json" },
    });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("User-Agent")).toBe("shorted-web-ssr/1.0 (+https://shorted.com.au)");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("preserves request headers when adding the SSR user agent", async () => {
    const { serverFetchWithUserAgent } = await import("../config");
    const fetchMock = jest.fn().mockResolvedValue(new Response("{}"));
    global.fetch = fetchMock;

    const request = {
      headers: new Headers({ "X-Shorted-Test": "1" }),
    } as Request;

    await serverFetchWithUserAgent(request);

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("User-Agent")).toBe("shorted-web-ssr/1.0 (+https://shorted.com.au)");
    expect(headers.get("X-Shorted-Test")).toBe("1");
  });
});
