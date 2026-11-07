/// <reference types="jest" />
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("next-auth/react", () => ({ useSession: jest.fn() }));

const mockList = jest.fn();
const mockUnsave = jest.fn();
jest.mock("~/app/actions/strategies/saved", () => ({
  listSavedStrategies: () => mockList(),
  unsaveStrategy: (ref: string) => mockUnsave(ref),
}));

import { useSession } from "next-auth/react";
import { MyStrategiesIsland, countsLine } from "../my/my-strategies-island";

const mockUseSession = useSession as unknown as jest.Mock;

const SIGNED_IN = { data: { user: { id: "user-a" } }, status: "authenticated" };

const CANSLIM = {
  strategyRef: "canslim",
  strategyId: "canslim",
  name: "CAN SLIM",
  savedAt: "2026-11-01T09:00:00Z",
  counts: { triggered: 2, setup: 1, watch: 9, unknown: 4 },
};
const ZANGER = {
  strategyRef: "zanger-breakout",
  strategyId: "zanger-breakout",
  name: "Zanger Breakout",
  savedAt: "2026-10-20T09:00:00Z",
  counts: { triggered: 0, setup: 3, watch: 5, unknown: 1 },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("MyStrategiesIsland", () => {
  it("draws a loading region while the session is being read, and reads nothing", () => {
    mockUseSession.mockReturnValue({ data: null, status: "loading" });
    render(<MyStrategiesIsland />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("asks an anonymous visitor to sign in, and reads nothing", () => {
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" });
    render(<MyStrategiesIsland />);
    expect(screen.getByText("Sign in to see your strategies")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/signin?callbackUrl=%2Fstrategies%2Fmy",
    );
    expect(mockList).not.toHaveBeenCalled();
  });

  it("draws the empty state when nothing is saved", async () => {
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList.mockResolvedValue({ ok: true, strategies: [], limit: 20 });
    render(<MyStrategiesIsland />);
    expect(await screen.findByText("No saved strategies yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse strategies" })).toHaveAttribute("href", "/strategies");
  });

  it("draws each save with its counts, the count against the limit, and a link to its signals", async () => {
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList.mockResolvedValue({ ok: true, strategies: [CANSLIM, ZANGER], limit: 20 });
    render(<MyStrategiesIsland />);
    expect(await screen.findByRole("link", { name: "CAN SLIM" })).toHaveAttribute(
      "href",
      "/strategies/canslim/signals",
    );
    expect(screen.getByText("2 of 20 saved")).toBeInTheDocument();
    expect(screen.getByText(/2 triggered · 1 setup · 4 unknown · 9 watch/)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("offers a retry when the list cannot be read, and reads again on it", async () => {
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce({ ok: true, strategies: [CANSLIM], limit: 20 });
    render(<MyStrategiesIsland />);
    expect(await screen.findByText("We could not load your saved strategies.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "CAN SLIM" })).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("removes a save from the list only after the API has removed it", async () => {
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList.mockResolvedValue({ ok: true, strategies: [CANSLIM, ZANGER], limit: 20 });
    mockUnsave.mockResolvedValue({ ok: true });
    render(<MyStrategiesIsland />);
    await screen.findByRole("link", { name: "CAN SLIM" });
    fireEvent.click(screen.getByRole("button", { name: "Remove CAN SLIM from My strategies" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "CAN SLIM" })).not.toBeInTheDocument());
    expect(mockUnsave).toHaveBeenCalledWith("canslim");
    expect(screen.getByRole("link", { name: "Zanger Breakout" })).toBeInTheDocument();
  });

  it("keeps a save on the screen when its removal fails", async () => {
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList.mockResolvedValue({ ok: true, strategies: [CANSLIM], limit: 20 });
    mockUnsave.mockResolvedValue({ ok: false, reason: "unavailable" });
    render(<MyStrategiesIsland />);
    await screen.findByRole("link", { name: "CAN SLIM" });
    fireEvent.click(screen.getByRole("button", { name: "Remove CAN SLIM from My strategies" }));
    expect(await screen.findByText("Could not remove that strategy. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "CAN SLIM" })).toBeInTheDocument();
  });

  it("offers a retry when the list read rejects, rather than loading forever", async () => {
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList.mockRejectedValueOnce(new Error("deploy skew"));
    render(<MyStrategiesIsland />);
    expect(await screen.findByText("We could not load your saved strategies.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("re-enables every Remove when a removal rejects, and says it failed", async () => {
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList.mockResolvedValue({ ok: true, strategies: [CANSLIM, ZANGER], limit: 20 });
    mockUnsave.mockRejectedValue(new Error("network down"));
    render(<MyStrategiesIsland />);
    await screen.findByRole("link", { name: "CAN SLIM" });
    fireEvent.click(screen.getByRole("button", { name: "Remove CAN SLIM from My strategies" }));
    expect(await screen.findByText("Could not remove that strategy. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove CAN SLIM from My strategies" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove Zanger Breakout from My strategies" })).toBeEnabled();
  });

  it("names a variant without a registry name, and omits counts it does not have", async () => {
    mockUseSession.mockReturnValue(SIGNED_IN);
    mockList.mockResolvedValue({
      ok: true,
      limit: 20,
      strategies: [{ strategyRef: "variant:v1", strategyId: "", name: "", savedAt: "2026-11-01T09:00:00Z", counts: null }],
    });
    render(<MyStrategiesIsland />);
    expect(await screen.findByText("Variant")).toBeInTheDocument();
    expect(screen.queryByText(/triggered/)).not.toBeInTheDocument();
  });
});

describe("countsLine", () => {
  it("prints the three statuses in order", () => {
    expect(countsLine({ triggered: 1, setup: 2, watch: 3, unknown: 0 })).toBe("1 triggered · 2 setup · 3 watch");
  });
});
