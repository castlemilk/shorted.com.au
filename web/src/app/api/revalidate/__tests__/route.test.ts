import type { NextRequest } from "next/server";

import { POST } from "../route";

const revalidatePathMock = jest.fn();
const revalidateTagMock = jest.fn();
const deleteCachedByPrefixMock = jest.fn().mockResolvedValue(0);

jest.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
  revalidateTag: (...args: unknown[]) => revalidateTagMock(...args),
}));

jest.mock("~/@/lib/kv-cache", () => ({
  deleteCachedByPrefix: (...args: unknown[]) =>
    deleteCachedByPrefixMock(...args),
  HOUSING_DATA_CACHE_PREFIXES: ["cache:housing:"],
  POLITICIANS_DATA_CACHE_PREFIXES: ["cache:politicians:"],
  SHORTS_DATA_CACHE_PREFIXES: ["cache:shorts:"],
}));

describe("POST /api/revalidate", () => {
  const originalSecret = process.env.REVALIDATION_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REVALIDATION_SECRET = "test-revalidation-secret";
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.REVALIDATION_SECRET;
    else process.env.REVALIDATION_SECRET = originalSecret;
  });

  function request(url: string, headerSecret?: string): NextRequest {
    const parsed = new URL(url);
    return {
      nextUrl: { searchParams: parsed.searchParams },
      headers: new Headers(
        headerSecret === undefined
          ? undefined
          : { "X-Revalidate-Secret": headerSecret },
      ),
    } as NextRequest;
  }

  it("accepts the secret from X-Revalidate-Secret", async () => {
    const req = request(
      "http://localhost/api/revalidate?path=/price-drops&flush=housing",
      "test-revalidation-secret",
    );

    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(revalidatePathMock).toHaveBeenCalledWith("/price-drops");
    expect(deleteCachedByPrefixMock).toHaveBeenCalledWith("cache:housing:");
  });

  it("temporarily accepts the legacy query-string secret", async () => {
    const req = request(
      "http://localhost/api/revalidate?secret=test-revalidation-secret&path=/housing",
    );

    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(revalidatePathMock).toHaveBeenCalledWith("/housing");
  });

  it("prefers a supplied header over the legacy query fallback", async () => {
    const req = request(
      "http://localhost/api/revalidate?secret=test-revalidation-secret&path=/housing",
      "wrong",
    );

    const response = await POST(req);

    expect(response.status).toBe(401);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it.each(["wrong", "test-revalidation-secret-extra"])(
    "rejects a mismatched secret without throwing (%s)",
    async (secret) => {
      const req = request(
        "http://localhost/api/revalidate?path=/housing",
        secret,
      );

      const response = await POST(req);

      expect(response.status).toBe(401);
      expect(revalidatePathMock).not.toHaveBeenCalled();
    },
  );
});
