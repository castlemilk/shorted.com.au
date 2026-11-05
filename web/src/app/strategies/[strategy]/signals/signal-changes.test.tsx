import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSession } from "next-auth/react";

import { SignalChanges, statusWord } from "./signal-changes";
import { getSignalEventsForViewer } from "~/app/actions/strategies/signalEvents";
import type { StrategySignalEventView } from "~/@/lib/strategies/types";

jest.mock("next-auth/react", () => ({ useSession: jest.fn() }));
jest.mock("~/app/actions/strategies/signalEvents", () => ({
  getSignalEventsForViewer: jest.fn(),
}));

const mockUseSession = useSession as unknown as jest.Mock;
const mockGet = getSignalEventsForViewer as unknown as jest.Mock;

function event(index: number, code = `C${index}`): StrategySignalEventView {
  return {
    stockCode: code,
    companyName: "",
    sessionDate: `2026-11-0${(index % 9) + 1}`,
    prevSessionDate: "",
    fromStatus: "setup",
    toStatus: index % 2 === 0 ? "triggered" : "watch",
    score: 60,
    rules: [],
    rulesHash: "3f9a1c2e" + "0".repeat(56),
  };
}

const page = (events: StrategySignalEventView[], nextPageToken = "") => ({
  ok: true as const,
  page: { events, nextPageToken, version: null },
});

beforeEach(() => {
  mockGet.mockReset();
  mockUseSession.mockReturnValue({ status: "authenticated", data: { user: { id: "u1" } } });
});

describe("SignalChanges", () => {
  it("shows the sign-in row to an anonymous visitor and reads nothing", () => {
    mockUseSession.mockReturnValue({ status: "unauthenticated", data: null });
    render(
      <SignalChanges
        strategyId="canslim"
        title="Recent changes"
        returnPath="/strategies/canslim/signals"
        emptyCopy="None yet."
      />,
    );
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link).toHaveAttribute(
      "href",
      "/signin?callbackUrl=%2Fstrategies%2Fcanslim%2Fsignals",
    );
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("holds its place while the session loads, without a call", () => {
    mockUseSession.mockReturnValue({ status: "loading", data: null });
    render(
      <SignalChanges strategyId="canslim" title="Recent changes" returnPath="/x" emptyCopy="None." />,
    );
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("draws a signed-in viewer's changes with their status words, newest first as read", async () => {
    mockGet.mockResolvedValue(page([event(0, "PFP"), event(1, "BHP")]));
    render(
      <SignalChanges strategyId="canslim" title="Recent changes" returnPath="/x" emptyCopy="None." />,
    );
    const items = await screen.findAllByRole("listitem", undefined, { timeout: 5000 });
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("PFP");
    expect(items[0]).toHaveTextContent("Setup to Triggered");
    expect(items[1]).toHaveTextContent("Setup to Watch");
    expect(mockGet).toHaveBeenCalledWith({ strategyId: "canslim", stockCode: undefined, pageSize: 20 });
  });

  it("omits the code in one stock's history, since the panel already names it", async () => {
    mockGet.mockResolvedValue(page([event(0, "PFP")]));
    render(
      <SignalChanges
        strategyId="canslim"
        stockCode="PFP"
        title="This stock's signal history"
        returnPath="/x"
        emptyCopy="None."
        compact
      />,
    );
    const item = await screen.findByRole("listitem", undefined, { timeout: 5000 });
    expect(item).not.toHaveTextContent("PFP");
    expect(mockGet).toHaveBeenCalledWith(expect.objectContaining({ stockCode: "PFP" }));
  });

  it("says when there is no change, in the copy the caller gave", async () => {
    mockGet.mockResolvedValue(page([]));
    render(
      <SignalChanges strategyId="canslim" title="Recent changes" returnPath="/x" emptyCopy="Nothing has moved." />,
    );
    expect(await screen.findByText("Nothing has moved.", undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it("says the changes are unavailable, and asks again on Try again", async () => {
    mockGet
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce(page([event(0, "PFP")]));
    render(
      <SignalChanges strategyId="canslim" title="Recent changes" returnPath="/x" emptyCopy="None." />,
    );
    expect(
      await screen.findByText("The status changes are unavailable right now.", undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("listitem", undefined, { timeout: 5000 })).toHaveTextContent("PFP");
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("appends the next page in order when the viewer asks for more", async () => {
    mockGet
      .mockResolvedValueOnce(page([event(0, "AAA")], "20"))
      .mockResolvedValueOnce(page([event(1, "BBB")], ""));
    render(
      <SignalChanges strategyId="canslim" title="Recent changes" returnPath="/x" emptyCopy="None." />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Show more changes" }, { timeout: 5000 }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getAllByRole("listitem")[1]).toHaveTextContent("BBB");
    expect(mockGet).toHaveBeenLastCalledWith(expect.objectContaining({ pageToken: "20" }));
    expect(screen.queryByRole("button", { name: "Show more changes" })).toBeNull();
  });
});

describe("statusWord", () => {
  it("names each status in words and never by colour", () => {
    expect(statusWord("triggered")).toBe("Triggered");
    expect(statusWord("none")).toBe("Off the list");
    expect(statusWord("")).toBe("n/a");
  });
});
