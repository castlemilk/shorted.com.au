import { render, screen, within } from "@testing-library/react";
import { getStockOwnership } from "~/app/actions/getOwnership";
import type {
  GetOwnershipOverviewResponse,
  OwnershipSource,
  OwnershipStock,
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
  MovementHeatmap: (props: unknown) => {
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
// The combobox reads the popover API on mount, which jsdom does not have: the toolbar is drawn as a stub here.
jest.mock("~/@/components/gamma/SearchCombobox", () => ({
  SearchCombobox: () => null,
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

describe("OwnershipPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listInstitutions.mockResolvedValue({ institutions: [] });
    loadOwnershipMap.mockResolvedValue({ ok: true, error: "", from: "", to: "", asOf: "", stocks: [] });
    loadOwnershipFlows.mockResolvedValue({ ok: true, error: "", from: "", to: "", asOf: "", positions: [], changes: [] });
    loadOwnershipActivity.mockResolvedValue({ ok: true, error: "", fromWeek: "", toWeek: "", asOf: "", rows: [] });
    loadFundPositionChanges.mockResolvedValue({ ok: true, error: "", snapshotDates: [], from: "", to: "", rows: [] });
  });

  it.each([
    ["the read failed", undefined],
    ["the first collection has not run", overview()],
  ])("says the data is not available yet when %s, and draws no empty tables", async (_, data) => {
    getOwnershipOverview.mockResolvedValue(data);
    render(await OwnershipPage());

    expect(screen.getByRole("heading", { level: 1, name: "The ownership landscape" })).toBeInTheDocument();
    expect(screen.getByText(/Ownership data is not available yet/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "The map" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });

  it("draws the views once notices have been read", async () => {
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 7118, superFunds: 72, asOf: "2026-10-16" }));
    render(await OwnershipPage());

    expect(screen.getByRole("heading", { name: "The map" })).toBeInTheDocument();
    expect(screen.getByText("7,118")).toBeInTheDocument();
    // The plate and the flows both print the date; the plate comes first.
    expect(screen.getAllByText(/Notices read to/)[0]).toHaveTextContent("Notices read to 2026-10-16");
    expect(screen.queryByText(/Ownership data is not available yet/)).toBeNull();
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });
});

// The hub had no og:image (SEO review F09): its own openGraph replaced the
// root layout's, and the segment had no card. The card is now the segment's
// opengraph-image.tsx (its own test), which an explicit `images` would shadow.
// Its own `twitter` replaces the root's wholesale, and it carried no `site`.
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

describe("OwnershipPage desk", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listInstitutions.mockResolvedValue({ institutions: [] });
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 7118, superFunds: 72, asOf: "2026-10-16" }));
    loadOwnershipMap.mockResolvedValue({
      ok: true,
      error: "",
      from: "",
      to: "",
      asOf: "2026-10-16",
      stocks: [mapStock("BHP", 200e9, 12.5), mapStock("CBA", 150e9, 8)],
    });
    loadOwnershipFlows.mockResolvedValue({ ok: true, error: "", from: "", to: "", asOf: "2026-10-16", positions: [], changes: [] });
    loadOwnershipActivity.mockResolvedValue({ ok: true, error: "", fromWeek: "", toWeek: "", asOf: "2026-10-16", rows: [] });
    loadFundPositionChanges.mockResolvedValue({ ok: true, error: "", snapshotDates: [], from: "", to: "", rows: [] });
  });

  it("draws the instruments first, in the desk's order, with the record beneath them", async () => {
    render(await OwnershipPage());

    // Each pane's heading carries its open-in-page link, so the names are matched by their start.
    const order = ["Market map", "Disclosed exposure", "Notice activity", "Index fund positions", "The map", "Latest notices"];
    const headings = order.map((name) => screen.getByRole("heading", { name: new RegExp(`^${name}`) }));
    for (let i = 1; i < headings.length; i++) {
      expect(headings[i - 1].compareDocumentPosition(headings[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    render(await OwnershipPage());

    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: /^Market map/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The map" })).toBeInTheDocument();
  });
});

describe("OwnershipPage metadata", () => {
  it("is indexable, self-canonical, and leaves the social card to the segment's opengraph-image", () => {
    expect(Object.keys(metadata)).not.toContain("robots");
    expect(metadata.alternates?.canonical).toBe("https://shorted.com.au/ownership");
    expect(Object.keys(metadata.openGraph ?? {})).not.toContain("images");
    expect(Object.keys(metadata.twitter ?? {})).not.toContain("images");
    expect(metadata.twitter).toMatchObject({ site: "@shorted___", creator: "@shorted___" });
  });
});

const outcome = (name: string, count: number) => ({ outcome: name, count }) as unknown as WithheldOutcome;
const source = (over: Partial<OwnershipSource>) =>
  ({ source: "", description: "", asAt: "", asAtFrom: "", records: 0, funds: 0, ...over }) as unknown as OwnershipSource;
const stock = (code: string) =>
  ({
    stockCode: code,
    companyName: `${code} Group`,
    industry: "Materials",
    holders: 3,
    disclosedPct: 23.6,
    byKind: [],
    shortPct: 0,
    hasShortPct: false,
    indexPct: 0,
    hasIndexPct: false,
    superOptions: 0,
    superValueAud: 0,
    hasSuperValue: false,
    marketCap: 0,
    hasMarketCap: false,
  }) as unknown as OwnershipStock;

describe("OwnershipPage coverage and sources", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listInstitutions.mockResolvedValue({ institutions: [] });
  });

  it("counts the six withholding outcomes in the withheld tile, and names the two that are not withheld apart", async () => {
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
    render(await OwnershipPage());

    expect(screen.getByText("Notices withheld").previousElementSibling).toHaveTextContent(/^5$/);
    expect(screen.getByText("of 7,132 documents attempted")).toBeInTheDocument();
    expect(screen.getByText("Withheld, by outcome")).toBeInTheDocument();
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

    expect(screen.getByText(/index fund files as at/)).toHaveTextContent(
      "Notices read to 2026-10-16 · index fund files as at 2026-09-30 to 2026-10-19 · super option files as at 2026-06-30 · ASIC shorts T+4 · Not financial advice",
    );
  });

  it("links every stock on the hub to its register page", async () => {
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 7118, superFunds: 72, crowded: [stock("PLS")] }));
    render(await OwnershipPage());

    expect(screen.getByRole("link", { name: "PLS" })).toHaveAttribute("href", "/ownership/stocks/PLS");
  });

  it("gives each kind's group in the directory its own id, so a desk link can land on that kind", async () => {
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 7118, superFunds: 72 }));
    listInstitutions.mockResolvedValue({
      total: 1,
      institutions: [
        { slug: "aware-super", name: "Aware Super", kind: "super_fund", substantialPositions: 0, notices: 0, hasAum: false, hasFundsSize: false },
      ],
    });
    const { container } = render(await OwnershipPage());

    expect(container.querySelector("#directory-super_fund")).toHaveTextContent("Aware Super");
    expect(container.querySelector("#directory-index_manager")).toHaveTextContent("None listed.");
  });

  // listInstitutions answers undefined on any failure. That is an outage: the page bails the cache,
  // says so once, and does not print an empty registry. The kind anchors still resolve.
  it("says the directory could not be read, bails the cache, and prints no empty kind", async () => {
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 7118, superFunds: 72 }));
    listInstitutions.mockResolvedValue(undefined);
    const { container } = render(await OwnershipPage());

    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/The institution list could not be read just now/)).toBeInTheDocument();
    expect(screen.queryByText(/None listed/)).toBeNull();
    expect(container.querySelector("#directory-super_fund")).not.toBeNull();
    expect(container.querySelector("#directory-index_manager")).not.toBeNull();
  });

  it("hands the map the action's stock-panel loader, not a loader of its own", async () => {
    render(await OwnershipPage());

    const props = mockOwnershipMap.mock.calls.at(-1)?.[0] as { loadPanel: (code: unknown) => Promise<{ ok: boolean }> };
    expect(typeof props.loadPanel).toBe("function");
    await props.loadPanel("BHP");
    expect(loadStockPanel).toHaveBeenCalledWith("BHP");
    expect(getStockOwnership).not.toHaveBeenCalled();
  });

  it("hands the movement island the activity loader, so its chips and brush can redraw", async () => {
    render(await OwnershipPage());

    const props = movementHeatmap.mock.calls[0][0] as { loadActivity?: (input: { weeks?: number }) => Promise<unknown> };
    expect(typeof props.loadActivity).toBe("function");
    await props.loadActivity?.({ weeks: 8 });
    expect(loadOwnershipActivity).toHaveBeenLastCalledWith({ weeks: 8 });
  });

  it("anchors the coverage and the method, and ends the page with the error report", async () => {
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 7118, superFunds: 72, asOf: "2026-10-16" }));
    const { container } = render(await OwnershipPage());

    expect(container.querySelector("section#coverage")).not.toBeNull();
    expect(container.querySelector("#method")).toHaveClass("scroll-mt-20");
    expect(screen.getByRole("link", { name: "Report an error" })).toHaveAttribute(
      "href",
      "mailto:support@shorted.com.au?subject=Ownership%20data%3A%20hub",
    );
  });

  it("links the latest notices to the feed", async () => {
    getOwnershipOverview.mockResolvedValue(overview({ noticesParsed: 7118, superFunds: 72, asOf: "2026-10-16" }));
    const { container } = render(await OwnershipPage());

    const notices = container.querySelector("details:has(#notices)") as HTMLElement;
    expect(within(notices).getByRole("link", { name: "All notices →" })).toHaveAttribute(
      "href",
      "/ownership/notices",
    );
  });
});
