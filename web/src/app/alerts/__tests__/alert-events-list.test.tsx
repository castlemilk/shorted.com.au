import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";

import type { AlertEventView } from "../alert-model";
import { AlertEventsList } from "../alert-events-list";

const mockUseSession = jest.fn();
jest.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

const mockListEvents = jest.fn();
jest.mock("~/app/actions/alerts", () => ({
  listAlertEvents: (input: unknown) => mockListEvents(input),
}));

const SIGNED_IN = {
  data: { user: { id: "u1", email: "trader@example.com" } },
  status: "authenticated",
};

const stockEvent: AlertEventView = {
  id: "e1",
  monitorId: "m1",
  scope: "stock",
  target: "BHP",
  condition: "short-interest-above",
  threshold: 5,
  cadence: "Daily",
  reportDate: "2026-10-16",
  comparedToDate: "2026-10-15",
  companies: [
    {
      productCode: "BHP",
      companyName: "BHP Group Ltd",
      latestPercent: 5.42,
      previousPercent: 4.9,
      changePoints: 0.52,
      rank: 0,
      previousRank: 0,
    },
  ],
  companiesTotal: 1,
  deliveryState: "sent",
  sentAt: "2026-10-16T01:40:00.000Z",
  createdAt: "2026-10-16T01:35:00.000Z",
};

const industryEvent: AlertEventView = {
  id: "e2",
  monitorId: "m2",
  scope: "industry",
  target: "Materials",
  condition: "new-top-ten-entry",
  threshold: null,
  cadence: "Weekly",
  reportDate: "2026-10-16",
  comparedToDate: "2026-10-09",
  companies: [
    {
      productCode: "LTR",
      companyName: "Liontown Resources",
      latestPercent: 7.1,
      previousPercent: null,
      changePoints: null,
      rank: 3,
      previousRank: 0,
    },
  ],
  companiesTotal: 12,
  deliveryState: "skipped-unentitled",
  sentAt: null,
  createdAt: "2026-10-16T01:35:00.000Z",
};

function renderEvents() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AlertEventsList />
    </QueryClientProvider>,
  );
}

describe("AlertEventsList", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSession.mockReturnValue(SIGNED_IN);
  });

  it("shows each fired alert with its report, companies and delivery", async () => {
    mockListEvents.mockResolvedValueOnce({
      ok: true,
      events: [stockEvent],
      totalCount: 1,
    });
    renderEvents();

    expect(await screen.findByText("16 Oct 2026 report")).toBeInTheDocument();
    expect(screen.getByText("compared with 15 Oct 2026")).toBeInTheDocument();
    expect(
      screen.getByText("BHP - short interest above 5% - daily"),
    ).toBeInTheDocument();
    expect(screen.getByText("BHP")).toBeInTheDocument();
    expect(screen.getByText("BHP Group Ltd")).toBeInTheDocument();
    expect(screen.getByText("4.90% → 5.42% (+0.52 pts)")).toBeInTheDocument();
    expect(screen.getByText("Emailed")).toBeInTheDocument();
  });

  it("shows top-ten rank movement and the rest of a long list", async () => {
    mockListEvents.mockResolvedValueOnce({
      ok: true,
      events: [industryEvent],
      totalCount: 1,
    });
    renderEvents();

    expect(
      await screen.findByText("Ranked #3 (was not ranked)"),
    ).toBeInTheDocument();
    expect(screen.getByText("7.10% (no previous reading)")).toBeInTheDocument();
    expect(screen.getByText("and 11 more companies")).toBeInTheDocument();
    expect(screen.getByText("Not sent: Premium required")).toBeInTheDocument();
  });

  it("says plainly when nothing has fired", async () => {
    mockListEvents.mockResolvedValueOnce({
      ok: true,
      events: [],
      totalCount: 0,
    });
    renderEvents();

    expect(
      await screen.findByText(/Nothing has fired yet/),
    ).toBeInTheDocument();
  });

  it("shows the server's message when the events cannot load", async () => {
    mockListEvents.mockResolvedValueOnce({
      ok: false,
      error: "Could not load recent alerts. Try again shortly.",
    });
    renderEvents();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load recent alerts. Try again shortly.",
    );
  });

  it("asks a signed-out visitor to sign in without fetching", () => {
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" });
    renderEvents();

    expect(
      screen.getByText(
        "Sign in to see the alerts that have fired on your monitors.",
      ),
    ).toBeInTheDocument();
    expect(mockListEvents).not.toHaveBeenCalled();
  });

  it("asks for the most recent twenty events", async () => {
    mockListEvents.mockResolvedValueOnce({
      ok: true,
      events: [],
      totalCount: 0,
    });
    renderEvents();

    await screen.findByText(/Nothing has fired yet/);
    expect(mockListEvents).toHaveBeenCalledWith({ limit: 20 });
  });
});
