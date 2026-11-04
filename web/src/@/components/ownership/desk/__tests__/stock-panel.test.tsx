import { fireEvent, render, screen, within } from "@testing-library/react";

import { StockPanel, type StockPanelPage } from "../stock-panel";

function page(overrides: Partial<StockPanelPage> = {}): StockPanelPage {
  return {
    ok: true,
    code: "BHP",
    companyName: "BHP Group",
    disclosed: [
      { kind: "super_fund", pct: 30.1, holders: 3 },
      { kind: "bank_broker", pct: 11.1, holders: 4 },
    ],
    disclosedPct: 41.2,
    largest: [
      { name: "Super Fund A", slug: "super-a", holderKey: "name:super-a", kind: "super_fund", votingPowerPct: 7.5, asAt: "2026-09-30" },
      { name: "Hedge Fund B", slug: "", holderKey: "", kind: "hedge_fund", votingPowerPct: 5.04, asAt: "" },
    ],
    index: { pct: null, asAt: "" },
    notices: [{ announcedOn: "2026-10-16", form: "604", ceased: false, holderName: "Super Fund A" }],
    ...overrides,
  };
}

describe("StockPanel", () => {
  it("prints the register: the bar, the largest holders with their dates, and the latest notices", async () => {
    render(<StockPanel code="BHP" loadPanel={async () => page()} scaleMax={100} onClose={jest.fn()} />);
    expect(await screen.findByRole("heading", { name: "BHP Group" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Disclosed voting power 41\.20%, what the notices disclose/ })).toBeInTheDocument();
    expect(screen.getByText("What the notices disclose, each interest counted once; not a share of the company.")).toBeInTheDocument();

    const holders = screen.getByRole("region", { name: "Largest holders" });
    expect(within(holders).getByText("Super Fund A").closest("a")).toHaveAttribute("href", "/ownership/super-a");
    expect(within(holders).getByText("Hedge Fund B")).toBeInTheDocument();
    expect(within(holders).getByText("7.50%")).toBeInTheDocument();
    expect(holders.querySelector('time[datetime="2026-09-30"]')).not.toBeNull();

    const notices = screen.getByRole("region", { name: "Latest notices" });
    expect(within(notices).getByText("Changed: Super Fund A")).toBeInTheDocument();
    expect(notices.querySelector('time[datetime="2026-10-16"]')).not.toBeNull();
  });

  it("says n/a, never 0, for an index share or a short position it does not hold", async () => {
    render(<StockPanel code="BHP" loadPanel={async () => page()} scaleMax={100} onClose={jest.fn()} />);
    await screen.findByRole("heading", { name: "BHP Group" });
    expect(screen.getByText("no file tracked holds it")).toBeInTheDocument();
    expect(screen.getAllByText("n/a").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("0.00%")).toBeNull();
  });

  it("prints the index share with its date, and never the short position: the panel links it", async () => {
    render(
      <StockPanel
        code="BHP"
        loadPanel={async () => page({ index: { pct: 5.2, asAt: "2026-09-30" } })}
        scaleMax={100}
        onClose={jest.fn()}
      />,
    );
    await screen.findByRole("heading", { name: "BHP Group" });
    expect(screen.getByText("5.20%", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("3.42%", { exact: false })).toBeNull();
    expect(screen.queryByText(/\(ASIC, T\+4\)/)).toBeNull();
    expect(screen.queryByText("Short interest")).toBeNull();
  });

  it("prints each holder's figure at two decimals, where the notice states four (spec A4)", async () => {
    render(
      <StockPanel
        code="BHP"
        loadPanel={async () =>
          page({
            largest: [
              { name: "Super Fund A", slug: "super-a", holderKey: "name:super-a", kind: "super_fund", votingPowerPct: 19.4336, asAt: "2026-09-30" },
              { name: "Hedge Fund B", slug: "", holderKey: "", kind: "hedge_fund", votingPowerPct: 5, asAt: "" },
            ],
            index: { pct: 13.131, asAt: "2026-09-30" },
          })
        }
        scaleMax={100}
        onClose={jest.fn()}
      />,
    );
    await screen.findByRole("heading", { name: "BHP Group" });
    const holders = screen.getByRole("region", { name: "Largest holders" });
    expect(within(holders).getByText("19.43%")).toBeInTheDocument();
    expect(within(holders).getByText("5.00%")).toBeInTheDocument();
    expect(screen.queryByText("19.4336%", { exact: false })).toBeNull();
    expect(screen.getByText("13.13%", { exact: false })).toBeInTheDocument();
  });

  it("links the short position beside the record, and never prints it in the panel", async () => {
    render(<StockPanel code="BHP" loadPanel={async () => page({})} scaleMax={100} onClose={jest.fn()} />);
    await screen.findByRole("heading", { name: "BHP Group" });
    expect(screen.getByRole("link", { name: "Short interest →" })).toHaveAttribute("href", "/shorts/BHP/short-interest");
    expect(screen.queryByText("3.42%", { exact: false })).toBeNull();
  });

  it("links the record: the register, the overview and the notices for the stock", async () => {
    render(<StockPanel code="BHP" loadPanel={async () => page()} scaleMax={100} onClose={jest.fn()} />);
    await screen.findByRole("heading", { name: "BHP Group" });
    expect(screen.getByRole("link", { name: "Full register" })).toHaveAttribute("href", "/ownership/stocks/BHP");
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/shorts/BHP");
    const all = screen.getByRole("link", { name: "All notices for BHP" });
    expect(all).toHaveAttribute("href", "/ownership/notices?window=all&stock=BHP");
    expect(all).toHaveAttribute("rel", "nofollow");
  });

  it("says no holder is read for a stock with none, and never prints a zero share", async () => {
    render(<StockPanel code="CBA" loadPanel={async () => page({ code: "CBA", largest: [], notices: [] })} scaleMax={100} onClose={jest.fn()} />);
    expect(await screen.findByText("No current substantial holder read for CBA.")).toBeInTheDocument();
    expect(screen.getByText("No substantial holding notice read for CBA.")).toBeInTheDocument();
  });

  it("says the register could not be read, when the read fails", async () => {
    render(<StockPanel code="BHP" loadPanel={async () => page({ ok: false })} scaleMax={100} onClose={jest.fn()} />);
    expect(await screen.findByText(/This stock's register could not be read just now/)).toBeInTheDocument();
  });

  it("closes through its own button, labelled with the stock", async () => {
    const onClose = jest.fn();
    render(<StockPanel code="BHP" loadPanel={async () => page()} scaleMax={100} onClose={onClose} />);
    await screen.findByRole("heading", { name: "BHP Group" });
    fireEvent.click(screen.getByRole("button", { name: "Close BHP" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is a labelled region, not a dialog", async () => {
    render(<StockPanel code="BHP" loadPanel={async () => page()} scaleMax={100} onClose={jest.fn()} />);
    await screen.findByRole("heading", { name: "BHP Group" });
    expect(screen.getByRole("complementary", { name: "BHP Group" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
