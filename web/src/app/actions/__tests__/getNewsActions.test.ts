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
  getMarketNews: jest.fn(),
  getStockNews: jest.fn(),
  getEditorialTake: jest.fn(),
  listEditorialTakes: jest.fn(),
  getRelatedNews: jest.fn(),
};

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (...args: unknown[]) => createConnectTransportMock(...args),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

describe("news server actions", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      SHORTS_SERVICE_ENDPOINT: "https://shorts-prod.run.app",
      NEXT_PUBLIC_API_URL: "https://api.shorted.com.au",
    };
    createConnectTransportMock.mockReturnValue({});
    createClientMock.mockReturnValue(clientMock);
    clientMock.getMarketNews.mockResolvedValue({ articles: [] });
    clientMock.getStockNews.mockResolvedValue({ articles: [] });
    clientMock.getEditorialTake.mockResolvedValue({});
    clientMock.listEditorialTakes.mockResolvedValue({ takes: [] });
    clientMock.getRelatedNews.mockResolvedValue({ articles: [] });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses the direct server endpoint for market news", async () => {
    const { getMarketNews } = await import("../getStockNews");

    await getMarketNews(60, false);

    expect(createConnectTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://shorts-prod.run.app",
        fetch: expect.any(Function),
      }),
    );
    expect(clientMock.getMarketNews).toHaveBeenCalledWith({
      limit: 60,
      priceSensitiveOnly: false,
    });
  });

  it("uses the direct server endpoint for editorial takes", async () => {
    const { listEditorialTakes } = await import("../getEditorialTake");

    await listEditorialTakes(24, 0, "");

    expect(createConnectTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://shorts-prod.run.app",
        fetch: expect.any(Function),
      }),
    );
    expect(clientMock.listEditorialTakes).toHaveBeenCalledWith({
      limit: 24,
      offset: 0,
      stockCode: "",
    });
  });

  it("uses the direct server endpoint for related news", async () => {
    const { getRelatedNews } = await import("../getRelatedNews");

    await getRelatedNews("BHP", 6, "");

    expect(createConnectTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://shorts-prod.run.app",
        fetch: expect.any(Function),
      }),
    );
    expect(clientMock.getRelatedNews).toHaveBeenCalledWith({
      stockCode: "BHP",
      limit: 6,
      articleId: "",
    });
  });
});
