import type { NextRequest } from "next/server";

import { POST } from "../route";

const revalidatePathMock = jest.fn();
const revalidateTagMock = jest.fn();
const deleteCachedByPrefixMock = jest
  .fn()
  .mockResolvedValue({ deleted: 0, errors: [], scanIterations: 0 });

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
    deleteCachedByPrefixMock.mockResolvedValue({ deleted: 0, errors: [], scanIterations: 0 });
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

  it("reports a successful flush as revalidated with no errors", async () => {
    deleteCachedByPrefixMock.mockResolvedValue({ deleted: 7, errors: [], scanIterations: 3 });
    const req = request(
      "http://localhost/api/revalidate?flush=shorts",
      "test-revalidation-secret",
    );

    const response = await POST(req);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.revalidated).toBe(true);
    expect(body.flushedKeys).toBe(7);
    expect(body.flushErrors).toEqual([]);
  });

  // The 2026-08-21 freeze: Upstash rejected every DEL while still serving reads,
  // the flush swallowed the error and returned 0, and this route kept answering
  // `revalidated: true`. HTTP stays 200 (callers are best-effort) but the body
  // must be honest.
  it("surfaces flush failures in the body while keeping HTTP 200", async () => {
    deleteCachedByPrefixMock.mockResolvedValue({
      deleted: 0,
      errors: ["cache:shorts:: ERR max requests limit exceeded"],
      scanIterations: 1,
    });
    const req = request(
      "http://localhost/api/revalidate?path=/top&flush=shorts",
      "test-revalidation-secret",
    );

    const response = await POST(req);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.revalidated).toBe(false);
    expect(body.flushedKeys).toBe(0);
    expect(body.flushErrors).toEqual([
      "cache:shorts:: ERR max requests limit exceeded",
    ]);
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
