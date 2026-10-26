import { act, render, screen, waitFor } from "@testing-library/react";
import { PastDueBanner } from "../past-due-banner";
import { getSubscriptionStatus } from "~/app/actions/subscription";

jest.mock("~/app/actions/subscription", () => ({
  getSubscriptionStatus: jest.fn(),
}));

// The banner's own session and route checks. Each test sets who is signed in and
// which page is showing.
const sessionState: { status: string; userId: string | null } = { status: "authenticated", userId: "user-1" };
jest.mock("next-auth/react", () => ({
  useSession: () => ({
    status: sessionState.status,
    data: sessionState.userId ? { user: { id: sessionState.userId } } : null,
  }),
}));

const pathState = { pathname: "/pricing" };
jest.mock("next/navigation", () => ({
  usePathname: () => pathState.pathname,
}));

const statusMock = getSubscriptionStatus as jest.Mock;

function info(overrides: Record<string, unknown>) {
  return {
    status: "active",
    tier: "premium",
    hasActiveSubscription: true,
    isPremium: true,
    canMintTokens: true,
    currentPeriodEnd: null,
    pastDueSince: null,
    cancelAtPeriodEnd: false,
    features: [],
    requestsPerDay: 0,
    ...overrides,
  };
}

describe("PastDueBanner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    sessionState.status = "authenticated";
    sessionState.userId = "user-1";
    pathState.pathname = "/pricing";
  });

  it("says access continues while Stripe retries, for a past_due subscription inside the grace", async () => {
    statusMock.mockResolvedValue(info({ status: "past_due", hasActiveSubscription: true }));

    render(<PastDueBanner />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Your access continues while Stripe retries");
    expect(screen.getByRole("link", { name: "Update your card" })).toHaveAttribute("href", "/billing/portal");
  });

  it("says access has ended for a past_due subscription past the grace", async () => {
    statusMock.mockResolvedValue(info({ status: "past_due", hasActiveSubscription: false }));

    render(<PastDueBanner />);

    expect(await screen.findByRole("alert")).toHaveTextContent("your paid access has ended");
  });

  it("renders nothing for an active subscription or a free user", async () => {
    statusMock.mockResolvedValue(info({ status: "active" }));
    const { container, unmount } = render(<PastDueBanner />);
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();

    sessionStorage.clear();
    statusMock.mockResolvedValue(info({ status: "inactive", hasActiveSubscription: false }));
    const second = render(<PastDueBanner />);
    await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });

  it("renders nothing when the status cannot be read", async () => {
    statusMock.mockRejectedValue(new Error("backend down"));

    const { container } = render(<PastDueBanner />);

    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("links the card update to /billing/portal, which runs in the browser's own session", async () => {
    statusMock.mockResolvedValue(info({ status: "past_due", hasActiveSubscription: true }));

    render(<PastDueBanner />);

    const link = await screen.findByRole("link", { name: "Update your card" });
    expect(link).toHaveAttribute("href", "/billing/portal");
  });

  it("shows unpaid customers that access is paused until the card is updated, with the same link", async () => {
    statusMock.mockResolvedValue(info({ status: "unpaid", hasActiveSubscription: false }));

    render(<PastDueBanner />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your access is paused until you update your card.");
    expect(screen.getByRole("link", { name: "Update your card" })).toHaveAttribute("href", "/billing/portal");
  });

  it("shows no banner for a canceled customer", async () => {
    statusMock.mockResolvedValue(info({ status: "canceled", hasActiveSubscription: false }));

    const { container } = render(<PastDueBanner />);

    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  describe("where it shows", () => {
    it.each(["/oauth/authorize", "/embed/chart", "/chart/BHP"])(
      "is hidden on the chrome-less route %s, and makes no request there",
      async (pathname) => {
        pathState.pathname = pathname;
        statusMock.mockResolvedValue(info({ status: "past_due", hasActiveSubscription: true }));

        const { container } = render(<PastDueBanner />);

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(container).toBeEmptyDOMElement();
        expect(statusMock).not.toHaveBeenCalled();
      },
    );

    it("makes no request for a visitor who is signed out", async () => {
      sessionState.status = "unauthenticated";
      sessionState.userId = null;

      const { container } = render(<PastDueBanner />);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(container).toBeEmptyDOMElement();
      expect(statusMock).not.toHaveBeenCalled();
    });
  });

  describe("the answer is kept for the session", () => {
    it("asks once, then answers the next page view from the cache", async () => {
      statusMock.mockResolvedValue(info({ status: "past_due", hasActiveSubscription: true }));

      const first = render(<PastDueBanner />);
      await screen.findByRole("alert");
      first.unmount();

      render(<PastDueBanner />);
      expect(await screen.findByRole("alert")).toHaveTextContent("Your access continues");
      expect(statusMock).toHaveBeenCalledTimes(1);
    });

    it("does not reuse another signed-in user's answer", async () => {
      statusMock.mockResolvedValue(info({ status: "past_due", hasActiveSubscription: true }));
      const first = render(<PastDueBanner />);
      await screen.findByRole("alert");
      first.unmount();

      sessionState.userId = "user-2";
      statusMock.mockResolvedValue(info({ status: "active" }));
      const second = render(<PastDueBanner />);

      await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(2));
      expect(second.container).toBeEmptyDOMElement();
    });
  });
});
