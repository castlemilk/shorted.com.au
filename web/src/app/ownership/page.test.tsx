import { render, screen, within } from "@testing-library/react";
import { getStockOwnership } from "~/app/actions/getOwnership";
import type {
  GetOwnershipOverviewResponse,
  OwnershipSource,
  WithheldOutcome,
} from "~/gen/shorts/v1alpha1/ownership_pb";

import OwnershipPage, { metadata } from "./page";

const getOwnershipOverview = jest.fn();
const listInstitutions = jest.fn();
const bailOnEmptyRender = jest.fn();
const loadOwnershipMap = jest.fn();
const loadOwnershipFlows = jest.fn();
const loadOwnershipActivity = jest.fn();
const loadFundPositionChanges = jest.fn();
const loadStockFundSeries = jest.fn();
const loadStockPanel = jest.fn(async () => ({ ok: false }));
const movementHeatmap = jest.fn();
const mockOwnershipMap = jest.fn();
// While set, the islands' URL read suspends, so only the server's static fallback can draw.
let mockHoldSearchParams = false;

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
  listInstitutions: (...args: unknown[]) => listInstitutions(...args),
  getStockOwnership: jest.fn(),
}));
jest.mock("~/app/actions/ownershipDesk", () => ({
  loadOwnershipMap: (...args: unknown[]) => loadOwnershipMap(...args),
  loadOwnershipFlows: (...args: unknown[]) => loadOwnershipFlows(...args),
  loadOwnershipActivity: (...args: unknown[]) => loadOwnershipActivity(...args),
  loadFundPositionChanges: (...args: unknown[]) => loadFundPositionChanges(...args),
  loadStockFundSeries: (...args: unknown[]) => loadStockFundSeries(...args),
  loadStockPanel: (...args: unknown[]) => loadStockPanel(...args),
}));
// The islands read the URL under their own Suspense; the page's own render sees no query.
// The movement island is stubbed so its props can be read; the page's wiring is what is under test.
jest.mock("~/@/components/ownership/desk/movement-heatmap", () => ({
  MovementHeatmap: (props: object) => {
    movementHeatmap(props);
    return null;
  },
}));
// The map is passed through, so its real render stays under test while its props are read.
jest.mock("~/@/components/ownership/desk/ownership-map", () => {
  const actual = jest.requireActual("~/@/components/ownership/desk/ownership-map");
  return {
    ...actual,
    OwnershipMap: (props: object) => {
      mockOwnershipMap(props);
      return <actual.OwnershipMap {...props} />;
    },
  };
});
// The combobox reads the popover API on mount, which jsdom does not have: the toolbar's search is a labelled stub.
jest.mock("~/@/components/gamma/SearchCombobox", () => ({
  SearchCombobox: ({ label }: { label: string }) => <div role="search" aria-label={label} />,
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => {
    if (mockHoldSearchParams) throw new Promise(() => {});
    return new URLSearchParams();
  },
  usePathname: () => "/ownership",
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

const overview = (over: Partial<GetOwnershipOverviewResponse> = {}): GetOwnershipOverviewResponse =>
  ({
    kinds: [],
    topHolders: [],
    crowded: [],
    crowdedBothWays: [],
    lending: [],
    recent: [],
    superConsensus: [],
    passive: [],
    sources: [],
    noticesParsed: 0,
    noticesWithheld: 0,
    superFunds: 0,
    superAssetsAud: 0,
    etfs: 0,
    etfFumAud: 0,
    lics: 0,
    licMarketCapAud: 0,
    asOf: "",
    ...over,
  }) as unknown as GetOwnershipOverviewResponse;

const mapStock = (code: string, marketCap: number, disclosedPct: number) => ({
  code,
  name: `${code} Ltd`,
  industry: "Materials",
  marketCap,
  disclosedPct,
  institutionalPct: disclosedPct,
  hedgePct: 0,
  indexPct: null,
  shortPct: null,
  flowPp: null,
  notices: 1,
});

const ACTIVITY_ROWS = [
  { industry: "Materials", weekStart: "2026-11-02", became: 10, increased: 5, decreased: 3, changed: 0, ceased: 2, nz: 1, netPp: 1 },
  { industry: "Financials", weekStart: "2026-11-02", became: 20, increased: 0, decreased: 0, changed: 0, ceased: 0, nz: 0, netPp: null },
  // The week before is not this week: it is never summed into the band's figure.
  { industry: "Materials", weekStart: "2026-10-26", became: 99, increased: 0, decreased: 0, changed: 0, ceased: 0, nz: 0, netPp: 2 },
];

const activityPage = (over: Record<string, unknown> = {}) => ({
  ok: true,
  error: "",
  fromWeek: "2026-10-26",
  toWeek: "2026-11-02",
  asOf: "2026-11-03",
  rows: ACTIVITY_ROWS,
  ...over,
});

const deskDefaults = () => {
  loadOwnershipMap.mockResolvedValue({
    ok: true,
    error: "",
    from: "",
    to: "",
    asOf: "2026-10-16",
    stocks: [mapStock("BHP", 200e9, 12.5), mapStock("CBA", 150e9, 8), mapStock("ZIP", 1e9, 0)],
  });
  loadOwnershipFlows.mockResolvedValue({ ok: true, error: "", from: "", to: "", asOf: "2026-10-16", positions: [], changes: [] });
  loadOwnershipActivity.mockResolvedValue(activityPage({ asOf: "2026-10-16" }));
  loadFundPositionChanges.mockResolvedValue({ ok: true, error: "", snapshotDates: [], from: "", to: "", rows: [] });
};

/** The headline band, the page's coverage section (backlog B2). */
const band = (container: HTMLElement) => container.querySelector("#coverage") as HTMLElement;

describe("OwnershipPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listInstitutions.mockResolvedValue({ institutions: [], total: 0 });
    deskDefaults();
  });

  it.each([
    ["the read failed", undefined],
    ["the first collection has not run", overview()],
  ])("says the data is not available yet when %s, and draws no empty tables", async (_, data) => {
    getOwnershipOverview.mockResolvedValue(data);
    const { container } = render(await OwnershipPage());

    expect(screen.getByRole("heading", { level: 1, name: "The ownership landscape" })).toBeInTheDocument();
    expect(screen.getByText(/Ownership data is not available yet/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Market map" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(container.querySelector("nav[aria-label='Records']")).toBeNull();
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });

  it("draws the views once notices have been read, with the band's notice sentence", async () => {
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 7118, superFunds: 72, asOf: "2026-10-16" }));
    const { container } = render(await OwnershipPage());

    expect(band(container)).toHaveTextContent("7,118 notices read to 2026-10-16");
    // The plate and the band both print the dates; the plate comes first.
    expect(screen.getAllByText(/Notices read to/)[0]).toHaveTextContent("Notices read to 2026-10-16");
    expect(screen.queryByText(/Ownership data is not available yet/)).toBeNull();
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });
});

describe("OwnershipPage desk", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listInstitutions.mockResolvedValue({ institutions: [], total: 0 });
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 7118, superFunds: 72, asOf: "2026-10-16" }));
    deskDefaults();
  });

  it("draws the instruments in the desk's order, with the band above them and the records and method after", async () => {
    const { container } = render(await OwnershipPage());

    const order = [
      "#coverage",
      "#desk-map",
      "#desk-flows",
      "#desk-movement",
      "section[aria-label='Index fund positions']",
      "nav[aria-label='Records']",
      "details#method",
    ];
    const nodes = order.map((selector) => {
      const node = container.querySelector(selector);
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i - 1].compareDocumentPosition(nodes[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("carries the map's default view in the HTML, drawn by the server", async () => {
    const { container } = render(await OwnershipPage());

    const map = container.querySelector("#desk-map")?.parentElement;
    expect(map?.querySelector("svg")).not.toBeNull();
  });

  it("draws the map's static fallback while the live island waits on the URL", async () => {
    mockHoldSearchParams = true;
    try {
      const { container } = render(await OwnershipPage());

      const map = container.querySelector("#desk-map")?.parentElement;
      expect(map?.querySelector('[data-code="BHP"]')).not.toBeNull();
    } finally {
      mockHoldSearchParams = false;
    }
  });

  it("reads each instrument's default view with no query, and bails nothing when every read works", async () => {
    render(await OwnershipPage());

    expect(loadOwnershipMap).toHaveBeenCalledWith({});
    expect(loadOwnershipFlows).toHaveBeenCalledWith({});
    expect(loadOwnershipActivity).toHaveBeenCalledWith({});
    expect(loadFundPositionChanges).toHaveBeenCalledWith({});
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  // A failed read carries the same fields as an answered one, with the rows empty.
  const failedInstrument: Record<string, unknown> = {
    loadOwnershipMap: { ok: false, error: "", from: "", to: "", asOf: "", stocks: [] },
    loadOwnershipFlows: { ok: false, error: "", from: "", to: "", asOf: "", positions: [], changes: [] },
    loadOwnershipActivity: { ok: false, error: "", fromWeek: "", toWeek: "", asOf: "", rows: [] },
    loadFundPositionChanges: { ok: false, error: "", snapshotDates: [], from: "", to: "", rows: [] },
  };

  it.each([
    ["the map", "loadOwnershipMap"],
    ["the flows", "loadOwnershipFlows"],
    ["the movement", "loadOwnershipActivity"],
    ["the index fund window", "loadFundPositionChanges"],
  ])("bails the cache when %s cannot be read, and still draws the page", async (_name, loader) => {
    const loaders: Record<string, jest.Mock> = {
      loadOwnershipMap,
      loadOwnershipFlows,
      loadOwnershipActivity,
      loadFundPositionChanges,
    };
    loaders[loader].mockResolvedValue(failedInstrument[loader]);
    const { container } = render(await OwnershipPage());

    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Market map" })).toBeInTheDocument();
    expect(band(container)).toBeInTheDocument();
  });

  it("hands the map the action's stock-panel loader, not a loader of its own", async () => {
    render(await OwnershipPage());

    const props = mockOwnershipMap.mock.calls.at(-1)?.[0] as { loadPanel: (code: unknown) => Promise<{ ok: boolean }> };
    expect(typeof props.loadPanel).toBe("function");
    await props.loadPanel("BHP");
    expect(loadStockPanel).toHaveBeenCalledWith("BHP");
    expect(getStockOwnership).not.toHaveBeenCalled();
  });

  it("gives the Overview's market map and notice activity the Changed sort, which a link can change (backlog C3)", async () => {
    render(await OwnershipPage());

    const map = mockOwnershipMap.mock.calls.at(-1)?.[0] as { variant?: string; sort?: string };
    expect(map.variant).toBe("compact");
    expect(map.sort).toBe("changed");
    const heatmap = movementHeatmap.mock.calls.at(-1)?.[0] as { variant?: string; sort?: string };
    expect(heatmap.variant).toBe("compact");
    expect(heatmap.sort).toBe("changed");
  });

  it("hands the movement island the activity loader, so its window and brush can redraw", async () => {
    render(await OwnershipPage());

    const props = movementHeatmap.mock.calls[0][0] as { variant?: string; loadActivity?: (input: { weeks?: number }) => Promise<unknown> };
    expect(props.variant).toBe("compact");
    expect(typeof props.loadActivity).toBe("function");
    await props.loadActivity?.({ weeks: 8 });
    expect(loadOwnershipActivity).toHaveBeenLastCalledWith({ weeks: 8 });
  });
});

const outcome = (name: string, count: number) => ({ outcome: name, count }) as unknown as WithheldOutcome;
const source = (over: Partial<OwnershipSource>) =>
  ({ source: "", description: "", asAt: "", asAtFrom: "", records: 0, funds: 0, ...over }) as unknown as OwnershipSource;

describe("OwnershipPage headline band (backlog B2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listInstitutions.mockResolvedValue({ institutions: [], total: 0 });
    deskDefaults();
  });

  it("states the four figures as sentences, with the notices' newest week", async () => {
    getOwnershipOverview.mockResolvedValue(
      overview({
        noticesParsed: 18173,
        superFunds: 72,
        etfs: 471,
        asOf: "2026-11-03",
        documentsAttempted: 26819,
        withheldByOutcome: [outcome("no_text", 7518)],
        sources: [
          source({ source: "etf", funds: 11, asAtFrom: "2026-09-30", asAt: "2026-11-02" }),
          source({ source: "super_phd", funds: 72, asAtFrom: "2026-06-30", asAt: "2026-06-30" }),
        ],
      }),
    );
    const { container } = render(await OwnershipPage());

    expect(band(container)).toHaveTextContent("18,173 notices read to 2026-11-03, 41 released this week");
    expect(band(container)).toHaveTextContent("7,518 notices withheld of 26,819 documents attempted");
    expect(band(container)).toHaveTextContent("11 of 471 ASX ETFs tracked, files as at 2026-09-30 to 2026-11-02");
    expect(band(container)).toHaveTextContent("72 of 72 APRA super funds tracked, one option each, as at 2026-06-30");
    // The figures are mono; the words around them are not.
    const figures = Array.from(band(container).querySelectorAll("span.font-mono")).map((node) => node.textContent);
    expect(figures).toEqual(expect.arrayContaining(["18,173", "41", "7,518", "26,819", "11", "471"]));
  });

  it("drops the this-week clause when the activity read is not ok", async () => {
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 18173, superFunds: 72, asOf: "2026-11-03" }));
    loadOwnershipActivity.mockResolvedValue(activityPage({ ok: false, error: "", rows: [] }));
    const { container } = render(await OwnershipPage());

    expect(band(container)).toHaveTextContent("18,173 notices read to 2026-11-03");
    expect(band(container).textContent).not.toContain("released this week");
  });

  it("drops the this-week clause when the activity names no week", async () => {
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 18173, superFunds: 72, asOf: "2026-11-03" }));
    loadOwnershipActivity.mockResolvedValue(activityPage({ fromWeek: "", toWeek: "", rows: [] }));
    const { container } = render(await OwnershipPage());

    expect(band(container).textContent).not.toContain("released this week");
  });

  it("prints n/a for an index fund count the API does not hold, with no date clause", async () => {
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 7118, superFunds: 72, asOf: "2026-10-16" }));
    const { container } = render(await OwnershipPage());

    expect(band(container)).toHaveTextContent("n/a index funds tracked");
    expect(band(container).textContent).not.toContain("as at n/a");
  });

  it("counts the six withholding outcomes, sets the two that are not withheld aside in the sentence, and keeps the breakdown folded", async () => {
    getOwnershipOverview.mockResolvedValue(
      overview({
        noticesParsed: 7118,
        superFunds: 72,
        asOf: "2026-10-16",
        documentsAttempted: 7132,
        withheldByOutcome: [
          outcome("no_text", 3),
          outcome("no_voting_power", 2),
          outcome("not_a_notice", 9),
          outcome("fetch_error", 4),
        ],
      }),
    );
    const { container } = render(await OwnershipPage());

    // Read, withheld and set aside add up to the documents attempted, so the band reconciles.
    expect(band(container)).toHaveTextContent("5 notices withheld, 13 set aside, of 7,132 documents attempted");
    const breakdown = within(band(container)).getByText("By outcome");
    expect(breakdown.closest("details")).not.toBeNull();
    expect(
      screen.getByText(/A further 9 documents were not substantial holding forms and 4 have not yet been downloaded/),
    ).toBeInTheDocument();
  });

  // The plate is the one place the page states the dates its figures are read
  // to. Each source carries its own span, so the plate does not share one date.
  it("dates the plate's index and super files by the span each covers", async () => {
    getOwnershipOverview.mockResolvedValue(
      overview({
        noticesParsed: 7118,
        superFunds: 72,
        asOf: "2026-10-16",
        sources: [
          source({ source: "etf", funds: 11, asAt: "2026-10-19", asAtFrom: "2026-09-30" }),
          source({ source: "super_phd", funds: 40, asAt: "2026-06-30", asAtFrom: "2026-06-30" }),
        ],
      }),
    );
    render(await OwnershipPage());

    expect(screen.getAllByText(/index fund files as at/)[0]).toHaveTextContent(
      "Notices read to 2026-10-16 · index fund files as at 2026-09-30 to 2026-10-19 · super option files as at 2026-06-30 · ASIC shorts T+4 · Not financial advice",
    );
  });
});

describe("OwnershipPage records and panes (backlog B2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getOwnershipOverview.mockResolvedValue(
      overview({ noticesParsed: 7118, superFunds: 72, asOf: "2026-10-16", topHolders: [{ slug: "vanguard" } as never] }),
    );
    listInstitutions.mockResolvedValue({ institutions: [], total: 412 });
    deskDefaults();
  });

  it("links the five records with their counts, and leaves out a count the page does not hold", async () => {
    const { container } = render(await OwnershipPage());

    const records = within(container.querySelector("nav[aria-label='Records']") as HTMLElement);
    expect(records.getByRole("link", { name: "Stocks on the map · 3" })).toHaveAttribute("href", "/ownership/stocks");
    // The holders list is capped by the API, so the record carries no count.
    expect(records.getByRole("link", { name: "Biggest holders" })).toHaveAttribute("href", "/ownership/holders");
    // Registers are the stocks with a disclosed holding: ZIP has none.
    expect(records.getByRole("link", { name: "Registers · 2" })).toHaveAttribute("href", "/ownership/stocks");
    expect(records.getByRole("link", { name: "Latest notices · 7,118" })).toHaveAttribute("href", "/ownership/notices");
    expect(records.getByRole("link", { name: "Institutions on the map · 412" })).toHaveAttribute("href", "/ownership/holders");
    expect(records.getAllByRole("link")).toHaveLength(5);
  });

  it("omits a record's count when the directory's total is not held", async () => {
    listInstitutions.mockResolvedValue(undefined);
    const { container } = render(await OwnershipPage());

    const records = within(container.querySelector("nav[aria-label='Records']") as HTMLElement);
    expect(records.getByRole("link", { name: "Institutions on the map" })).toBeInTheDocument();
    expect(records.queryByRole("link", { name: /Institutions on the map · / })).toBeNull();
  });

  it("makes each pane's title the link to its own page, with no arrow", async () => {
    const { container } = render(await OwnershipPage());

    const link = (selector: string, name: string) => within(container.querySelector(selector) as HTMLElement).getByRole("link", { name });
    expect(link("#desk-map", "Market map")).toHaveAttribute("href", "/ownership/map");
    expect(link("#desk-flows", "Disclosed exposure")).toHaveAttribute("href", "/ownership/connections");
    expect(link("#desk-movement", "Notice activity")).toHaveAttribute("href", "/ownership/activity");
    expect(
      within(container.querySelector("section[aria-label='Index fund positions']") as HTMLElement).getByRole("link", {
        name: "Index fund positions",
      }),
    ).toHaveAttribute("href", "/ownership/map?lens=index_flow");
    for (const heading of screen.getAllByRole("heading", { level: 2 })) {
      expect(heading.textContent).not.toMatch(/↗/);
    }
  });

  it("fixes the two rows of panes at their heights from lg, and gives no pane a control row of its own", async () => {
    const { container } = render(await OwnershipPage());

    expect(container.querySelector("#desk-map")?.closest("section")).toHaveClass("lg:h-[420px]", "lg:overflow-hidden");
    expect(container.querySelector("#desk-flows")?.closest("section")).toHaveClass("lg:h-[420px]", "lg:overflow-hidden");
    expect(container.querySelector("#desk-movement")?.closest("section")).toHaveClass("lg:h-[320px]", "lg:overflow-hidden");
    expect(container.querySelector("section[aria-label='Index fund positions']")).toHaveClass("lg:h-[320px]");
    // The only toolbar on the hub is the one row at the top: the panes draw none.
    expect(container.querySelectorAll("[data-toolbar]")).toHaveLength(1);
  });

  it("names no record section as a closed expander: the record pages hold the tables", async () => {
    const { container } = render(await OwnershipPage());

    for (const id of ["#map", "#holders", "#registers", "#notices", "#directory"]) {
      expect(container.querySelector(`details${id}`)).toBeNull();
    }
    expect(screen.queryByRole("heading", { name: "The biggest holders" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Latest notices" })).toBeNull();
  });
});

describe("OwnershipPage toolbar and method (backlog B2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 7118, superFunds: 72, asOf: "2026-10-16" }));
    listInstitutions.mockResolvedValue({ institutions: [], total: 0 });
    deskDefaults();
  });

  it("draws one toolbar row with the search first, then the Source and the Window selects", async () => {
    const { container } = render(await OwnershipPage());

    const row = container.querySelector("[data-toolbar]") as HTMLElement;
    const controls = Array.from(row.querySelectorAll("input, select, [role='search']")).map((node) => node.getAttribute("aria-label") ?? node.getAttribute("name") ?? node.tagName);
    expect(controls[0]).toBe("Find a stock or holder");
    expect(within(row).getByRole("combobox", { name: "Source" })).toBeInTheDocument();
    expect(within(row).getByRole("combobox", { name: "Window" })).toHaveValue("91");
    expect(row.textContent).toContain("Substantial notices");
  });

  it("folds the one row under 'Adjust view' below sm", async () => {
    const { container } = render(await OwnershipPage());

    const row = container.querySelector("[data-toolbar]") as HTMLElement;
    const fold = row.closest("details");
    expect(fold).not.toBeNull();
    expect(fold?.querySelector("summary")).toHaveTextContent("Adjust view");
  });

  it("ends the page with the method disclosure, the error report after it", async () => {
    const { container } = render(await OwnershipPage());

    const details = Array.from(container.querySelectorAll("details"));
    const method = container.querySelector("details#method") as HTMLElement;
    expect(details.at(-1)).toBe(method);
    expect(method).not.toHaveAttribute("open");
    expect(container.querySelector("#method")).toHaveClass("scroll-mt-20");
    expect(screen.getByRole("link", { name: "Report an error" })).toHaveAttribute(
      "href",
      "mailto:support@shorted.com.au?subject=Ownership%20data%3A%20hub",
    );
  });

  // The dated source list folds into the method, and the error report sits under the disclosure.
  it("folds the source lines into the closed method, with the error report after it", async () => {
    getOwnershipOverview.mockResolvedValue(
      overview({
        noticesParsed: 7118,
        superFunds: 72,
        asOf: "2026-10-16",
        sources: [
          source({
            source: "etf",
            description: "Index fund files from the ASX",
            records: 412,
            funds: 11,
            asAt: "2026-10-19",
            asAtFrom: "2026-09-30",
          }),
        ],
      }),
    );
    const { container } = render(await OwnershipPage());

    const method = container.querySelector("details#method") as HTMLElement;
    expect(method).not.toHaveAttribute("open");
    expect(method.textContent).toContain("Index fund files from the ASX: 412 records");
    expect(method.nextElementSibling).toContainElement(screen.getByRole("link", { name: "Report an error" }));
  });
});

// The first phone screen (backlog D2): the plate folds with the toolbar, and the band, the records and the
// method follow the panes below lg. jsdom has no layout, so the order is pinned by its classes; the 390
// screenshot is the measure of the first instrument's position.
describe("OwnershipPage first phone screen (backlog D2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 7118, superFunds: 72, asOf: "2026-10-16" }));
    listInstitutions.mockResolvedValue({ institutions: [], total: 0 });
    deskDefaults();
  });

  const plates = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("p")).filter((p) => p.textContent?.includes("Notices read to"));

  it("draws the plate once, inside the toolbar's fold, above the row", async () => {
    const { container } = render(await OwnershipPage());

    const found = plates(container);
    expect(found).toHaveLength(1);
    const row = container.querySelector("[data-toolbar]") as HTMLElement;
    const fold = row.closest("details") as HTMLElement;
    expect(fold).not.toBeNull();
    expect(fold.querySelector("summary")).toHaveTextContent("Adjust view");
    expect(fold).toContainElement(found[0]);
    expect(found[0].compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The plate is not a child of the page's column: it is inside the toolbar's block.
    expect(found[0].parentElement).not.toBe(band(container).parentElement);
  });

  it("makes the page's column a flex column, so the order classes apply, with no space-y", async () => {
    const { container } = render(await OwnershipPage());

    const column = band(container).parentElement as HTMLElement;
    expect(column).toHaveClass("flex", "flex-col", "gap-8");
    expect(column).not.toHaveClass("space-y-8");
  });

  it("moves the band, the records and the method after the panes below lg, and restores the desk order from lg", async () => {
    const { container } = render(await OwnershipPage());

    expect(band(container)).toHaveClass("order-[10]", "lg:order-none");
    expect(container.querySelector("nav[aria-label='Records']")).toHaveClass("order-[11]", "lg:order-none");
    const methodWrapper = container.querySelector("details#method")?.parentElement as HTMLElement;
    expect(methodWrapper).toHaveClass("order-[12]", "lg:order-none");
    // The panes take no order class of their own, so they keep the column's order and sit first on a phone.
    const mapTokens = (container.querySelector("#desk-map")?.closest("section") as HTMLElement).className.split(/\s+/);
    expect(mapTokens.some((token) => /(^|:)order-/.test(token))).toBe(false);
  });

  it("keeps the DOM order unchanged, the band still ahead of the panes for the focus order", async () => {
    const { container } = render(await OwnershipPage());

    const coverage = band(container);
    const map = container.querySelector("#desk-map") as HTMLElement;
    expect(coverage.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the pane titles, and no pane has a phone height of its own", async () => {
    const { container } = render(await OwnershipPage());

    for (const title of ["Market map", "Disclosed exposure", "Notice activity"]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeInTheDocument();
    }
    const mapSection = container.querySelector("#desk-map")?.closest("section") as HTMLElement;
    const tokens = mapSection.className.split(/\s+/);
    expect(tokens.some((token) => /^h-\[/.test(token))).toBe(false);
    expect(mapSection).toHaveClass("lg:h-[420px]");
  });
});
