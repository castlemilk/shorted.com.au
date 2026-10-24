import type { NextRequest } from "next/server";

import { POST } from "../route";
import { page, summarise, type AdminUser } from "~/server/admin-users";

const listUsersMock = jest.fn();
const getUserByEmailMock = jest.fn();
const getUserMock = jest.fn();

jest.mock("~/@/lib/firebase-admin", () => ({
  adminAuth: {
    listUsers: (...args: unknown[]) => listUsersMock(...args),
    getUserByEmail: (...args: unknown[]) => getUserByEmailMock(...args),
    getUser: (...args: unknown[]) => getUserMock(...args),
  },
}));

const record = (uid: string, over: Record<string, unknown> = {}) => ({
  uid,
  email: `${uid}@example.test`,
  emailVerified: true,
  disabled: false,
  displayName: "Should Not Leak",
  phoneNumber: "+61400000000",
  providerData: [{ providerId: "google.com" }],
  metadata: {
    creationTime: "Wed, 01 Oct 2026 00:00:00 GMT",
    lastSignInTime: "Tue, 14 Oct 2026 00:00:00 GMT",
  },
  ...over,
});

describe("POST /api/internal/admin-users", () => {
  const originalSecret = process.env.INTERNAL_SERVICE_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INTERNAL_SERVICE_SECRET = "internal-secret";
  });

  afterAll(() => {
    if (originalSecret === undefined)
      delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
  });

  function request(
    body: unknown,
    headers: Record<string, string> = {
      "x-internal-secret": "internal-secret",
    },
  ): NextRequest {
    return {
      headers: new Headers(headers),
      json: async () => body,
    } as unknown as NextRequest;
  }

  it("refuses a caller without the internal secret", async () => {
    for (const headers of [{}, { "x-internal-secret": "wrong" }]) {
      const res = await POST(request({ action: "summary" }, headers));
      expect(res.status).toBe(403);
    }
    delete process.env.INTERNAL_SERVICE_SECRET;
    expect((await POST(request({ action: "summary" }))).status).toBe(403);
    expect(listUsersMock).not.toHaveBeenCalled();
  });

  it("lists a page with only the minimal fields", async () => {
    listUsersMock
      .mockResolvedValueOnce({
        users: [record("a"), record("b")],
        pageToken: "next",
      })
      .mockResolvedValueOnce({
        users: [
          record("c", {
            metadata: { creationTime: "Thu, 15 Oct 2026 00:00:00 GMT" },
          }),
        ],
      });
    const res = await POST(request({ action: "list", limit: 2, offset: 0 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.truncated).toBe(false);
    expect(body.users.map((u: AdminUser) => u.uid)).toEqual(["c", "a"]);
    expect(Object.keys(body.users[1]).sort()).toEqual([
      "createdAt",
      "disabled",
      "email",
      "emailVerified",
      "lastSignInAt",
      "providers",
      "uid",
    ]);
    expect(JSON.stringify(body)).not.toContain("Should Not Leak");
  });

  it("looks up one email, and answers null for an unknown one", async () => {
    getUserByEmailMock.mockResolvedValueOnce(record("a"));
    let body = await (
      await POST(request({ action: "lookup", email: " A@Example.test " }))
    ).json();
    expect(getUserByEmailMock).toHaveBeenCalledWith("a@example.test");
    expect(body.user.uid).toBe("a");

    getUserByEmailMock.mockRejectedValueOnce({ code: "auth/user-not-found" });
    body = await (
      await POST(request({ action: "lookup", email: "x@example.test" }))
    ).json();
    expect(body.user).toBeNull();
  });

  it("looks up one uid with the same shape as an email, and answers null for an unknown one", async () => {
    getUserMock.mockResolvedValueOnce(record("uid_A-9"));
    let res = await POST(request({ action: "lookup", uid: "uid_A-9" }));
    let body = await res.json();
    expect(res.status).toBe(200);
    expect(getUserMock).toHaveBeenCalledWith("uid_A-9");
    expect(getUserByEmailMock).not.toHaveBeenCalled();
    expect(body.user).toEqual({
      uid: "uid_A-9",
      email: "uid_A-9@example.test",
      emailVerified: true,
      disabled: false,
      providers: ["google.com"],
      createdAt: "2026-10-01T00:00:00.000Z",
      lastSignInAt: "2026-10-14T00:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain("Should Not Leak");

    getUserMock.mockRejectedValueOnce({ code: "auth/user-not-found" });
    res = await POST(request({ action: "lookup", uid: "gone" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  it("takes exactly one of email or uid", async () => {
    for (const body of [
      { action: "lookup" },
      { action: "lookup", email: "a@example.test", uid: "a" },
      { action: "lookup", email: null, uid: "a" },
      { action: "lookup", email: "", uid: "a" },
    ]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect(getUserMock).not.toHaveBeenCalled();
    expect(getUserByEmailMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed uid before Firebase is asked", async () => {
    for (const uid of [
      "",
      " uid",
      "uid ",
      "a/b",
      "a.b",
      "a@b",
      "uid;drop",
      "x".repeat(129),
      42,
      null,
      ["uid"],
    ]) {
      const res = await POST(request({ action: "lookup", uid }));
      expect(res.status).toBe(400);
    }
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("accepts a uid of exactly 128 characters", async () => {
    getUserMock.mockResolvedValueOnce(record("u".repeat(128)));
    const res = await POST(request({ action: "lookup", uid: "u".repeat(128) }));
    expect(res.status).toBe(200);
  });

  it("reports a Firebase failure as 503, and bad input as 400", async () => {
    listUsersMock.mockRejectedValueOnce(new Error("boom"));
    expect((await POST(request({ action: "summary" }))).status).toBe(503);
    expect((await POST(request({ action: "list", limit: 500 }))).status).toBe(
      400,
    );
    expect((await POST(request({ action: "delete" }))).status).toBe(400);
  });
});

describe("admin-users helpers", () => {
  const now = Date.parse("2026-10-15T00:00:00Z");
  const user = (
    uid: string,
    createdAt: string,
    over: Partial<AdminUser> = {},
  ): AdminUser => ({
    uid,
    email: `${uid}@x.test`,
    emailVerified: true,
    disabled: false,
    providers: ["password"],
    createdAt,
    ...over,
  });

  it("summarises recency, verification and providers", () => {
    const s = summarise(
      [
        user("a", "2026-10-14T00:00:00Z", {
          lastSignInAt: "2026-10-14T00:00:00Z",
        }),
        user("b", "2026-09-20T00:00:00Z", {
          emailVerified: false,
          providers: ["google.com", "password"],
        }),
        user("c", "2025-01-01T00:00:00Z", { disabled: true }),
      ],
      true,
      now,
    );
    expect(s).toMatchObject({
      total: 3,
      emailVerified: 2,
      disabled: 1,
      signedUpLast7Days: 1,
      signedUpLast30Days: 2,
      signedInLast30Days: 1,
      byProvider: { password: 3, "google.com": 1 },
      truncated: true,
    });
  });

  it("filters by email substring and pages newest first", () => {
    const users = [
      user("old", "2025-01-01T00:00:00Z"),
      user("new", "2026-10-01T00:00:00Z", { email: "new@corp.test" }),
    ];
    expect(
      page(users, {
        query: "CORP",
        sort: "newest",
        limit: 10,
        offset: 0,
      }).users.map((u) => u.uid),
    ).toEqual(["new"]);
    expect(
      page(users, { query: "", sort: "newest", limit: 1, offset: 1 }),
    ).toEqual({ users: [users[0]], total: 2 });
  });
});
