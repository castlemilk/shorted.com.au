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
  getSuburbProfile: jest.fn(),
  listStateSuburbs: jest.fn(),
};

const connectError = (code: number, message: string) => Object.assign(new Error(message), {
  code,
  metadata: { get: jest.fn(() => null) },
});

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
    clientMock.getSuburbProfile.mockResolvedValue({ summary: undefined });
    clientMock.listStateSuburbs.mockResolvedValue({ suburbs: [] });
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

  it("resolves already-indexed suburb slugs with one trailing hyphen", async () => {
    clientMock.listStateSuburbs.mockResolvedValue({
      suburbs: [{
        salCode: "206041122",
        salName: "Abbotsford (Vic.)",
        postcode: "",
      }],
    });
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("VIC", "abbotsford-vic-")).resolves.toBe("206041122");
    expect(clientMock.listStateSuburbs).toHaveBeenCalledWith({
      stateCode: "VIC",
      query: "abbotsford",
      limit: 50,
    });
  });

  it("resolves a canonical suburb slug with a narrow name query", async () => {
    clientMock.listStateSuburbs.mockResolvedValue({
      suburbs: [{
        salCode: "20075",
        salName: "Ascot Vale",
        postcode: "3032",
      }],
    });
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("VIC", "ascot-vale-3032")).resolves.toBe("20075");
    expect(clientMock.listStateSuburbs).toHaveBeenCalledWith({
      stateCode: "VIC",
      query: "ascot vale",
      limit: 50,
    });
  });

  it("retries punctuation-normalized names with a bounded final-word query", async () => {
    clientMock.listStateSuburbs.mockImplementation(async ({ query }: { query: string }) => ({
      suburbs: query === "connor"
        ? [{ salCode: "80004", salName: "O'Connor", postcode: "2602" }]
        : [],
    }));
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("ACT", "o-connor-2602")).resolves.toBe("80004");
    expect(clientMock.listStateSuburbs).toHaveBeenNthCalledWith(1, {
      stateCode: "ACT",
      query: "o connor",
      limit: 50,
    });
    expect(clientMock.listStateSuburbs).toHaveBeenNthCalledWith(2, {
      stateCode: "ACT",
      query: "connor",
      limit: 50,
    });
  });

  it("returns null only when a suburb slug is a genuine miss", async () => {
    clientMock.listStateSuburbs.mockResolvedValue({ suburbs: [] });
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("VIC", "not-a-real-suburb")).resolves.toBeNull();
  });

  it("throws when the state suburb index is unavailable", async () => {
    clientMock.listStateSuburbs.mockRejectedValue(connectError(14, "backend unavailable"));
    const { resolveSuburbSalCode } = await import("../getHousing");

    await expect(resolveSuburbSalCode("VIC", "abbotsford-vic")).rejects.toThrow(
      "Unable to resolve suburb slug",
    );
  });

  it("preserves profile NotFound separately from backend unavailability", async () => {
    clientMock.getSuburbProfile.mockRejectedValue(connectError(5, "suburb not found"));
    const { getSuburbProfile } = await import("../getHousing");

    await expect(getSuburbProfile("missing-sal")).rejects.toMatchObject({
      name: "NotFoundError",
      message: "suburb not found",
    });
  });

  it("does not turn a transient profile failure into NotFound", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    clientMock.getSuburbProfile.mockRejectedValue(connectError(14, "backend unavailable"));
    const { getSuburbProfile } = await import("../getHousing");

    await expect(getSuburbProfile("206041122")).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("withRetryAndThrowNotFound"),
      "backend unavailable",
      expect.any(Object),
    );
    consoleError.mockRestore();
  });

  it("keeps the ISR guard on suburb list and profile RPC fetches", async () => {
    const { getSuburbProfile, listStateSuburbs } = await import("../getHousing");
    await listStateSuburbs("VIC", "", 5000);
    await getSuburbProfile("206041122");

    for (const call of createConnectTransportMock.mock.calls.slice(0, 2)) {
      const transportFetch = call[0]?.fetch as typeof fetch;
      const fetchMock = jest.fn().mockResolvedValue(new Response("{}"));
      global.fetch = fetchMock;
      await transportFetch("https://shorts-prod.run.app/shorts.v1alpha1.HousingService/Test", {
        method: "POST",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ next: { revalidate: 86400 } }),
      );
    }
  });
});
