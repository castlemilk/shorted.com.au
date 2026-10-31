/**
 * @jest-environment node
 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const DRAWN = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2,
]);

// The in-process fallback: the loader and the renderer stand in.
const mockLoad = jest.fn();
jest.mock("~/app/chart/[code]/image/load-card", () => ({
  loadChartCard: (...args: unknown[]) => mockLoad(...args) as unknown,
}));
jest.mock("next/og", () => ({
  ImageResponse: class {
    arrayBuffer() {
      return Promise.resolve(DRAWN.slice().buffer);
    }
  },
}));
jest.mock("~/@/lib/og/card", () => ({ OG_SIZE: { width: 1200, height: 630 } }));

import { chartCard, neighbours, warmChartCards } from "../chart-card";

const NOW = new Date("2026-10-31T02:00:00Z"); // 31 Oct in Sydney
const STATE = { code: "CBA", view: "combined", period: "6m" } as const;
const CARD_URL =
  "https://shorted.com.au/chart/CBA/image?view=combined&period=6m&v=2026-10-31";

// The global test setup swaps Response for a minimal polyfill; these stand in
// for what fetch answers, with just what chart-card.ts reads.
function answer(
  status: number,
  body: Uint8Array | string,
  headers: Record<string, string> = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    arrayBuffer: async () =>
      typeof body === "string"
        ? new TextEncoder().encode(body).buffer
        : body.slice().buffer,
  };
}

function png(headers: Record<string, string> = {}) {
  return answer(200, PNG, { "content-type": "image/png", ...headers });
}

describe("chartCard", () => {
  const env = process.env;
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...env, SHORTED_SSR_BYPASS_SECRET: "ssr-secret" };
    fetchMock = jest.fn(async () => png({ "x-chart-card": "complete" }));
    global.fetch = fetchMock as unknown as typeof fetch;
    mockLoad.mockReset().mockResolvedValue({ card: null, complete: true });
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => {
    process.env = env;
    global.fetch = realFetch;
  });

  it("takes the share card's cached copy, through Cloudflare as first party", async () => {
    expect(await chartCard(STATE, NOW)).toEqual(PNG);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CARD_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Shorted-Ssr-Bypass"]).toBe("ssr-secret");
    expect(headers["User-Agent"]).toContain("shorted-web-ssr");
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the route answers a partial card",
      () => png({ "x-chart-card": "partial" }),
    ],
    ["Cloudflare challenges it", () => answer(403, "challenge")],
    ["the answer is not an image", () => answer(200, "<html>")],
  ])("draws the card here when %s", async (_label, answer) => {
    fetchMock.mockImplementation(async () => answer());
    expect(await chartCard(STATE, NOW)).toEqual(DRAWN);
    expect(mockLoad).toHaveBeenCalledWith(STATE, expect.any(Number));
  });

  it("draws it here when the fetch fails outright", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    expect(await chartCard(STATE, NOW)).toEqual(DRAWN);
  });

  it("does not ask without the bypass secret, which would only be challenged", async () => {
    delete process.env.SHORTED_SSR_BYPASS_SECRET;
    expect(await chartCard(STATE, NOW)).toEqual(DRAWN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is null when neither gives a whole card", async () => {
    fetchMock.mockImplementation(async () =>
      png({ "x-chart-card": "partial" }),
    );
    mockLoad.mockResolvedValue({ card: null, complete: false });
    expect(await chartCard(STATE, NOW)).toBeNull();
  });
});

describe("warmChartCards", () => {
  const env = process.env;
  const realFetch = global.fetch;
  afterEach(() => {
    process.env = env;
    global.fetch = realFetch;
  });

  it("has the CDN draw every chart one press away", async () => {
    process.env = { ...env, SHORTED_SSR_BYPASS_SECRET: "ssr-secret" };
    const fetchMock = jest.fn(async () => png());
    global.fetch = fetchMock as unknown as typeof fetch;
    await warmChartCards(STATE, NOW);
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(
      ([url]) => url,
    );
    expect(urls.sort()).toEqual(
      neighbours(STATE)
        .map(
          (s) =>
            `https://shorted.com.au/chart/CBA/image?${[
              s.view === "short" ? null : `view=${s.view}`,
              s.period === "1y" ? null : `period=${s.period}`,
            ]
              .filter(Boolean)
              .join("&")}&v=2026-10-31`,
        )
        .sort(),
    );
  });

  it("does nothing without the bypass secret", async () => {
    process.env = { ...env };
    delete process.env.SHORTED_SSR_BYPASS_SECRET;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await warmChartCards(STATE, NOW);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("neighbours", () => {
  it("are the other four periods and the other two views", () => {
    expect(neighbours(STATE)).toEqual([
      { code: "CBA", view: "combined", period: "1m" },
      { code: "CBA", view: "combined", period: "3m" },
      { code: "CBA", view: "combined", period: "1y" },
      { code: "CBA", view: "combined", period: "max" },
      { code: "CBA", view: "short", period: "6m" },
      { code: "CBA", view: "price", period: "6m" },
    ]);
  });
});
