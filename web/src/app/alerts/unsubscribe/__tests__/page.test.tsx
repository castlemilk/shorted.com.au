import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockPauseAlertByToken = jest.fn();
jest.mock("~/app/actions/alert-unsubscribe", () => ({
  pauseAlertByToken: (token: string) => mockPauseAlertByToken(token),
}));

import AlertUnsubscribePage, { metadata } from "../page";

const PAUSED_MONITOR = {
  scope: "stock" as const,
  target: "BHP",
  condition: "short-interest-above" as const,
  threshold: 5,
  cadence: "Daily" as const,
};

function renderPage(token?: string) {
  const searchParams: { t?: string | string[] } =
    token === undefined ? {} : { t: token };
  return render(AlertUnsubscribePage({ searchParams }));
}

describe("/alerts/unsubscribe page", () => {
  beforeEach(() => {
    mockPauseAlertByToken.mockReset();
  });

  it("is noindexed", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("does not pause anything on render", () => {
    renderPage("signed-token");

    expect(
      screen.getByRole("heading", { name: "Pause this alert?" }),
    ).toBeInTheDocument();
    expect(mockPauseAlertByToken).not.toHaveBeenCalled();
  });

  it("pauses when the reader presses the button, then confirms the alert", async () => {
    mockPauseAlertByToken.mockResolvedValueOnce({
      ok: true,
      alreadyPaused: false,
      monitor: PAUSED_MONITOR,
    });
    renderPage("signed-token");

    fireEvent.click(screen.getByRole("button", { name: "Pause this alert" }));

    expect(
      await screen.findByRole("heading", { name: "Alert paused" }),
    ).toBeInTheDocument();
    expect(mockPauseAlertByToken).toHaveBeenCalledWith("signed-token");
    expect(
      screen.getByText(/BHP - short interest above 5% - daily/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "/alerts" })).toHaveAttribute(
      "href",
      "/alerts",
    );
  });

  it("says so when the alert was already paused", async () => {
    mockPauseAlertByToken.mockResolvedValueOnce({
      ok: true,
      alreadyPaused: true,
      monitor: PAUSED_MONITOR,
    });
    renderPage("signed-token");

    fireEvent.click(screen.getByRole("button", { name: "Pause this alert" }));

    expect(
      await screen.findByRole("heading", {
        name: "This alert was already paused.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing changed/)).toBeInTheDocument();
  });

  it("explains an invalid link and points to support", async () => {
    mockPauseAlertByToken.mockResolvedValueOnce({
      ok: false,
      reason: "invalid",
    });
    renderPage("forged-token");

    fireEvent.click(screen.getByRole("button", { name: "Pause this alert" }));

    expect(
      await screen.findByRole("heading", { name: "This link is not valid" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/support@shorted\.com\.au/)).toBeInTheDocument();
  });

  it("says the alert no longer exists when its monitor was deleted", async () => {
    mockPauseAlertByToken.mockResolvedValueOnce({
      ok: false,
      reason: "gone",
    });
    renderPage("signed-token");

    fireEvent.click(screen.getByRole("button", { name: "Pause this alert" }));

    expect(
      await screen.findByRole("heading", {
        name: "That alert no longer exists",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing more to do/)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Something went wrong" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });

  it("offers a retry when the service is unavailable", async () => {
    mockPauseAlertByToken.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
    });
    renderPage("signed-token");

    fireEvent.click(screen.getByRole("button", { name: "Pause this alert" }));

    expect(
      await screen.findByRole("heading", { name: "Something went wrong" }),
    ).toBeInTheDocument();

    mockPauseAlertByToken.mockResolvedValueOnce({
      ok: true,
      alreadyPaused: false,
      monitor: PAUSED_MONITOR,
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alert paused" }),
      ).toBeInTheDocument(),
    );
  });

  it("treats a missing token as invalid without calling the service", () => {
    renderPage();

    expect(
      screen.getByRole("heading", { name: "This link is not valid" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Pause this alert" }),
    ).not.toBeInTheDocument();
    expect(mockPauseAlertByToken).not.toHaveBeenCalled();
  });

  it("takes the first value when the token parameter repeats", async () => {
    renderPage(undefined);
    expect(mockPauseAlertByToken).not.toHaveBeenCalled();

    mockPauseAlertByToken.mockResolvedValueOnce({
      ok: true,
      alreadyPaused: false,
      monitor: PAUSED_MONITOR,
    });
    render(AlertUnsubscribePage({ searchParams: { t: ["first", "second"] } }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Pause this alert" })[0],
    );
    await waitFor(() =>
      expect(mockPauseAlertByToken).toHaveBeenCalledWith("first"),
    );
  });
});
