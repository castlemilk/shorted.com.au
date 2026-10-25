import { act, render, screen, waitFor } from "@testing-library/react";
import { PastDueBanner } from "../past-due-banner";
import { createPortalSession, getSubscriptionStatus } from "~/app/actions/subscription";

jest.mock("~/app/actions/subscription", () => ({
  getSubscriptionStatus: jest.fn(),
  createPortalSession: jest.fn(),
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
    cancelAtPeriodEnd: false,
    features: [],
    requestsPerDay: 0,
    ...overrides,
  };
}

describe("PastDueBanner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
