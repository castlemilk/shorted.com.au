const ADMIN = "ben@shorted.com.au";

const mockAuth = jest.fn();
const mockRedirect = jest.fn();

jest.mock("@/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

jest.mock("next/navigation", () => ({
  // next's redirect() throws to unwind the render. The mock does the same.
  redirect: (url: string) => {
    mockRedirect(url);
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

type AdminModule = typeof import("~/server/admin");
let admin: AdminModule;

beforeAll(async () => {
  // ADMIN_EMAILS is read when the module loads, so it is set first.
  process.env.ADMIN_EMAILS = `${ADMIN},e2e-test@shorted.com.au`;
  admin = await import("~/server/admin");
});

function signedInAs(user: Record<string, unknown>) {
  mockAuth.mockResolvedValue({ user });
}

describe("requireAdmin", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("admits a verified allowlisted admin", async () => {
    signedInAs({ id: "uid-1", email: ADMIN, emailVerified: true });

    await expect(admin.requireAdmin()).resolves.toEqual({
      email: ADMIN,
      userId: "uid-1",
    });
  });

  it("refuses an unverified account under an admin's address the same as a non-admin", async () => {
    signedInAs({ id: "uid-2", email: ADMIN, emailVerified: false });

    await expect(admin.requireAdmin()).rejects.toThrow(
      "NEXT_REDIRECT /?adminDenied=1",
    );
    expect(mockRedirect).toHaveBeenCalledWith("/?adminDenied=1");
  });

  it("refuses a session minted before the verified flag was recorded", async () => {
    signedInAs({ id: "uid-1", email: ADMIN });

    await expect(admin.requireAdmin()).rejects.toThrow(
      "NEXT_REDIRECT /?adminDenied=1",
    );
  });

  it("refuses a verified account that is not on the allowlist", async () => {
    signedInAs({
      id: "uid-3",
      email: "someone@example.com",
      emailVerified: true,
    });

    await expect(admin.requireAdmin()).rejects.toThrow(
      "NEXT_REDIRECT /?adminDenied=1",
    );
  });
});

describe("the E2E identity", () => {
  it("is an admin only in a development or test runtime, even when it is on ADMIN_EMAILS", async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    signedInAs({
      id: "uid-e2e",
      email: "e2e-test@shorted.com.au",
      emailVerified: true,
    });
    try {
      process.env.NODE_ENV = "production";
      await expect(admin.isAdmin()).resolves.toBe(false);
      expect(admin.isAdminEmail("e2e-test@shorted.com.au")).toBe(false);

      process.env.NODE_ENV = "test";
      await expect(admin.isAdmin()).resolves.toBe(true);
    } finally {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });
});

describe("isAdmin", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("is true only for a verified allowlisted address", async () => {
    signedInAs({ id: "uid-1", email: ADMIN, emailVerified: true });
    await expect(admin.isAdmin()).resolves.toBe(true);

    signedInAs({ id: "uid-2", email: ADMIN, emailVerified: false });
    await expect(admin.isAdmin()).resolves.toBe(false);

    signedInAs({ id: "uid-3", email: ADMIN });
    await expect(admin.isAdmin()).resolves.toBe(false);
  });
});
