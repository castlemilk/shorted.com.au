// The signed-in transport asserts only what the session and Firebase say. These
// tests run its interceptors over an empty request, the way alerts-actions does,
// and read the headers the API would receive.

const mockTransportOptions: {
  current?: { interceptors?: Array<(next: unknown) => unknown> };
} = {};

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (options: {
    interceptors?: Array<(next: unknown) => unknown>;
  }) => {
    mockTransportOptions.current = options;
    return {};
  },
}));

const mockLookupAccount = jest.fn(
  async (_uid: string): Promise<unknown> => null,
);
jest.mock("~/server/account-verification", () => ({
  lookupAccountVerification: (uid: string) => mockLookupAccount(uid),
}));

jest.mock("../config", () => ({
  SHORTS_API_URL: "https://api.test",
  serverFetchWithUserAgent: jest.fn(),
}));

import {
  createSignedInTransport,
  deliverableEmail,
  internalServiceSecret,
} from "../auth-transport";

async function headersSentToTheAPI(): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const req = {
    header: {
      set(name: string, value: string) {
        values[name] = value;
      },
    },
  };
  const interceptors = mockTransportOptions.current?.interceptors ?? [];
  const finalNext = async (r: unknown) => r;
  const chain = interceptors.reduceRight<(r: unknown) => unknown>(
    (next, interceptor) => interceptor(next) as (r: unknown) => unknown,
    finalNext,
  );
  await chain(req);
  return values;
}

const ORIGINAL_ENV = { ...process.env };

describe("createSignedInTransport", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLookupAccount.mockResolvedValue(null);
    process.env = { ...ORIGINAL_ENV, INTERNAL_SERVICE_SECRET: "test-secret" };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("asserts a verified address when the session says it is verified", async () => {
    const { email } = await createSignedInTransport({
      user: { id: "u1", email: "trader@example.com", emailVerified: true },
    });
    expect(email).toBe("trader@example.com");
    const headers = await headersSentToTheAPI();
    expect(headers["x-user-email"]).toBe("trader@example.com");
    expect(headers["x-user-email-verified"]).toBe("true");
    expect(headers["x-user-id"]).toBe("u1");
    expect(headers["x-internal-secret"]).toBe("test-secret");
  });

  it("never yields x-user-email-verified true for an unverified session", async () => {
    mockLookupAccount.mockResolvedValueOnce({
      email: "trader@example.com",
      verified: false,
      hasPassword: true,
    });
    const { email } = await createSignedInTransport({
      user: { id: "u1", email: "trader@example.com", emailVerified: false },
    });
    expect(email).toBe("");
    const headers = await headersSentToTheAPI();
    expect(headers["x-user-email"]).toBe("");
    expect(headers["x-user-email-verified"]).toBe("false");
  });

  it("asks Firebase when the session predates a verification", async () => {
    mockLookupAccount.mockResolvedValueOnce({
      email: "trader@example.com",
      verified: true,
      hasPassword: true,
    });
    const { email } = await createSignedInTransport({
      user: { id: "u1", email: "trader@example.com", emailVerified: false },
    });
    expect(email).toBe("trader@example.com");
    expect((await headersSentToTheAPI())["x-user-email-verified"]).toBe("true");
  });

  it("reads a failed lookup as unverified", async () => {
    mockLookupAccount.mockRejectedValueOnce(new Error("firebase down"));
    await expect(
      deliverableEmail({ user: { id: "u1", email: "a@b.co" } }),
    ).rejects.toThrow("firebase down");
    mockLookupAccount.mockResolvedValueOnce(null);
    expect(
      await deliverableEmail({ user: { id: "u1", email: "a@b.co" } }),
    ).toBe("");
  });

  it("sends identity alone for a read-only call, with no lookup", async () => {
    const { email } = await createSignedInTransport(
      { user: { id: "u1", email: "trader@example.com", emailVerified: true } },
      { withEmail: false },
    );
    expect(email).toBe("");
    expect(mockLookupAccount).not.toHaveBeenCalled();
    const headers = await headersSentToTheAPI();
    expect(headers["x-user-id"]).toBe("u1");
    expect(headers).not.toHaveProperty("x-user-email");
    expect(headers).not.toHaveProperty("x-user-email-verified");
  });

  it("refuses a session with no user id", async () => {
    await expect(createSignedInTransport(null)).rejects.toThrow(
      "signed-in session",
    );
    await expect(createSignedInTransport({ user: {} })).rejects.toThrow(
      "signed-in session",
    );
  });

  it("fails closed in production without INTERNAL_SERVICE_SECRET", async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    Object.assign(process.env, { NODE_ENV: "production" });
    try {
      expect(() => internalServiceSecret()).toThrow(
        "INTERNAL_SERVICE_SECRET is not set",
      );
      await expect(
        createSignedInTransport({ user: { id: "u1" } }),
      ).rejects.toThrow("INTERNAL_SERVICE_SECRET is not set");
    } finally {
      Object.assign(process.env, { NODE_ENV: "test" });
    }
  });

  it("uses the development secret outside production when none is set", () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    expect(internalServiceSecret()).toBe("dev-internal-secret");
  });
});
