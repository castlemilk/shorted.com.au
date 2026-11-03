import { render, screen, within } from "@testing-library/react";
import type { FundHolding } from "~/gen/shorts/v1alpha1/ownership_pb";
import { POOLED_MARK_SR } from "../pooled-fund-mark";
import { StockFundTable } from "../stock-fund-table";

const fund = (over: Partial<FundHolding> = {}): FundHolding =>
  ({
    institutionSlug: "vanguard",
    institutionName: "Vanguard",
    kind: "index_manager",
    fundName: "Vanguard Australian Shares Index Fund (VAS)",
    fundCode: "VAS",
    sourceKind: "etf",
    asAt: "2026-09-30",
    stockCode: "ZIP",
    companyName: "Zip Co",
    units: 2e7,
    hasUnits: true,
    valueAud: 6.4e7,
    hasValue: true,
    weightPct: 0.12,
    hasWeight: true,
    pctOfIssued: 1.54,
    hasPctOfIssued: true,
    ...over,
  }) as unknown as FundHolding;

const ishares = fund({
  institutionSlug: "ishares",
  institutionName: "iShares",
  fundName: "iShares Core S&P/ASX 200 ETF",
  fundCode: "IOZ",
  asAt: "2026-10-19",
  valueAud: 3e7,
});

const rest = fund({
  institutionSlug: "rest",
  institutionName: "Rest",
  kind: "super_fund",
  fundName: "Growth",
  fundCode: "",
  sourceKind: "super_phd",
  asAt: "2026-06-30",
  // Super disclosures state weights to two decimals: a real holding reads 0.00.
  weightPct: 0,
  valueAud: 2.97e6,
  pctOfIssued: 0.07,
});

const bodyRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);

describe("StockFundTable", () => {
  it("marks only a pooled Vanguard index fund file, and no other row", () => {
    const pooledVanguardSuper = fund({ sourceKind: "super_phd", fundCode: "" });
    render(<StockFundTable rows={[fund(), ishares, pooledVanguardSuper]} code="ZIP" />);
    expect(screen.getAllByText(POOLED_MARK_SR)).toHaveLength(1);
    const first = bodyRows(screen.getByRole("table"))[0]!;
    expect(within(first).getByText(POOLED_MARK_SR)).toBeInTheDocument();
  });

  it("keeps a stated zero beside a real value as under 0.01%, never a holding of nothing", () => {
    render(<StockFundTable rows={[rest]} code="ZIP" />);
    const [row] = bodyRows(screen.getByRole("table"));
    const cells = within(row!).getAllByRole("cell");
    expect(cells[4]!.textContent).toBe("<0.01%");
    // Millions carry one decimal, so 2.97m prints as $3.0M, the figure the page's amount formatter states.
    expect(cells[2]!.textContent).toBe("$3.0M");
  });

  it("prints each row's own as-at date", () => {
    render(<StockFundTable rows={[fund(), rest]} code="ZIP" />);
    const dates = bodyRows(screen.getByRole("table")).map((row) => within(row).getAllByRole("cell").at(-1)!);
    expect(dates.map((cell) => cell.querySelector("time")?.getAttribute("datetime"))).toEqual([
      "2026-09-30",
      "2026-06-30",
    ]);
  });

  it("names each source and links each institution to its page", () => {
    render(<StockFundTable rows={[fund(), rest]} code="ZIP" />);
    const rows = bodyRows(screen.getByRole("table"));
    expect(within(rows[0]!).getAllByRole("cell")[1]!.textContent).toBe("Index fund file");
    expect(within(rows[1]!).getAllByRole("cell")[1]!.textContent).toBe("Super option");
    expect(screen.getByRole("link", { name: "Vanguard" })).toHaveAttribute("href", "/ownership/vanguard");
    expect(screen.getByRole("link", { name: "Rest" })).toHaveAttribute("href", "/ownership/rest");
  });

  it("draws every row with no limit, and no link", () => {
    render(<StockFundTable rows={[fund(), ishares, rest]} code="ZIP" />);
    expect(bodyRows(screen.getByRole("table"))).toHaveLength(3);
    expect(screen.queryByRole("link", { name: /fund rows in the full register/ })).toBeNull();
  });

  it("draws the limit and links to the rest of the funds in the full register", () => {
    render(<StockFundTable rows={[fund(), ishares, rest]} code="ZIP" limit={2} />);
    expect(bodyRows(screen.getByRole("table"))).toHaveLength(2);
    expect(screen.getByRole("link", { name: "All 3 fund rows in the full register →" })).toHaveAttribute(
      "href",
      "/ownership/stocks/ZIP#funds",
    );
  });

  it("takes the link the caller gives for the full register", () => {
    render(<StockFundTable rows={[fund(), ishares]} code="ZIP" limit={1} moreHref="/ownership/stocks/ZIP" />);
    expect(screen.getByRole("link", { name: "All 2 fund rows in the full register →" })).toHaveAttribute(
      "href",
      "/ownership/stocks/ZIP",
    );
  });

  it("prints its caption above the table, outside the scroll box, and describes the table with it", () => {
    render(<StockFundTable rows={[fund()]} code="ZIP" />);
    const caption = screen.getByText(/Index fund figures are the funds' own holdings files/);
    expect(caption.tagName).toBe("P");
    expect(caption.closest(".overflow-auto")).toBeNull();
    expect(screen.getByRole("table")).toHaveAccessibleDescription(/Index fund figures are the funds' own holdings files/);
  });

  it("says no fund holds the stock, and links the hub, when there are no rows", () => {
    render(<StockFundTable rows={[]} code="ZIP" />);
    expect(
      screen.getByText(/No index fund file or super option disclosure tracked holds ZIP\. Only funds that publish/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "the hub lists them" })).toHaveAttribute("href", "/ownership#coverage");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
