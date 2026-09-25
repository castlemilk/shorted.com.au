import type { NextRequest } from "next/server";

import { POST } from "../route";

const getUserMock = jest.fn();

jest.mock("~/@/lib/firebase-admin", () => ({
  adminAuth: { getUser: (...args: unknown[]) => getUserMock(...args) },
}));

jest.mock("~/server/admin", () => ({
  isAdminEmail: (email?: string | null) =>
    !!email && email.toLowerCase() === "admin@example.test",
}));

describe("POST /api/internal/admin-check", () => {
  const originalSecret = process.env.INTERNAL_SERVICE_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INTERNAL_SERVICE_SECRET = "internal-secret";
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
  });

  function request(body: unknown, headers: Record<string, string> = { "x-internal-secret": "internal-secret" }): NextRequest {
    return {
      headers: new Headers(headers),
      json: async () => body,
    } as unknown as NextRequest;
  }

  const user = (over: Record<string, unknown> = {}) => ({
    uid: "uid-1",
    email: "admin@example.test",
    emailVerified: true,
    disabled: false,
    ...over,
  });

  it("refuses a caller without the internal secret", async () => {
    for (const headers of [{}, { "x-internal-secret": "wrong" }, { authorization: "Bearer wrong" }]) {
      const res = await POST(request({ user_id: "uid-1" }, headers));
      expect(res.status).toBe(403);
    }
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("fails closed when the secret is not configured", async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    const res = await POST(request({ user_id: "uid-1" }, { "x-internal-secret": "" }));
    expect(res.status).toBe(403);
  });

  it("accepts the secret as a Bearer token too", async () => {
    getUserMock.mockResolvedValue(user());
    const res = await POST(request({ user_id: "uid-1" }, { authorization: "Bearer internal-secret" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ admin: true });
  });

  it("says yes only for a verified, enabled, allowlisted account", async () => {
    getUserMock.mockResolvedValue(user());
    await expect((await POST(request({ user_id: "uid-1" }))).json()).resolves.toEqual({ admin: true });

    for (const over of [
      { emailVerified: false },
      { disabled: true },
      { email: "someone@example.test" },
      { email: undefined },
    ]) {
      getUserMock.mockResolvedValue(user(over));
      const res = await POST(request({ user_id: "uid-1" }));
      await expect(res.json()).resolves.toEqual({ admin: false });
    }
  });

  it("treats an unknown uid as a definite no", async () => {
    getUserMock.mockRejectedValue({ code: "auth/user-not-found" });
    const res = await POST(request({ user_id: "uid-404" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ admin: false });
  });

  it("reports a lookup failure as a failure, not a no", async () => {
    getUserMock.mockRejectedValue(new Error("network"));
    const res = await POST(request({ user_id: "uid-1" }));
    expect(res.status).toBe(503);
  });

  it("validates the uid before looking it up", async () => {
    for (const body of [{}, { user_id: "" }, { user_id: "../x" }, { user_id: 42 }]) {
      const res = await POST(request(body));
      expect(res.status).toBe(400);
    }
    expect(getUserMock).not.toHaveBeenCalled();
  });
});
