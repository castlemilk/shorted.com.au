/**
 * The console's market-moves token actions: each gates on requireAdmin() before
 * it reaches the API, sends the internal secret and the admin's address, and
 * hands a created token back once without keeping it.
 */

const ADMIN = { email: "ben@shorted.com.au", userId: "uid-admin" };
const mockRequireAdmin = jest.fn();
const mockRevalidatePath = jest.fn();

jest.mock("~/server/admin", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
jest.mock("~/app/actions/config", () => ({
  SERVER_SHORTS_API_URL: "https://shorts.test",
}));
jest.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

import {
  createMarketMovesToken,
  listMarketMovesTokens,
  revokeMarketMovesToken,
} from "../marketMovesTokens";

const wireToken = {
  id: 7,
  name: "Claude routine",
  prefix: "smm_abcdef",
  status: "active",
  created_by: "ben@shorted.com.au",
  created_at: "2026-11-07T06:00:00Z",
  expires_at: "2027-02-05T06:00:00Z",
  last_used_at: null,
  revoked_at: null,
};

const fetchMock = jest.fn();

function answer(status: number, body: unknown) {
  return Promise.resolve({ status, json: () => Promise.resolve(body) } as Response);
}

beforeAll(() => {
  process.env.INTERNAL_SERVICE_SECRET = "test-internal-secret";
  global.fetch = fetchMock as unknown as typeof fetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(ADMIN);
});

describe("listMarketMovesTokens", () => {
  it("asks the API as the verified admin and maps every field", async () => {
    fetchMock.mockReturnValueOnce(answer(200, { tokens: [wireToken], max_active: 10 }));
    const list = await listMarketMovesTokens();
    expect(mockRequireAdmin).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://shorts.test/api/admin/market-moves/tokens");
    expect(init.method).toBe("GET");
    expect(init.headers["x-internal-secret"]).toBe("test-internal-secret");
    expect(init.headers["x-admin-actor"]).toBe("ben@shorted.com.au");
    expect(init.cache).toBe("no-store");
    expect(list).toEqual({
      ok: true,
      maxActive: 10,
      tokens: [
        {
          id: 7,
          name: "Claude routine",
          prefix: "smm_abcdef",
          status: "active",
          createdBy: "ben@shorted.com.au",
          createdAt: "2026-11-07T06:00:00Z",
          expiresAt: "2027-02-05T06:00:00Z",
          lastUsedAt: null,
          revokedAt: null,
          revokedBy: null,
        },
      ],
    });
  });

  it("says why when the API cannot answer", async () => {
    fetchMock.mockReturnValueOnce(answer(503, { error: "unavailable", message: "tokens are not available" }));
    expect(await listMarketMovesTokens()).toEqual({ ok: false, tokens: [], maxActive: 0, error: "tokens are not available" });
  });

  it("never reaches the API for someone who is not an admin", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT /?adminDenied=1"));
    await expect(listMarketMovesTokens()).rejects.toThrow("NEXT_REDIRECT");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createMarketMovesToken", () => {
  it("returns the token once with its metadata", async () => {
    fetchMock.mockReturnValueOnce(answer(201, { token: "smm_secret", meta: wireToken }));
    const res = await createMarketMovesToken({ name: "Claude routine", expiresInDays: 365 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "Claude routine", expires_in_days: 365 });
    expect(res).toMatchObject({ ok: true, secret: "smm_secret", token: { id: 7, prefix: "smm_abcdef" } });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/market-moves");
  });

  it("sends only an expiry the console offers", async () => {
    fetchMock.mockReturnValueOnce(answer(201, { token: "smm_secret", meta: wireToken }));
    await createMarketMovesToken({ name: "x", expiresInDays: 9999 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).expires_in_days).toBe(90);
  });

  it("passes the API's field errors through", async () => {
    fetchMock.mockReturnValueOnce(
      answer(422, { error: "invalid_token_request", message: "the token was not created", fields: [{ field: "name", message: "required" }] }),
    );
    expect(await createMarketMovesToken({ name: "", expiresInDays: 90 })).toEqual({
      ok: false,
      error: "the token was not created",
      fields: [{ field: "name", message: "required" }],
    });
  });

  it("does not log the token when the call fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    const res = await createMarketMovesToken({ name: "x", expiresInDays: 90 });
    expect(res).toMatchObject({ ok: false });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("smm_");
    spy.mockRestore();
  });
});

describe("revokeMarketMovesToken", () => {
  it("revokes by id", async () => {
    fetchMock.mockReturnValueOnce(answer(200, { meta: { ...wireToken, status: "revoked", revoked_at: "2026-11-08T00:00:00Z", revoked_by: "ben@shorted.com.au" } }));
    const res = await revokeMarketMovesToken(7);
    expect(fetchMock.mock.calls[0][0]).toBe("https://shorts.test/api/admin/market-moves/tokens/revoke");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: 7 });
    expect(res).toMatchObject({ ok: true, token: { status: "revoked", revokedBy: "ben@shorted.com.au" } });
  });

  it("refuses an id that is not one without a request", async () => {
    expect(await revokeMarketMovesToken(-1)).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
