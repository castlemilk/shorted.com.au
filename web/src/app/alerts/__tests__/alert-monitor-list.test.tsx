import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { AlertMonitorView } from "../alert-model";
import { AlertMonitorList } from "../alert-monitor-list";

const mockUseSession = jest.fn();
jest.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

const mockList = jest.fn();
const mockSetStatus = jest.fn();
const mockDelete = jest.fn();
jest.mock("~/app/actions/alerts", () => ({
  listAlertMonitors: () => mockList(),
  setAlertMonitorStatus: (id: string, status: string) =>
    mockSetStatus(id, status),
  deleteAlertMonitor: (id: string) => mockDelete(id),
}));

const SIGNED_IN = {
  data: {
    user: { id: "u1", email: "trader@example.com", emailVerified: true },
  },
  status: "authenticated",
};

const UNVERIFIED = {
  data: {
    user: { id: "u1", email: "trader@example.com", emailVerified: false },
  },
  status: "authenticated",
  update: jest.fn().mockResolvedValue({ user: { emailVerified: false } }),
};

// The verification prompt's server action is not under test here.
jest.mock("~/app/actions/email-verification", () => ({
  sendAlertVerificationEmail: jest.fn(),
}));

const monitors: AlertMonitorView[] = [
  {
    id: "m1",
    scope: "stock",
    target: "BHP",
    condition: "short-interest-above",
    threshold: 5,
    cadence: "Daily",
    status: "active",
    createdAt: null,
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
    cadence: "Daily",
    status: "paused",
    createdAt: null,
    lastEventReportDate: null,
    lastDeliveryState: null,
    lastEventAt: null,
  },
  {
    id: "m3",
    scope: "stock",
    target: "XYZ",
    condition: "short-interest-rises",
    threshold: 1,
    cadence: "Weekly",
    status: "active",
    createdAt: null,
    lastEventReportDate: "2026-10-09",
    lastDeliveryState: "skipped-unentitled",
    lastEventAt: null,
  },
];

function renderList() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AlertMonitorList />
    </QueryClientProvider>,
  );
}

describe("AlertMonitorList", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList.mockResolvedValue({
      ok: true,
      monitors,
      checkedThroughReportDate: "2026-10-16",
    });
    mockSetStatus.mockResolvedValue({
      ok: true,
      monitor: monitors[0],
    });
    mockDelete.mockResolvedValue({ ok: true });
  });

  it("lists each monitor with its status and last trigger", async () => {
    renderList();

    expect(
      await screen.findByText("BHP - short interest above 5% - daily"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Active")).toHaveLength(2);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(
      screen.getByText("Last triggered: 16 Oct 2026 report — Emailed"),
    ).toBeInTheDocument();
    expect(screen.getByText("Last triggered: Never")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Last triggered: 9 Oct 2026 report — Not sent: Premium required",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Latest ASIC report checked: 16 Oct 2026"),
    ).toBeInTheDocument();
  });

  it("says no report has been checked before the first evaluator run", async () => {
    mockList.mockResolvedValueOnce({
      ok: true,
      monitors: [],
      checkedThroughReportDate: null,
    });
    renderList();

    expect(
      await screen.findByText(
        "No ASIC report has been checked yet. The first check runs after the next report.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/No monitors yet/)).toBeInTheDocument();
  });

  it("states where the email goes and the four-trading-day lag", async () => {
    renderList();

    const note = await screen.findByText(/Alerts are emailed to/);
    expect(note).toHaveTextContent("Alerts are emailed to trader@example.com.");
    expect(note).toHaveTextContent("four trading days");
    expect(note).toHaveTextContent("active Premium subscription");
  });

  it("says an unverified address is not emailed, and where to fix it", async () => {
    mockUseSession.mockReturnValue(UNVERIFIED);
    renderList();

    const note = await screen.findByText(/receive alert emails/);
    expect(note).toHaveTextContent(
      "Verify trader@example.com to receive alert emails.",
    );
    expect(note).not.toHaveTextContent("sign out");
    expect(screen.queryByText(/Alerts are emailed to/)).toBeNull();
    // The page offers the way to verify, so the notice does not just say "verify".
    // The prompt loads client-only (next/dynamic), so wait for it to appear.
    expect(
      await screen.findByRole("button", { name: "Send verification email" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "I've verified, refresh" }),
    ).toBeInTheDocument();
  });

  it("pauses an active monitor and refreshes the list", async () => {
    renderList();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Pause BHP - short interest above 5% - daily",
      }),
    );

    await waitFor(() =>
      expect(mockSetStatus).toHaveBeenCalledWith("m1", "paused"),
    );
    await waitFor(() =>
      expect(mockList.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });

  it("resumes a paused monitor", async () => {
    renderList();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Resume Materials - new top-ten entry - daily",
      }),
    );

    await waitFor(() =>
      expect(mockSetStatus).toHaveBeenCalledWith("m2", "active"),
    );
  });

  it("shows the Premium refusal when a resume is not allowed", async () => {
    mockSetStatus.mockResolvedValueOnce({
      ok: false,
      error: "Upgrade to Premium to resume alerts.",
    });
    renderList();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Resume Materials - new top-ten entry - daily",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Upgrade to Premium to resume alerts.",
    );
  });

  it("shows a retry message when the status call fails outright", async () => {
    mockSetStatus.mockRejectedValueOnce(new Error("network"));
    renderList();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Pause BHP - short interest above 5% - daily",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not update the monitor. Try again shortly.",
    );
  });

  it("deletes a monitor only after the visitor confirms", async () => {
    renderList();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Delete BHP - short interest above 5% - daily",
      }),
    );

    expect(await screen.findByText("Delete this alert?")).toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete alert" }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("m1"));
  });

  it("keeps the monitor when the visitor backs out of the delete", async () => {
    renderList();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Delete BHP - short interest above 5% - daily",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Keep alert" }));

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("asks a signed-out visitor to sign in without fetching", () => {
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" });
    renderList();

    expect(
      screen.getByText("to see the alerts on your account.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/signin?callbackUrl=%2Falerts",
    );
    expect(mockList).not.toHaveBeenCalled();
  });

  it("shows the server's message when the list cannot load", async () => {
    mockList.mockResolvedValueOnce({
      ok: false,
      error: "Could not load your alerts. Try again shortly.",
    });
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load your alerts. Try again shortly.",
    );
  });
});

describe("monitor delivery badges", () => {
  function monitorWith(
    state: AlertMonitorView["lastDeliveryState"],
  ): AlertMonitorView {
    return {
      id: "m9",
      scope: "stock",
      target: "CBA",
      condition: "short-interest-above",
      threshold: 5,
      cadence: "Daily",
      status: "active",
      createdAt: null,
      lastEventReportDate: "2026-10-16",
      lastDeliveryState: state,
      lastEventAt: null,
    };
  }

  function listWith(
    state: AlertMonitorView["lastDeliveryState"],
    session: typeof UNVERIFIED,
  ) {
    jest.clearAllMocks();
    mockUseSession.mockReturnValue(session);
    mockList.mockResolvedValue({
      ok: true,
      monitors: [monitorWith(state)],
      checkedThroughReportDate: "2026-10-16",
    });
    renderList();
  }

  it("badges a no-email skip for an unverified account, with a link to the verify prompt", async () => {
    listWith("skipped-no-email", UNVERIFIED);
    expect(
      await screen.findByText("Not emailed: verify your email"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Verify now" })).toHaveAttribute(
      "href",
      "#email-verification",
    );
  });

  it("drops the no-email badge once the account is verified", async () => {
    listWith("skipped-no-email", SIGNED_IN);
    await screen.findByText("CBA - short interest above 5% - daily");
    expect(screen.queryByText("Not emailed: verify your email")).toBeNull();
  });

  it("badges an inactive Premium skip and a paused skip with their reasons", async () => {
    listWith("skipped-unentitled", SIGNED_IN);
    expect(
      await screen.findByText("Not emailed: no active Premium"),
    ).toBeInTheDocument();
  });

  it("badges a monitor paused before its email was sent", async () => {
    listWith("skipped-paused", SIGNED_IN);
    expect(await screen.findByText("Not emailed: paused")).toBeInTheDocument();
  });

  it("shows no badge for a sent delivery", async () => {
    listWith("sent", SIGNED_IN);
    await screen.findByText("CBA - short interest above 5% - daily");
    expect(screen.queryByText(/^Not emailed/)).toBeNull();
  });
});
