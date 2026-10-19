/** @jest-environment node */
import type { NextRequest } from "next/server";

jest.mock("~/app/actions/config", () => ({
  getServerShortsApiUrl: () => "https://api.example.test",
}));

const HOURLY =
  "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400";

let GET: typeof import("../route").GET;

beforeAll(async () => {
  // src/test/setup.ts swaps Response and Headers for a polyfill that keeps
  // the last of two keys differing only in case, which hides exactly this
  // defect. Put Node's own back (fetch still returns them) before next/og
  // runs `class ImageResponse extends Response`.
  const NativeResponse = (await fetch("data:,")).constructor as typeof Response;
  const NativeHeaders = new NativeResponse().headers
    .constructor as typeof Headers;
  globalThis.Response = NativeResponse;
  globalThis.Headers = NativeHeaders;

  jest.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new NativeResponse(
        JSON.stringify({
          timeSeries: [
            {
              productCode: "PLS",
              name: "PILBARA MINERALS",
              latestShortPosition: 21.4,
            },
            { productCode: "LTR", name: "LIONTOWN", latestShortPosition: 15.2 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  ({ GET } = await import("../route"));
});

afterAll(() => jest.restoreAllMocks());

describe("GET /api/og/twitter/[type]", () => {
  it("runs against Headers that join case-variant keys, as production does", () => {
    expect(
      new Headers({ "cache-control": "a", "Cache-Control": "b" }).get(
        "cache-control",
      ),
    ).toBe("a, b");
  });

  it.each(["top-shorts", "stock-of-day"])(
    "serves %s with one hourly cache-control, never Next's immutable default",
    async (type) => {
      const res = await GET({} as NextRequest, {
        params: Promise.resolve({ type }),
      });

      // NODE_ENV is "test" here, so ImageResponse starts from its production
      // default ("public, immutable, no-transform, max-age=31536000").
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe(HOURLY);
      expect(res.headers.get("cache-control")).not.toMatch(/immutable/);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.example.test/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
        expect.objectContaining({ method: "POST" }),
      );
    },
  );
});
