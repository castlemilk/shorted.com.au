// The signed-in transport asserts only what the session and Firebase say. These
// tests run its interceptors over an empty request, the way alerts-actions does,
// and read the headers the API would receive.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

const mockAuth = jest.fn(async (): Promise<unknown> => null);
jest.mock("~/server/auth", () => ({ auth: () => mockAuth() }));

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
  type SignedInTransportOptions,
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

const SESSION_UNVERIFIED = {
  user: { id: "u1", email: "trader@example.com", emailVerified: false },
};
const SESSION_VERIFIED = {
  user: { id: "u1", email: "trader@example.com", emailVerified: true },
};

const ORIGINAL_ENV = { ...process.env };

describe("createSignedInTransport", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue(SESSION_VERIFIED);
    mockLookupAccount.mockResolvedValue(null);
    process.env = { ...ORIGINAL_ENV, INTERNAL_SERVICE_SECRET: "test-secret" };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("asserts a verified address when the session says it is verified", async () => {
    const { email } = await createSignedInTransport();
    expect(email).toBe("trader@example.com");
    const headers = await headersSentToTheAPI();
    expect(headers["x-user-email"]).toBe("trader@example.com");
    expect(headers["x-user-email-verified"]).toBe("true");
    expect(headers["x-user-id"]).toBe("u1");
    expect(headers["x-internal-secret"]).toBe("test-secret");
  });

  it("never yields x-user-email-verified true for an unverified session", async () => {
    mockAuth.mockResolvedValue(SESSION_UNVERIFIED);
    mockLookupAccount.mockResolvedValueOnce({
      email: "trader@example.com",
      verified: false,
      hasPassword: true,
    });
    const { email } = await createSignedInTransport();
    expect(email).toBe("");
    const headers = await headersSentToTheAPI();
    expect(headers["x-user-email"]).toBe("");
    expect(headers["x-user-email-verified"]).toBe("false");
  });

  it("asks Firebase when the session predates a verification", async () => {
    mockAuth.mockResolvedValue(SESSION_UNVERIFIED);
    mockLookupAccount.mockResolvedValueOnce({
      email: "trader@example.com",
      verified: true,
      hasPassword: true,
    });
    const { email } = await createSignedInTransport();
    expect(email).toBe("trader@example.com");
    expect((await headersSentToTheAPI())["x-user-email-verified"]).toBe("true");
  });

  it("reads a failed lookup as unverified, and asserts nothing", async () => {
    mockAuth.mockResolvedValue(SESSION_UNVERIFIED);
    mockLookupAccount.mockRejectedValueOnce(new Error("firebase down"));
    const { email } = await createSignedInTransport();
    expect(email).toBe("");
    const headers = await headersSentToTheAPI();
    expect(headers["x-user-email"]).toBe("");
    expect(headers["x-user-email-verified"]).toBe("false");
  });

  it("sends identity alone for a read-only call, with no lookup", async () => {
    const { email } = await createSignedInTransport({ withEmail: false });
    expect(email).toBe("");
    expect(mockLookupAccount).not.toHaveBeenCalled();
    const headers = await headersSentToTheAPI();
    expect(headers["x-user-id"]).toBe("u1");
    expect(headers).not.toHaveProperty("x-user-email");
    expect(headers).not.toHaveProperty("x-user-email-verified");
  });

  it("refuses when there is no signed-in session", async () => {
    mockAuth.mockResolvedValueOnce(null);
    await expect(createSignedInTransport()).rejects.toThrow(
      "signed-in session",
    );
    mockAuth.mockResolvedValueOnce({ user: {} });
    await expect(createSignedInTransport()).rejects.toThrow(
      "signed-in session",
    );
  });

  it("no caller can pass an email or the verification flag", async () => {
    // Extra fields are ignored: the only input is the options, and the address
    // and the flag come from auth() and Firebase.
    const forged = {
      withEmail: true,
      email: "someone-else@example.com",
      emailVerified: true,
      userEmail: "someone-else@example.com",
      user: {
        id: "u2",
        email: "someone-else@example.com",
        emailVerified: true,
      },
    } as unknown as SignedInTransportOptions;

    mockAuth.mockResolvedValue(SESSION_UNVERIFIED);
    mockLookupAccount.mockResolvedValueOnce(null);
    const { email } = await createSignedInTransport(forged);
    expect(email).toBe("");
    let headers = await headersSentToTheAPI();
    expect(headers["x-user-email"]).toBe("");
    expect(headers["x-user-email-verified"]).toBe("false");
    expect(headers["x-user-id"]).toBe("u1");

    mockAuth.mockResolvedValue(SESSION_VERIFIED);
    const verified = await createSignedInTransport(forged);
    expect(verified.email).toBe("trader@example.com");
    headers = await headersSentToTheAPI();
    expect(headers["x-user-email"]).toBe("trader@example.com");
    expect(headers["x-user-id"]).toBe("u1");
  });

  it("throws in production without INTERNAL_SERVICE_SECRET", async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    Object.assign(process.env, { NODE_ENV: "production" });
    try {
      await expect(createSignedInTransport()).rejects.toThrow(
        "INTERNAL_SERVICE_SECRET is not configured",
      );
    } finally {
      Object.assign(process.env, { NODE_ENV: "test" });
    }
  });

  it("throws outside development without INTERNAL_SERVICE_SECRET, never the dev secret", async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    await expect(createSignedInTransport()).rejects.toThrow(
      "INTERNAL_SERVICE_SECRET is not configured",
    );
  });

  it("uses the development secret under next dev when none is set", async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    Object.assign(process.env, { NODE_ENV: "development" });
    try {
      await createSignedInTransport({ withEmail: false });
      expect((await headersSentToTheAPI())["x-internal-secret"]).toBe(
        "dev-internal-secret",
      );
    } finally {
      Object.assign(process.env, { NODE_ENV: "test" });
    }
  });
});

describe("the signed-in transport stays server-only", () => {
  const srcRoot = join(__dirname, "..", "..", "..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        return name === "__tests__" || name === "node_modules"
          ? []
          : sourceFiles(path);
      }
      return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
    });
  }

  it("is not a 'use server' module, so the browser cannot call it with a forged session", () => {
    const source = readFileSync(
      join(__dirname, "..", "auth-transport.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/["']use server["']/);
  });

  it("is the only web source file that sets the verified-address header", () => {
    const setters = sourceFiles(srcRoot).filter((file) =>
      readFileSync(file, "utf8").includes("x-user-email-verified"),
    );
    expect(setters.map((file) => file.slice(srcRoot.length + 1))).toEqual([
      "app/actions/auth-transport.ts",
    ]);
  });
});
