// Admin actions gate in-action with requireAdmin() and assert the admin role to
// the API. The API no longer derives admin from the email header, so a missing
// assertion is a PermissionDenied from the API, not a silent downgrade.

const ADMIN = { email: "ben@shorted.com.au", userId: "uid-admin" };

const mockRequireAdmin = jest.fn();
const mockListPendingEnrichments = jest.fn();
const mockEnrichStock = jest.fn();

jest.mock("~/server/admin", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    listPendingEnrichments: (...args: unknown[]) =>
      mockListPendingEnrichments(...args),
    enrichStock: (...args: unknown[]) => mockEnrichStock(...args),
  })),
}));

jest.mock("~/gen/shorts/v1alpha1/enrichment_pb", () => ({
  EnrichmentService: {},
}));

jest.mock("../config", () => ({
  SHORTS_API_URL: "https://api.test",
  serverFetchWithUserAgent: jest.fn(),
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

import { getPendingEnrichments } from "../getPendingEnrichments";
import { triggerEnrichmentAction } from "../triggerEnrichment";

const REFUSED = new Error("NEXT_REDIRECT /?adminDenied=1");

beforeAll(() => {
  process.env.INTERNAL_SERVICE_SECRET = "test-internal-secret";
});

describe("getPendingEnrichments", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListPendingEnrichments.mockResolvedValue({ enrichments: [] });
  });

  it("asserts the admin role to the API once the gate passes", async () => {
    mockRequireAdmin.mockResolvedValue(ADMIN);

    await getPendingEnrichments(10, 0);

    expect(mockRequireAdmin).toHaveBeenCalled();
    const [, options] = mockListPendingEnrichments.mock.calls[0];
    expect(options.headers).toMatchObject({
      "X-User-Roles": "admin",
      "X-User-Email": ADMIN.email,
      "X-User-Id": ADMIN.userId,
    });
  });

  it("sends nothing to the API for a caller the gate refuses", async () => {
    mockRequireAdmin.mockRejectedValue(REFUSED);

    await expect(getPendingEnrichments()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockListPendingEnrichments).not.toHaveBeenCalled();
  });
});

describe("triggerEnrichmentAction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("refuses a caller the gate refuses before any RPC is made", async () => {
    mockRequireAdmin.mockRejectedValue(REFUSED);
    const form = new FormData();
    form.set("stockCode", "BHP");

    await expect(triggerEnrichmentAction(form)).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(mockEnrichStock).not.toHaveBeenCalled();
  });

  it("asserts the admin role on the enrichment call", async () => {
    mockRequireAdmin.mockResolvedValue(ADMIN);
    mockEnrichStock.mockResolvedValue({ jobId: "job-1", message: "queued" });
    const form = new FormData();
    form.set("stockCode", "bhp");

    await triggerEnrichmentAction(form);

    const [request, options] = mockEnrichStock.mock.calls[0];
    expect(request).toMatchObject({ stockCode: "BHP" });
    expect(options.headers["X-User-Roles"]).toBe("admin");
  });
});
