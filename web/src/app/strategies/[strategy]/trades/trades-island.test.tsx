import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TradesIsland } from "./trades-island";
import { TRADES_SIGN_IN_COPY } from "~/@/lib/strategies/backtest-copy";
import { mapBacktestTradesPage } from "~/@/lib/strategies/map-backtest";

const useSession = jest.fn();
const listBacktestTrades = jest.fn();

jest.mock("next-auth/react", () => ({
  useSession: () => useSession(),
}));
jest.mock("~/app/actions/strategies/backtestTrades", () => ({
  listBacktestTrades: (...args: unknown[]) => listBacktestTrades(...args),
}));

const page = mapBacktestTradesPage({
  trades: [
    {
      seq: 1,
      stockCode: "BHP",
      companyName: "BHP Group",
      signalDate: "2024-03-01",
      entryDate: "2024-03-04",
      entryPrice: 44.2,
      exitDate: "2024-04-10",
      exitPrice: 47.9,
      exitReason: "pivot_stop",
      sessionsHeld: 26,
      netReturnPct: 7.4,
    },
  ],
  nextPageToken: "",
  total: 1,
});

describe("the trades island", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows an anonymous visitor the sign-in line in place of the list, and asks the API for nothing", () => {
    useSession.mockReturnValue({ data: null, status: "unauthenticated" });
    render(<TradesIsland runId={42} exitReasons={["pivot_stop"]} />);
    expect(screen.getByText(TRADES_SIGN_IN_COPY)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
    expect(listBacktestTrades).not.toHaveBeenCalled();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("loads the first page for a signed-in reader and draws its trades", async () => {
    useSession.mockReturnValue({ data: { user: { id: "u1" } }, status: "authenticated" });
    listBacktestTrades.mockResolvedValue({ ok: true, page });
    render(<TradesIsland runId={42} exitReasons={["pivot_stop"]} />);
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    expect(listBacktestTrades).toHaveBeenCalledWith(expect.objectContaining({ runId: 42, pageToken: "" }));
    expect(screen.getByText("BHP")).toBeInTheDocument();
    expect(screen.getAllByText("Closed below the captured pivot").length).toBeGreaterThan(0);
  });

  it("filters by stock and exit reason, and asks the API again", async () => {
    useSession.mockReturnValue({ data: { user: { id: "u1" } }, status: "authenticated" });
    listBacktestTrades.mockResolvedValue({ ok: true, page });
    render(<TradesIsland runId={42} exitReasons={["pivot_stop", "time_stop"]} />);
    await waitFor(() => expect(listBacktestTrades).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Stock"), { target: { value: "bhp" } });
    fireEvent.change(screen.getByLabelText("Exit"), { target: { value: "time_stop" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(listBacktestTrades).toHaveBeenCalledTimes(2));
    expect(listBacktestTrades).toHaveBeenLastCalledWith(
      expect.objectContaining({ stockCode: "BHP", exitReason: "time_stop" }),
    );
  });

  it("says the trades are unavailable when the read fails", async () => {
    useSession.mockReturnValue({ data: { user: { id: "u1" } }, status: "authenticated" });
    listBacktestTrades.mockResolvedValue({ ok: false, reason: "unavailable" });
    render(<TradesIsland runId={42} exitReasons={[]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The trades are unavailable right now.");
  });
});
