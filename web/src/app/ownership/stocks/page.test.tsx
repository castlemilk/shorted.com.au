import { act, render, screen } from "@testing-library/react";

import type { RegistersPage } from "~/app/actions/ownershipExplorer";
import type { RegisterStockRow } from "~/@/components/ownership/register-rows-table";
import { defaultRegistersQuery } from "~/@/lib/ownership/query";
import type { GetOwnershipOverviewResponse } from "~/gen/shorts/v1alpha1/ownership_pb";

import RegistersPageRoute, { metadata, revalidate } from "./page";

const loadStockRegisters = jest.fn();
const getOwnershipOverview = jest.fn();
const bailOnEmptyRender = jest.fn();

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/components/seo/llm-meta", () => ({
  LLMMeta: () => null,
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/getOwnership", () => ({
  getOwnershipOverview: () => getOwnershipOverview(),
}));
jest.mock("~/app/actions/ownershipExplorer", () => ({
  loadStockRegisters: (...args: unknown[]) => loadStockRegisters(...args),
}));

const LEDE =
  "Every stock with a current substantial holder, ranked by what its notices disclose: each interest counted once, not a share of the company, with the index fund and super option figures beside it.";
const TABLE_NAME = "ASX substantial holder registers by stock";

const BHP: RegisterStockRow = {
  code: "BHP",
  companyName: "BHP Group",
  industry: "Materials",
  interests: "7",
  disclosed: "41.20%",
  disclosedPct: 41.2,
  byKind: [
    { kind: "super_fund", pct: 30.1, holders: 3 },
    { kind: "bank_broker", pct: 11.1, holders: 4 },
  ],
  institutions: "30.10%",
  banks: "11.10%",
  hedgeActive: "0.00%",
  index: "5.20%",
  indexAsAt: "as at 2026-09-30 to 2026-10-01",
  superOptions: "4",
  superValue: "$1.2B",
  short: "3.42%",
  shortAsOf: "2026-10-01",
  latestNotice: "2026-10-16",
};

/** The default view as the action answers it: every stock, disclosed largest first, on the first page. */
const registers = (over: Partial<RegistersPage> = {}): RegistersPage => ({
  ok: true,
  activityOk: true,
  error: "",
  query: defaultRegistersQuery(),
  rows: [BHP],
  total: 1,
  asOf: "2026-10-16",
  universe: 1,
  industries: [{ industry: "Materials", stocks: 1 }],
  ...over,
});

/**
 * The overview as the hub's read answers it: the two source ranges the page dates its
 * index fund and super option figures by.
 */
const overview = (over: Partial<GetOwnershipOverviewResponse> = {}): GetOwnershipOverviewResponse =>
  ({
    sources: [
      {
        source: "etf",
        description: "Index fund holdings files",
        funds: 12,
        records: 4100,
        asAtFrom: "2026-09-30",
        asAt: "2026-10-01",
      },
      {
        source: "super_phd",
        description: "Super fund portfolio holdings disclosures",
        funds: 9,
        records: 600,
        asAtFrom: "2026-06-30",
        asAt: "2026-09-30",
      },
    ],
    ...over,
  }) as unknown as GetOwnershipOverviewResponse;

describe("RegistersPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getOwnershipOverview.mockResolvedValue(overview());
  });

  it("draws the default view under its heading and lede, and does not bail when the reads answer", async () => {
    loadStockRegisters.mockResolvedValue(registers());
    const { container } = render(await RegistersPageRoute());

    expect(loadStockRegisters).toHaveBeenCalledWith({});
    expect(screen.getByRole("heading", { level: 1, name: "Registers by stock" })).toBeInTheDocument();
    expect(screen.getByText(LEDE)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: TABLE_NAME })).toBeInTheDocument();
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
    expect(container.querySelector('[data-isr-shell="empty"]')).toBeNull();
  });

  // The lede and the sources claim nothing the page does not date: the figures carry
  // their own ranges, not a claim that each one is dated by a file.
  it("does not claim that each figure is dated by its own file", async () => {
    loadStockRegisters.mockResolvedValue(registers());
    render(await RegistersPageRoute());

    expect(document.body.textContent).not.toMatch(/each dated|dated by its own file/);
  });

  // A read that did not answer is the shell the build draws: the page bails, and the marker names it.
  it("is a shell that bails and carries the re-prime marker when the read did not answer", async () => {
    loadStockRegisters.mockResolvedValue(registers({ ok: false, rows: [], total: 0, asOf: "", universe: 0, industries: [] }));
    const { container } = render(await RegistersPageRoute());
    // The list asks the server again on mount when the read failed: let that answer land inside act.
    await act(async () => {});

    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-isr-shell="empty"]')).not.toBeNull();
  });

  // The list asks its action again on mount when the default read did not answer, with the default sort.
  it("hands the list its action, which it asks again on mount when the read did not answer", async () => {
    loadStockRegisters.mockResolvedValue(registers({ ok: false, rows: [], total: 0, asOf: "", universe: 0, industries: [] }));
    render(await RegistersPageRoute());
    await act(async () => {});

    expect(loadStockRegisters).toHaveBeenCalledTimes(2);
    expect(loadStockRegisters).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "disclosed" }));
  });

  it("draws no market cap column, since no market cap on this surface carries a date", async () => {
    loadStockRegisters.mockResolvedValue(registers());
    render(await RegistersPageRoute());

    expect(screen.queryByRole("columnheader", { name: /market cap/i })).toBeNull();
    expect(screen.queryByText(/market cap/i)).toBeNull();
  });

  it("dates its plate and its method by the newest notice read, and ends with the error report for the registers", async () => {
    loadStockRegisters.mockResolvedValue(registers());
    const { container } = render(await RegistersPageRoute());

    expect(screen.getByText(/Notices read to/)).toHaveTextContent("Notices read to 2026-10-16");
    const method = container.querySelector("section[aria-labelledby='method']") as HTMLElement;
    expect(method).toHaveTextContent(
      "ASX substantial holding notices (Corporations Act s671B, Forms 603, 604 and 605), read from the notice PDF; read to 2026-10-16.",
    );
    expect(screen.getByRole("link", { name: "Report an error" })).toHaveAttribute(
      "href",
      "mailto:support@shorted.com.au?subject=Ownership%20data%3A%20registers",
    );
  });

  // The index fund files and the super fund options each carry the range the overview
  // dates them by, on the plate and in their source lines, as the hub states them.
  it("dates the index fund and super option figures by their own ranges, on the plate and in the sources", async () => {
    loadStockRegisters.mockResolvedValue(registers());
    const { container } = render(await RegistersPageRoute());

    expect(screen.getByText(/index fund files as at/)).toHaveTextContent(
      "index fund files as at 2026-09-30 to 2026-10-01",
    );
    expect(screen.getByText(/super option files as at/)).toHaveTextContent(
      "super option files as at 2026-06-30 to 2026-09-30",
    );
    const method = container.querySelector("section[aria-labelledby='method']") as HTMLElement;
    expect(method).toHaveTextContent(
      "Index fund holdings files (iShares, Vanguard, SPDR, Betashares): 12 files, as at 2026-09-30 to 2026-10-01.",
    );
    expect(method).toHaveTextContent(
      "Super fund portfolio holdings disclosures (one investment option per fund): 9 options, as at 2026-06-30 to 2026-09-30.",
    );
  });

  // The short position figures are ASIC's, published T+4. Each stock's figure is as of its latest report,
  // and the page says so once, on the plate and in the sources, rather than per row.
  it("names the ASIC short position report on the plate, and says each figure is as of its latest report", async () => {
    loadStockRegisters.mockResolvedValue(registers());
    const { container } = render(await RegistersPageRoute());

    expect(screen.getByText(/Notices read to/)).toHaveTextContent("· ASIC shorts T+4 ·");
    const method = container.querySelector("section[aria-labelledby='method']") as HTMLElement;
    expect(method).toHaveTextContent(
      "ASIC short position report, published T+4; each stock's figure is as of its latest report.",
    );
  });

  // A range the overview does not date is left out of the plate and the sources: never printed as n/a.
  it("leaves out a range the overview does not date, and never prints one as n/a", async () => {
    getOwnershipOverview.mockResolvedValue(overview({ sources: [] }));
    loadStockRegisters.mockResolvedValue(registers());
    const { container } = render(await RegistersPageRoute());

    expect(screen.queryByText(/index fund files as at/)).toBeNull();
    expect(screen.queryByText(/super option files as at/)).toBeNull();
    expect(container.textContent).not.toMatch(/as at n\/a/);
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  // The overview carries the dates of the page, so a read that did not answer bails; the list is still drawn.
  it("bails and carries the re-prime marker when the overview did not answer, and still draws the list", async () => {
    getOwnershipOverview.mockResolvedValue(undefined);
    loadStockRegisters.mockResolvedValue(registers());
    const { container } = render(await RegistersPageRoute());

    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-isr-shell="empty"]')).not.toBeNull();
    expect(screen.getByRole("table", { name: TABLE_NAME })).toBeInTheDocument();
    expect(screen.queryByText(/index fund files as at/)).toBeNull();
  });

  it("describes its trail as a BreadcrumbList from the hub, and dates the Dataset by the newest notice", async () => {
    loadStockRegisters.mockResolvedValue(registers());
    const { container } = render(await RegistersPageRoute());

    const blocks = Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map((s) =>
      JSON.parse(s.textContent ?? "{}"),
    );
    const trail = blocks.find((b) => b["@type"] === "BreadcrumbList");
    expect(
      trail.itemListElement.map((i: { position: number; name: string; item: string }) => [i.position, i.name, i.item]),
    ).toEqual([
      [1, "Home", "https://shorted.com.au/"],
      [2, "Ownership", "https://shorted.com.au/ownership"],
      [3, "Registers", "https://shorted.com.au/ownership/stocks"],
    ]);
    const dataset = blocks.find((b) => b["@type"] === "Dataset");
    expect(dataset.dateModified).toBe("2026-10-16");
  });
});

describe("RegistersPage metadata", () => {
  it("is indexable and self-canonical, with the title the list is known by and a one-hour revalidate", () => {
    expect(revalidate).toBe(3600);
    expect(Object.keys(metadata)).not.toContain("robots");
    expect(metadata.alternates?.canonical).toBe("https://shorted.com.au/ownership/stocks");
    expect(metadata.title).toBe("ASX substantial holder registers by stock");
    expect(metadata.twitter).toMatchObject({ site: "@shorted___", creator: "@shorted___" });
  });

  // The route has no card of its own. Its openGraph object replaces the parent's, so it
  // names the hub's card, and the twitter card takes that image.
  it("names the hub's card as its social image", () => {
    expect(metadata.openGraph?.images).toEqual([
      { url: "/ownership/opengraph-image", alt: "Who owns the ASX, on Shorted" },
    ]);
  });
});
