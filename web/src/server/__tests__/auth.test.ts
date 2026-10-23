import type { User } from "next-auth";
import type { JWT } from "next-auth/jwt";

const mockVerifyIdToken = jest.fn();

jest.mock("@/lib/firebase-admin", () => ({
  adminAuth: {
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
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
