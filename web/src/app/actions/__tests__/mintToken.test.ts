// The API mints an admin token only when the web tier asserts the admin role,
// and the web tier asserts it only for a verified admin.

const ADMIN = "ben@shorted.com.au";

const mockAuth = jest.fn();
const mockMintToken = jest.fn();

jest.mock("~/server/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

jest.mock("@/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    mintToken: (...args: unknown[]) => mockMintToken(...args),
  })),
}));

jest.mock("~/gen/shorts/v1alpha1/billing_pb", () => ({
  BillingService: {},
}));

jest.mock("../config", () => ({
  SHORTS_API_URL: "https://api.test",
  serverFetchWithUserAgent: jest.fn(),
}));

jest.mock("~/@/lib/product-events", () => ({
  recordProductEvent: jest.fn(),
}));

type MintTokenModule = typeof import("~/app/actions/mintToken");
let mintApiTokenAction: MintTokenModule["mintApiTokenAction"];

beforeAll(async () => {
  // The admin allowlist and the internal secret are read when the modules load.
  process.env.ADMIN_EMAILS = ADMIN;
  process.env.INTERNAL_SERVICE_SECRET = "test-internal-secret";
  ({ mintApiTokenAction } = await import("~/app/actions/mintToken"));
});

function signedInAs(user: Record<string, unknown>) {
  mockAuth.mockResolvedValue({ user });
}

describe("mintApiTokenAction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMintToken.mockResolvedValue({ token: "tok" });
  });

  it("asserts the admin role for a verified admin", async () => {
    signedInAs({ id: "uid-1", email: ADMIN, emailVerified: true });

    await expect(mintApiTokenAction()).resolves.toEqual({ token: "tok" });

    const [, options] = mockMintToken.mock.calls[0];
    expect(options.headers["X-User-Roles"]).toBe("admin");
  });

  it("does not assert the role for an unverified account under the admin address", async () => {
    signedInAs({ id: "uid-2", email: ADMIN, emailVerified: false });

    await mintApiTokenAction();

    const [, options] = mockMintToken.mock.calls[0];
    expect(options.headers).not.toHaveProperty("X-User-Roles");
  });

  it("does not assert the role for an ordinary subscriber", async () => {
    signedInAs({ id: "uid-3", email: "paid@example.com", emailVerified: true });

    await mintApiTokenAction();

    const [, options] = mockMintToken.mock.calls[0];
    expect(options.headers).not.toHaveProperty("X-User-Roles");
  });
});
