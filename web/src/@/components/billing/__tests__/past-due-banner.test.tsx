import { act, render, screen, waitFor } from "@testing-library/react";
import { PastDueBanner } from "../past-due-banner";
import { createPortalSession, getSubscriptionStatus } from "~/app/actions/subscription";

jest.mock("~/app/actions/subscription", () => ({
  getSubscriptionStatus: jest.fn(),
  createPortalSession: jest.fn(),
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
const portalMock = createPortalSession as jest.Mock;

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
    expect(screen.getByRole("button", { name: "Update your card" })).toBeInTheDocument();
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

  it("shows a message, and does not navigate, when the billing page cannot be opened", async () => {
    statusMock.mockResolvedValue(info({ status: "past_due", hasActiveSubscription: true }));
    portalMock.mockResolvedValue({ url: null, error: "Portal service is not configured" });

    render(<PastDueBanner />);
    const button = await screen.findByRole("button", { name: "Update your card" });
    await act(async () => {
      button.click();
    });

    expect(portalMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("We couldn't open the billing page. Try again in a moment.")).toBeInTheDocument();
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
