import { fireEvent, render, screen, within } from "@testing-library/react";

import { SourceDatesPopover } from "../source-dates-popover";
import type { StrategyDataStatusView } from "~/@/lib/strategies/types";

function report(index: number) {
  const day = String(28 - index).padStart(2, "0");
  return {
    reportDate: `2026-10-${day}`,
    availableDate: "2026-11-03",
    firstIngestedAt: "2026-10-28",
    rows: 1800 + index,
    complete: index !== 3,
  };
}

const STATUS: StrategyDataStatusView = {
  latestSession: "2026-11-04",
  pricesCompletedAt: "2026-11-04",
  snapshotAsOf: "2026-11-04",
  snapshotCompletedAt: "2026-11-04",
  nextUpdateUtc: "2026-11-05T03:00:00Z",
  pricedCodes: 2100,
  asicReports: Array.from({ length: 12 }, (_, i) => report(i)),
};

describe("SourceDatesPopover", () => {
  it("reads nothing until it is opened, then lists the ten newest reports", async () => {
    const load = jest.fn(async () => STATUS);
    render(<SourceDatesPopover load={load} />);

    const trigger = screen.getByRole("button", { name: "View source dates" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(load).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    const table = await screen.findByRole("table", undefined, {
      timeout: 5000,
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const rows = within(table).getAllByRole("rowheader");
    expect(rows).toHaveLength(10);
    expect(rows[0]).toHaveTextContent("28 Oct 2026");
    expect(rows[9]).toHaveTextContent("19 Oct 2026");
    expect(within(table).getAllByText("3 Nov 2026")).toHaveLength(10);
  });

  it("marks a partial report and states the latest prices", async () => {
    render(<SourceDatesPopover load={async () => STATUS} />);
    fireEvent.click(screen.getByRole("button", { name: "View source dates" }));
    const table = await screen.findByRole("table", undefined, {
      timeout: 5000,
    });
    expect(within(table).getAllByText("Partial")).toHaveLength(1);
    expect(screen.getByText(/Latest prices/)).toBeInTheDocument();
    expect(screen.getByText("2,100")).toBeInTheDocument();
  });

  it("says the dates are unavailable and retries on a second open", async () => {
    const load = jest
      .fn<Promise<StrategyDataStatusView | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(STATUS);
    render(<SourceDatesPopover load={load} />);

    const trigger = screen.getByRole("button", { name: "View source dates" });
    fireEvent.click(trigger);
    expect(
      await screen.findByText(
        "The source dates are unavailable right now.",
        undefined,
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("table", undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
