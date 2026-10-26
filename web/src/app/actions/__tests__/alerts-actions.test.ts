import { Code, ConnectError } from "@connectrpc/connect";

import {
  AlertDeliveryStatus,
  AlertMonitorCadence,
  AlertMonitorCondition,
  AlertMonitorScope,
  AlertMonitorStatus,
} from "~/gen/shorts/v1alpha1/alerts_pb";
import { auth } from "~/server/auth";

const mockClient = {
  createAlertMonitor: jest.fn(),
  listAlertMonitors: jest.fn(),
  listAlertEvents: jest.fn(),
  updateAlertMonitorStatus: jest.fn(),
  deleteAlertMonitor: jest.fn(),
  pauseAlertMonitorByToken: jest.fn(),
};

jest.mock("@connectrpc/connect", () => {
  const actual = jest.requireActual("@connectrpc/connect");
  return { ...actual, createClient: () => mockClient };
});

// The transport's options are captured, so a test can run its interceptors and
// read the headers the API receives.
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

jest.mock("~/server/auth", () => ({ auth: jest.fn() }));

// The session flag is read once at sign-in, so an unverified session is checked against
// Firebase. The default is "no account", which keeps the address undeliverable.
const mockLookupAccount = jest.fn(async (_uid: string) => null);
jest.mock("~/server/account-verification", () => ({
  lookupAccountVerification: (uid: string) => mockLookupAccount(uid),
}));

jest.mock("../config", () => ({
  SHORTS_API_URL: "https://api.test",
  serverFetchWithUserAgent: jest.fn(),
}));

import {
  createAlertMonitor,
  deleteAlertMonitor,
  listAlertEvents,
  listAlertMonitors,
  setAlertMonitorStatus,
} from "../alerts";
import { pauseAlertByToken } from "../alert-unsubscribe";
import { alertErrorMessage, monitorToView } from "../alert-mapping";

const mockAuth = auth as unknown as jest.Mock;
const SIGNED_IN = { user: { id: "u1", email: "trader@example.com" } };

function protoMonitor(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    scope: AlertMonitorScope.STOCK,
    target: "BHP",
    condition: AlertMonitorCondition.SHORT_INTEREST_ABOVE,
    threshold: 5,
    hasThreshold: true,
    cadence: AlertMonitorCadence.DAILY,
    status: AlertMonitorStatus.ACTIVE,
    createdAt: { seconds: 1760572800, nanos: 0 },
    updatedAt: undefined,
    lastEventReportDate: "2026-10-16",
    lastDeliveryStatus: AlertDeliveryStatus.SENT,
    lastEventAt: undefined,
    ...overrides,
  };
}

describe("alert server actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue(SIGNED_IN);
  });

  describe("when signed out", () => {
    beforeEach(() => {
      mockAuth.mockResolvedValue(null);
    });

    it("refuses the list, events, status and delete calls without calling the API", async () => {
      expect(await listAlertMonitors()).toEqual({
        ok: false,
        error: "Sign in to manage your alerts.",
      });
      expect(await listAlertEvents()).toMatchObject({ ok: false });
      expect(await setAlertMonitorStatus("m1", "paused")).toMatchObject({
        ok: false,
      });
      expect(await deleteAlertMonitor("m1")).toMatchObject({ ok: false });
      expect(mockClient.listAlertMonitors).not.toHaveBeenCalled();
      expect(mockClient.updateAlertMonitorStatus).not.toHaveBeenCalled();
    });
  });

  describe("listAlertMonitors", () => {
    it("maps the enums and the last trigger for each monitor", async () => {
      const createdIso = new Date(1760572800 * 1000).toISOString();
      mockClient.listAlertMonitors.mockResolvedValueOnce({
        monitors: [
          protoMonitor(),
          protoMonitor({
            id: "m2",
            target: "Materials",
            scope: AlertMonitorScope.INDUSTRY,
            condition: AlertMonitorCondition.NEW_TOP_TEN_ENTRY,
            hasThreshold: false,
            cadence: AlertMonitorCadence.WEEKLY,
            status: AlertMonitorStatus.PAUSED,
            lastEventReportDate: "",
            lastDeliveryStatus: AlertDeliveryStatus.UNSPECIFIED,
          }),
        ],
        checkedThroughReportDate: "2026-10-16",
      });

      const result = await listAlertMonitors();

      expect(result).toEqual({
        ok: true,
        checkedThroughReportDate: "2026-10-16",
        monitors: [
          {
            id: "m1",
            scope: "stock",
            target: "BHP",
            condition: "short-interest-above",
            threshold: 5,
            cadence: "Daily",
            status: "active",
            createdAt: createdIso,
            lastEventReportDate: "2026-10-16",
            lastDeliveryState: "sent",
            lastEventAt: null,
          },
          {
            id: "m2",
            scope: "industry",
            target: "Materials",
            condition: "new-top-ten-entry",
            threshold: null,
            cadence: "Weekly",
            status: "paused",
            createdAt: createdIso,
            lastEventReportDate: null,
            lastDeliveryState: null,
            lastEventAt: null,
          },
        ],
      });
    });

    it("returns a null check date before the evaluator's first run", async () => {
      mockClient.listAlertMonitors.mockResolvedValueOnce({
        monitors: [],
        checkedThroughReportDate: "",
      });

      const result = await listAlertMonitors();

      expect(result).toMatchObject({
        ok: true,
        checkedThroughReportDate: null,
      });
    });
  });

  describe("listAlertEvents", () => {
    it("defaults to twenty events and clamps the limit to one hundred", async () => {
      mockClient.listAlertEvents.mockResolvedValue({
        events: [],
        totalCount: 0,
      });

      await listAlertEvents();
      expect(mockClient.listAlertEvents).toHaveBeenLastCalledWith({
        limit: 20,
        offset: 0,
        monitorId: "",
      });

      await listAlertEvents({ limit: 500, monitorId: "m1" });
      expect(mockClient.listAlertEvents).toHaveBeenLastCalledWith({
        limit: 100,
        offset: 0,
        monitorId: "m1",
      });

      await listAlertEvents({ limit: 0 });
      expect(mockClient.listAlertEvents).toHaveBeenLastCalledWith({
        limit: 1,
        offset: 0,
        monitorId: "",
      });
    });
  });

  describe("setAlertMonitorStatus", () => {
    it("sends the status enum and returns the monitor", async () => {
      mockClient.updateAlertMonitorStatus.mockResolvedValueOnce({
        monitor: protoMonitor({ status: AlertMonitorStatus.PAUSED }),
      });

      const result = await setAlertMonitorStatus(" m1 ", "paused");

      expect(mockClient.updateAlertMonitorStatus).toHaveBeenCalledWith({
        id: "m1",
        status: AlertMonitorStatus.PAUSED,
      });
      expect(result).toMatchObject({
        ok: true,
        monitor: { id: "m1", status: "paused" },
      });
    });

    it("turns a Premium refusal into the upgrade message", async () => {
      mockClient.updateAlertMonitorStatus.mockRejectedValueOnce(
        new ConnectError(
          "alerts require an active Premium subscription",
          Code.PermissionDenied,
        ),
      );

      expect(await setAlertMonitorStatus("m1", "active")).toEqual({
        ok: false,
        error: "Upgrade to Premium to resume alerts.",
      });
    });

    it("says a missing monitor no longer exists", async () => {
      mockClient.updateAlertMonitorStatus.mockRejectedValueOnce(
        new ConnectError("not found", Code.NotFound),
      );

      expect(await setAlertMonitorStatus("m1", "paused")).toEqual({
        ok: false,
        error: "That monitor no longer exists.",
      });
    });
  });

  describe("deleteAlertMonitor", () => {
    it("deletes and reports success", async () => {
      mockClient.deleteAlertMonitor.mockResolvedValueOnce({});

      expect(await deleteAlertMonitor("m1")).toEqual({ ok: true });
      expect(mockClient.deleteAlertMonitor).toHaveBeenCalledWith({ id: "m1" });
    });

    it("hides the server message on an unexpected failure", async () => {
      mockClient.deleteAlertMonitor.mockRejectedValueOnce(
        new ConnectError("pq: connection refused", Code.Internal),
      );

      expect(await deleteAlertMonitor("m1")).toEqual({
        ok: false,
        error: "Could not delete the monitor. Try again shortly.",
      });
    });
  });

  describe("createAlertMonitor", () => {
    it("explains the active-alert cap rather than a generic failure", async () => {
      mockClient.createAlertMonitor.mockRejectedValueOnce(
        new ConnectError(
          "You already have 50 active alerts.",
          Code.ResourceExhausted,
        ),
      );

      expect(
        await createAlertMonitor({
          scope: "stock",
          target: "BHP",
          condition: "short-interest-above",
          threshold: "5",
          cadence: "Daily",
        }),
      ).toEqual({
        ok: false,
        error:
          "You already have the most active alerts allowed. Pause or delete one to add another.",
      });
    });

    it("shows the server's reason for an unknown ASX code", async () => {
      mockClient.createAlertMonitor.mockRejectedValueOnce(
        new ConnectError("Unknown ASX code", Code.InvalidArgument),
      );

      expect(
        await createAlertMonitor({
          scope: "stock",
          target: "zzz",
          condition: "short-interest-above",
          threshold: "5",
          cadence: "Daily",
        }),
      ).toEqual({ ok: false, error: "Unknown ASX code" });
    });
  });
});

/** Runs the transport's interceptors over an empty request and returns its headers. */
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

describe("the internal transport's verification header", () => {
  it("asserts a verified address to the API", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "trader@example.com", emailVerified: true },
    });
    mockClient.listAlertMonitors.mockResolvedValueOnce({
      monitors: [],
      checkedThroughReportDate: "",
    });

    await listAlertMonitors();
    const headers = await headersSentToTheAPI();
    expect(headers["x-user-email"]).toBe("trader@example.com");
    expect(headers["x-user-email-verified"]).toBe("true");
  });

  it("never sends an unverified address as verified", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "trader@example.com", emailVerified: false },
    });
    mockClient.listAlertMonitors.mockResolvedValueOnce({
      monitors: [],
      checkedThroughReportDate: "",
    });

    await listAlertMonitors();
    const headers = await headersSentToTheAPI();
    expect(headers["x-user-email"]).toBe("");
    expect(headers["x-user-email-verified"]).toBe("false");
  });
});

describe("pauseAlertByToken", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("refuses an empty token without calling the API", async () => {
    expect(await pauseAlertByToken("   ")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(mockClient.pauseAlertMonitorByToken).not.toHaveBeenCalled();
  });

  it("pauses and returns the monitor for the confirmation page", async () => {
    mockClient.pauseAlertMonitorByToken.mockResolvedValueOnce({
      alreadyPaused: false,
      scope: AlertMonitorScope.STOCK,
      target: "BHP",
      condition: AlertMonitorCondition.SHORT_INTEREST_RISES,
      threshold: 1.5,
      hasThreshold: true,
      cadence: AlertMonitorCadence.WEEKLY,
    });

    expect(await pauseAlertByToken(" signed-token ")).toEqual({
      ok: true,
      alreadyPaused: false,
      monitor: {
        scope: "stock",
        target: "BHP",
        condition: "short-interest-rises",
        threshold: 1.5,
        cadence: "Weekly",
      },
    });
    expect(mockClient.pauseAlertMonitorByToken).toHaveBeenCalledWith({
      token: "signed-token",
    });
  });

  it("reports a rejected token as invalid", async () => {
    mockClient.pauseAlertMonitorByToken.mockRejectedValueOnce(
      new ConnectError("invalid token", Code.InvalidArgument),
    );

    expect(await pauseAlertByToken("forged")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("reports a valid token whose monitor was deleted as gone, not as a failure", async () => {
    mockClient.pauseAlertMonitorByToken.mockRejectedValueOnce(
      new ConnectError("alert monitor not found", Code.NotFound),
    );

    expect(await pauseAlertByToken("signed-token")).toEqual({
      ok: false,
      reason: "gone",
    });
  });

  it("reports an unconfigured or failing service as unavailable", async () => {
    mockClient.pauseAlertMonitorByToken.mockRejectedValueOnce(
      new ConnectError("unsubscribe not configured", Code.Internal),
    );

    expect(await pauseAlertByToken("signed-token")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("alertErrorMessage", () => {
  it("uses the fallback for codes the management calls do not name", () => {
    expect(
      alertErrorMessage(new ConnectError("boom", Code.Internal), "fallback"),
    ).toBe("fallback");
    expect(alertErrorMessage(new Error("plain"), "fallback")).toBe("fallback");
  });

  it("names an identical active monitor", () => {
    expect(
      alertErrorMessage(new ConnectError("x", Code.AlreadyExists), "fallback"),
    ).toBe("An identical monitor is already active.");
  });

  it("explains a resume refused by the active-alert cap", () => {
    expect(
      alertErrorMessage(
        new ConnectError("x", Code.ResourceExhausted),
        "fallback",
      ),
    ).toBe(
      "You already have the most active alerts allowed. Pause or delete one before resuming this one.",
    );
  });
});

describe("monitorToView", () => {
  it("keeps a missing threshold null rather than zero", () => {
    expect(
      monitorToView(
        protoMonitor({ hasThreshold: false, threshold: 0 }) as never,
      ).threshold,
    ).toBeNull();
  });
});

describe("the alert address after sign-in (Firebase is the authority)", () => {
  beforeEach(() => {
    mockLookupAccount.mockReset();
    mockLookupAccount.mockResolvedValue(null);
  });

  it("delivers to an address Firebase now verifies, though the session predates it", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "trader@example.com", emailVerified: false },
    });
    mockLookupAccount.mockResolvedValue({
      email: "trader@example.com",
      verified: true,
      hasPassword: true,
    });
    mockClient.listAlertMonitors.mockResolvedValueOnce({
      monitors: [],
      checkedThroughReportDate: "",
    });

    await listAlertMonitors();

    expect(mockLookupAccount).toHaveBeenCalledWith("u1");
    const headers = await headersSentToTheAPI();
    expect(headers["x-user-email"]).toBe("trader@example.com");
    expect(headers["x-user-email-verified"]).toBe("true");
  });

  it("keeps an address unverified while Firebase still says it is not", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "trader@example.com", emailVerified: false },
    });
    mockLookupAccount.mockResolvedValue({
      email: "trader@example.com",
      verified: false,
      hasPassword: true,
    });
    mockClient.listAlertMonitors.mockResolvedValueOnce({
      monitors: [],
      checkedThroughReportDate: "",
    });

    await listAlertMonitors();

    const headers = await headersSentToTheAPI();
    expect(headers["x-user-email"]).toBe("");
    expect(headers["x-user-email-verified"]).toBe("false");
  });

  it("keeps an address unverified when there is no usable Firebase account", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "trader@example.com", emailVerified: false },
    });
    mockLookupAccount.mockResolvedValue(null);
    mockClient.listAlertMonitors.mockResolvedValueOnce({
      monitors: [],
      checkedThroughReportDate: "",
    });

    await listAlertMonitors();

    const headers = await headersSentToTheAPI();
    expect(headers["x-user-email-verified"]).toBe("false");
  });

  it("does not ask Firebase when the session is already verified", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", email: "trader@example.com", emailVerified: true },
    });
    mockClient.listAlertMonitors.mockResolvedValueOnce({
      monitors: [],
      checkedThroughReportDate: "",
    });

    await listAlertMonitors();

    expect(mockLookupAccount).not.toHaveBeenCalled();
  });
});
