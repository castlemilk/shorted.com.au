import type { User } from "next-auth";
import type { JWT } from "next-auth/jwt";

const mockVerifyIdToken = jest.fn();
const mockGetUser = jest.fn();

jest.mock("@/lib/firebase-admin", () => ({
  adminAuth: {
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
    getUser: (...args: unknown[]) => mockGetUser(...args),
  },
}));

// next-auth builds its handlers when auth.ts loads. These tests need only the
// options object, so the library is replaced with an inert stand-in.
jest.mock("next-auth", () => ({
  __esModule: true,
  default: () => ({
    handlers: {},
    auth: jest.fn(),
    signIn: jest.fn(),
    signOut: jest.fn(),
  }),
}));

jest.mock("next-auth/providers/credentials", () => ({
  __esModule: true,
  default: (options: unknown) => options,
}));

import { authOptions } from "~/server/auth";

type CredentialsProvider = {
  authorize: (
    credentials: Record<string, string | undefined>,
  ) => Promise<(User & { emailVerified?: boolean }) | null>;
};

const provider = authOptions.providers[0] as unknown as CredentialsProvider;

function jwt(token: JWT, user?: Record<string, unknown>): Promise<JWT> {
  return authOptions.callbacks.jwt({
    token,
    user: user as unknown as User | undefined,
  });
}

describe("authorize: Firebase ID token", () => {
  beforeEach(() => {
    mockVerifyIdToken.mockReset();
  });

  it("reports the email verdict Firebase gave for the token", async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: "uid-1",
      email: "ben@shorted.com.au",
      email_verified: true,
    });

    await expect(provider.authorize({ idToken: "t" })).resolves.toMatchObject({
      id: "uid-1",
      emailVerified: true,
    });
  });

  it("never takes the session email from the client-supplied credentials", async () => {
    // An anonymous account's token has no email claim. The caller then chooses an
    // address in the credentials. That address must not become the session email.
    mockVerifyIdToken.mockResolvedValue({ uid: "uid-anon" });

    const user = await provider.authorize({
      idToken: "t",
      email: "victim@x.example",
    });
    expect(user).toMatchObject({
      id: "uid-anon",
      email: null,
      emailVerified: false,
    });

    const token = await jwt(
      {} as JWT,
      user as unknown as Record<string, unknown>,
    );
    expect(token.email).toBeFalsy();
  });

  it("treats an unverified or unstated email as unverified", async () => {
    for (const claims of [{ email_verified: false }, {}]) {
      mockVerifyIdToken.mockResolvedValue({
        uid: "uid-1",
        email: "ben@shorted.com.au",
        ...claims,
      });

      const user = await provider.authorize({ idToken: "t" });
      expect(user?.emailVerified).toBe(false);
    }
  });
});

describe("authorize: E2E fallback (non-production)", () => {
  const saved = {
    allow: process.env.ALLOW_E2E_AUTH,
    vercelEnv: process.env.VERCEL_ENV,
  };

  beforeEach(() => {
    process.env.ALLOW_E2E_AUTH = "true";
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    if (saved.allow === undefined) delete process.env.ALLOW_E2E_AUTH;
    else process.env.ALLOW_E2E_AUTH = saved.allow;
    if (saved.vercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = saved.vercelEnv;
  });

  it("signs the test user in as verified", async () => {
    await expect(
      provider.authorize({
        email: "e2e-test@shorted.com.au",
        password: "E2ETestPassword123!",
      }),
    ).resolves.toMatchObject({
      email: "e2e-test@shorted.com.au",
      emailVerified: true,
    });
  });
});

describe("E2E identity outside development and test", () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
    ALLOW_E2E_AUTH: process.env.ALLOW_E2E_AUTH,
    E2E_TEST_PASSWORD: process.env.E2E_TEST_PASSWORD,
    ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  };

  function restoreEnv(key: keyof typeof saved) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(() => {
    // A preview build: production mode, but not the real production deployment, so the
    // E2E fallback is switched on. The question is only the password and admin rules.
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "preview";
    process.env.ALLOW_E2E_AUTH = "true";
    delete process.env.E2E_TEST_PASSWORD;
    // The E2E account is listed as an admin on purpose. Outside development and test
    // the listing must still grant nothing.
    process.env.ADMIN_EMAILS = "ben@shorted.com.au,e2e-test@shorted.com.au";
  });

  afterEach(() => {
    (Object.keys(saved) as Array<keyof typeof saved>).forEach(restoreEnv);
  });

  it("refuses the hard-coded password", async () => {
    await expect(
      provider.authorize({
        email: "e2e-test@shorted.com.au",
        password: "E2ETestPassword123!",
      }),
    ).resolves.toBeNull();
  });

  it("accepts an explicit preview password, and still grants no admin", async () => {
    process.env.E2E_TEST_PASSWORD = "preview-only-password";

    const user = await provider.authorize({
      email: "e2e-test@shorted.com.au",
      password: "preview-only-password",
    });
    expect(user).toMatchObject({
      email: "e2e-test@shorted.com.au",
      emailVerified: true,
    });

    const token = await jwt(
      {} as JWT,
      user as unknown as Record<string, unknown>,
    );
    expect(token.isAdmin).toBe(false);
  });

  it("keeps the hard-coded password and the E2E admin in development", async () => {
    process.env.NODE_ENV = "development";

    const user = await provider.authorize({
      email: "e2e-test@shorted.com.au",
      password: "E2ETestPassword123!",
    });
    expect(user).toMatchObject({ email: "e2e-test@shorted.com.au" });

    const token = await jwt({ email: "e2e-test@shorted.com.au" } as JWT);
    expect(token.isAdmin).toBe(true);
  });
});

describe("jwt and session callbacks: admin needs a verified email", () => {
  const savedAdmins = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    process.env.ADMIN_EMAILS = "ben@shorted.com.au";
  });

  afterEach(() => {
    if (savedAdmins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdmins;
  });

  it("records the verdict on sign-in and grants admin only when verified", async () => {
    const verified = await jwt({} as JWT, {
      id: "uid-1",
      email: "ben@shorted.com.au",
      emailVerified: true,
    });
    expect(verified).toMatchObject({ emailVerified: true, isAdmin: true });

    const unverified = await jwt({} as JWT, {
      id: "uid-2",
      email: "ben@shorted.com.au",
      emailVerified: false,
    });
    expect(unverified).toMatchObject({ emailVerified: false, isAdmin: false });
  });

  it("keeps the verdict on refresh and refuses a token minted before it existed", async () => {
    const refreshed = await jwt({
      email: "ben@shorted.com.au",
      emailVerified: true,
    } as JWT);
    expect(refreshed).toMatchObject({ emailVerified: true, isAdmin: true });

    const legacy = await jwt({ email: "ben@shorted.com.au" } as JWT);
    expect(legacy.isAdmin).toBe(false);
  });

  it("reads an allowlist with a literal escaped-newline suffix, case-insensitively", async () => {
    process.env.ADMIN_EMAILS = "ben.ebsworth@gmail.com,ben@shorted.com.au\\n";
    const token = await jwt({} as JWT, {
      id: "uid-3",
      email: "Ben@Shorted.com.au",
      emailVerified: true,
    });
    expect(token.isAdmin).toBe(true);
  });

  it("keeps the non-production E2E test user as admin", async () => {
    const token = await jwt({ email: "e2e-test@shorted.com.au" } as JWT);
    expect(token.isAdmin).toBe(true);
  });

  it("exposes the verdict on the session user", async () => {
    const session = await authOptions.callbacks.session({
      session: {
        user: { id: "", email: "ben@shorted.com.au" },
        expires: "2099-01-01T00:00:00.000Z",
      } as unknown as Parameters<
        typeof authOptions.callbacks.session
      >[0]["session"],
      token: { id: "uid-1", emailVerified: true, isAdmin: true } as JWT,
    });
    expect(session.user).toMatchObject({ emailVerified: true, isAdmin: true });
  });
});

describe("jwt update trigger: the verdict is re-read from Firebase", () => {
  beforeEach(() => {
    mockGetUser.mockReset();
  });

  function update(token: JWT): Promise<JWT> {
    return authOptions.callbacks.jwt({ token, trigger: "update" });
  }

  it("upgrades an unverified token once Firebase says the address is verified", async () => {
    mockGetUser.mockResolvedValue({
      email: "ben@shorted.com.au",
      emailVerified: true,
      disabled: false,
      providerData: [{ providerId: "password" }],
    });

    const refreshed = await update({
      id: "uid-1",
      email: "ben@shorted.com.au",
      emailVerified: false,
    } as JWT);

    expect(mockGetUser).toHaveBeenCalledWith("uid-1");
    expect(refreshed.emailVerified).toBe(true);
  });

  it("stays unverified while Firebase still says the address is not verified", async () => {
    mockGetUser.mockResolvedValue({
      email: "ben@shorted.com.au",
      emailVerified: false,
      disabled: false,
      providerData: [{ providerId: "password" }],
    });

    const refreshed = await update({
      id: "uid-1",
      email: "ben@shorted.com.au",
      emailVerified: false,
    } as JWT);

    expect(refreshed.emailVerified).toBe(false);
  });

  it("stays unverified when the Firebase lookup fails", async () => {
    mockGetUser.mockRejectedValue(
      Object.assign(new Error("down"), { code: "app/network-error" }),
    );

    const refreshed = await update({
      id: "uid-1",
      email: "ben@shorted.com.au",
      emailVerified: false,
    } as JWT);

    expect(refreshed.emailVerified).toBe(false);
  });

  it("never asks Firebase on an ordinary refresh, only on the client's update", async () => {
    mockGetUser.mockResolvedValue({
      email: "ben@shorted.com.au",
      emailVerified: true,
      disabled: false,
      providerData: [],
    });

    await authOptions.callbacks.jwt({
      token: {
        id: "uid-1",
        email: "ben@shorted.com.au",
        emailVerified: false,
      } as JWT,
    });

    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("does not look up an account that is already verified, and never downgrades it", async () => {
    mockGetUser.mockResolvedValue({
      email: "ben@shorted.com.au",
      emailVerified: false,
      disabled: false,
      providerData: [],
    });

    const refreshed = await update({
      id: "uid-1",
      email: "ben@shorted.com.au",
      emailVerified: true,
    } as JWT);

    expect(mockGetUser).not.toHaveBeenCalled();
    expect(refreshed.emailVerified).toBe(true);
  });
});
