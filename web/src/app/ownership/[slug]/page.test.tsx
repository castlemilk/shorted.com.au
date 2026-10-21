import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  FundHolding,
  GetInstitutionResponse,
  OwnershipInstitution,
  SubstantialHolding,
  SubstantialNotice,
} from "~/gen/shorts/v1alpha1/ownership_pb";

import InstitutionPage, { generateMetadata } from "./page";

const getInstitution = jest.fn();

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("~/app/actions/getOwnership", () => ({
  getInstitution: (slug: string) => getInstitution(slug),
}));

const position = (i: number): SubstantialHolding =>
  ({
    stockCode: `P${String(i).padStart(2, "0")}`,
    companyName: `Company ${i}`,
    holderKey: "vanguard",
    holderName: "Vanguard Group",
    institutionSlug: "vanguard",
    kind: "index_manager",
    form: "604",
    // Largest first, as GetInstitution orders them.
    votingPowerPct: 15 - i / 10,
    previousPct: 0,
    hasPrevious: false,
    votes: BigInt(0),
    hasVotes: false,
    eventDate: "2026-10-14",
    announcedOn: "2026-10-16",
    announcementUrl: `https://www.asx.com.au/p${i}.pdf`,
  }) as unknown as SubstantialHolding;

const fileHolding = (i: number): FundHolding =>
  ({
    institutionSlug: "vanguard",
    institutionName: "Vanguard",
    kind: "index_manager",
    fundName: "Vanguard Australian Shares Index ETF",
    fundCode: "VAS",
    sourceKind: "etf",
    asAt: "2026-10-19",
    stockCode: `F${String(i).padStart(2, "0")}`,
    companyName: "",
    units: 1e6,
    hasUnits: true,
    valueAud: 1e9 - i * 1e6,
    hasValue: true,
    weightPct: 1,
    hasWeight: true,
    pctOfIssued: 0.5,
    hasPctOfIssued: true,
  }) as unknown as FundHolding;

const notice = (i: number): SubstantialNotice =>
  ({
    stockCode: `N${String(i).padStart(2, "0")}`,
    companyName: "",
    holderKey: "vanguard",
    holderName: "Vanguard Group",
    institutionSlug: "vanguard",
    kind: "index_manager",
    form: "604",
    presentPct: 6,
    hasPresent: true,
    previousPct: 5,
    hasPrevious: true,
    ceased: false,
    eventDate: "",
    announcedOn: `2026-10-${String(20 - (i % 20)).padStart(2, "0")}`,
    announcementUrl: `https://www.asx.com.au/n${i}.pdf`,
  }) as unknown as SubstantialNotice;

const institution = (over: Partial<OwnershipInstitution> = {}): OwnershipInstitution =>
  ({
    slug: "vanguard",
    name: "Vanguard",
    kind: "index_manager",
    country: "US",
    website: "https://www.vanguard.com.au",
    description: "",
    aumAud: 0,
    hasAum: false,
    aumAsAt: "",
    substantialPositions: 0,
    notices: 0,
    latestNoticeDate: "",
    funds: 0,
    fundsSizeAud: 0,
    hasFundsSize: false,
    ...over,
  }) as unknown as OwnershipInstitution;

const response = ({
  positions = 0,
  fundHoldings = 0,
  notices = 0,
  ...over
}: Partial<OwnershipInstitution> & { positions?: number; fundHoldings?: number; notices?: number } = {}) =>
  ({
    institution: institution({ substantialPositions: positions, notices, ...over }),
    positions: Array.from({ length: positions }, (_, i) => position(i)),
    notices: Array.from({ length: notices }, (_, i) => notice(i)),
    fundHoldings: Array.from({ length: fundHoldings }, (_, i) => fileHolding(i)),
    funds: [],
  }) as unknown as GetInstitutionResponse;

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const bodyRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);

describe("InstitutionPage", () => {
  beforeEach(() => jest.clearAllMocks());

  // /ownership/vanguard drew all 88 stakes, 100 holdings-file rows and 100
  // notices as server tables, each row as HTML and again in the RSC payload:
  // 946 KB. The stakes and holdings files are the page's account of what an
  // institution holds, so every row and its stock link stays in the HTML (the
  // perf review's fix kept them whole; a first cut drew 25 of each). Only the
  // notices, a dated log of filings, wait behind "Show all" past the newest 25.
  it("draws every stake and holdings-file row and the newest 25 notices, and holds the other notices", async () => {
    getInstitution.mockResolvedValue(response({ positions: 88, fundHoldings: 100, notices: 100 }));
    render(await InstitutionPage(params("vanguard")));

    const stakes = screen.getByRole("table", { name: "Vanguard's current substantial holdings" });
    const files = screen.getByRole("table", { name: "Vanguard's largest disclosed ASX holdings" });
    const notices = screen.getByRole("table", { name: "Vanguard's substantial holding notices" });
    expect(bodyRows(stakes)).toHaveLength(88);
    expect(bodyRows(files)).toHaveLength(100);
    expect(bodyRows(notices)).toHaveLength(25);
    // Every holding's stock link is in the page, in the API's order.
    expect(within(stakes).getAllByRole("link", { name: /^P\d\d$/ }).map((a) => a.getAttribute("href"))).toEqual(
      Array.from({ length: 88 }, (_, i) => `/shorts/P${String(i).padStart(2, "0")}/company`),
    );
    expect(within(files).getAllByRole("link", { name: /^F\d\d$/ }).map((a) => a.getAttribute("href"))).toEqual(
      Array.from({ length: 100 }, (_, i) => `/shorts/F${String(i).padStart(2, "0")}/company`),
    );

    // One control, under the notices.
    const more = screen.getByRole("button", { name: /^Show all/ });
    expect(more).toHaveAttribute("aria-controls", notices.querySelector("tbody")!.id);
    fireEvent.click(more);
    expect(bodyRows(notices)).toHaveLength(100);
  });

  // GetInstitution serves a holder's newest 100 notices. State Street has
  // 1,117 on record, and its control said "Show all 100 notices" under a
  // "Notices read" tile of 1117.
  it("says how many of the notices on record it can show, and never calls a capped list all", async () => {
    const data = response({ slug: "state-street", name: "State Street", positions: 3, notices: 100 });
    data.institution!.notices = 1117;
    getInstitution.mockResolvedValue(data);
    render(await InstitutionPage(params("state-street")));

    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the latest 100 of 1,117 notices" }));
    expect(bodyRows(screen.getByRole("table", { name: "State Street's substantial holding notices" }))).toHaveLength(100);
  });

  it("draws the external-link glyph once and points every ASX link at it", async () => {
    getInstitution.mockResolvedValue(response({ positions: 3, notices: 2 }));
    const { container } = render(await InstitutionPage(params("vanguard")));

    expect(container.querySelectorAll("symbol#ownership-external-link")).toHaveLength(1);
    const asx = screen.getAllByRole("link", { name: /on ASX$/ });
    expect(asx).toHaveLength(5);
    for (const a of asx) {
      expect(a.querySelector("use")).toHaveAttribute("href", "#ownership-external-link");
    }
    expect(container.querySelector("svg.lucide-external-link")).toBeNull();
  });

  it("says so when there is no current stake, and still draws the holdings files", async () => {
    getInstitution.mockResolvedValue(response({ name: "HESTA", kind: "super_fund", fundHoldings: 10 }));
    render(await InstitutionPage(params("hesta")));

    expect(screen.getByText(/No current substantial holding on record/)).toBeInTheDocument();
    expect(bodyRows(screen.getByRole("table", { name: "HESTA's largest disclosed ASX holdings" }))).toHaveLength(10);
    expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
  });

  // The visible trail had no structured counterpart: the page's only JSON-LD
  // was the site-wide WebSite.
  it("describes its breadcrumb trail as a BreadcrumbList", async () => {
    getInstitution.mockResolvedValue(response({ positions: 1 }));
    const { container } = render(await InstitutionPage(params("vanguard")));

    const blocks = Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map((s) =>
      JSON.parse(s.textContent ?? "{}"),
    );
    const trail = blocks.find((b) => b["@type"] === "BreadcrumbList");
    expect(
      trail.itemListElement.map((i: { position: number; name: string; item: string }) => [i.position, i.name, i.item]),
    ).toEqual([
      [1, "Home", "https://shorted.com.au/"],
      [2, "Ownership", "https://shorted.com.au/ownership"],
      [3, "Vanguard", "https://shorted.com.au/ownership/vanguard"],
    ]);
  });
});

const NOINDEX = { index: false, follow: true, googleBot: { index: false, follow: true } };

// SEO review F09, measured 2026-10-21: every institution page was indexable,
// /ownership/ophir with "0 current substantial holdings" among them, and the
// titles ran 70-85 characters ("Magellan Financial Group ASX Holdings:
// Substantial Stakes and Fund Holdings | Shorted").
describe("institution metadata", () => {
  beforeEach(() => jest.clearAllMocks());

  it("noindexes, and follows, an institution with no current stake and no holdings files", async () => {
    getInstitution.mockResolvedValue(response({ slug: "ophir", name: "Ophir Asset Management", kind: "active_manager" }));
    const meta = await generateMetadata(params("ophir"));

    expect(meta.robots).toEqual(NOINDEX);
    expect(meta.alternates?.canonical).toBe("https://shorted.com.au/ownership/ophir");
    expect(meta.description).toBe(
      "Ophir Asset Management (active manager): no current substantial holding in an ASX company on record in its notices.",
    );
  });

  // Next merges metadata key by key: an own `robots: undefined` would replace
  // the root layout's googleBot directives with nothing, so indexable means
  // no key at all.
  it("sets no robots key on a holder, names its own canonical and keeps the title short", async () => {
    getInstitution.mockResolvedValue(
      response({ slug: "magellan", name: "Magellan Financial Group", kind: "active_manager", positions: 6 }),
    );
    const meta = await generateMetadata(params("magellan"));

    expect(Object.keys(meta)).not.toContain("robots");
    expect(meta.alternates?.canonical).toBe("https://shorted.com.au/ownership/magellan");
    expect(meta.title).toBe("Magellan Financial Group ASX holdings and substantial stakes");
    expect(String(meta.title).length).toBeLessThanOrEqual(60);
    expect(meta.description).toBe(
      "What Magellan Financial Group (active manager) holds on the ASX: 6 current substantial holdings from its notices.",
    );
  });

  it("indexes an institution on its holdings files alone, and counts one stake in the singular", async () => {
    getInstitution.mockResolvedValue(response({ slug: "hesta", name: "HESTA", kind: "super_fund", fundHoldings: 100 }));
    const files = await generateMetadata(params("hesta"));
    expect(Object.keys(files)).not.toContain("robots");
    expect(files.description).toBe("What HESTA (super fund) holds on the ASX: the largest holdings in its published holdings files.");

    getInstitution.mockResolvedValue(response({ slug: "argo", name: "Argo Investments", kind: "active_manager", positions: 1 }));
    expect((await generateMetadata(params("argo"))).description).toBe(
      "What Argo Investments (active manager) holds on the ASX: 1 current substantial holding from its notices.",
    );
  });

  it("keeps the head term alone for a name too long for the full title", async () => {
    // The longest name on the map, 40 characters.
    getInstitution.mockResolvedValue(
      response({ slug: "afic", name: "Australian Foundation Investment Company", kind: "active_manager", positions: 2 }),
    );
    const meta = await generateMetadata(params("afic"));
    expect(meta.title).toBe("Australian Foundation Investment Company ASX holdings");
    expect(String(meta.title).length).toBeLessThanOrEqual(60);
  });

  // An explicit `images` would shadow the segment's opengraph-image.tsx, and a
  // page without its own `twitter` keeps the root layout's image there.
  it("leaves the social card to the segment's opengraph-image", async () => {
    getInstitution.mockResolvedValue(response({ positions: 2 }));
    const meta = await generateMetadata(params("vanguard"));

    expect(meta.openGraph).toMatchObject({ url: "https://shorted.com.au/ownership/vanguard" });
    expect(Object.keys(meta.openGraph ?? {})).not.toContain("images");
    expect(meta.twitter).toEqual({ card: "summary_large_image", creator: "@shorted___" });
  });

  it("noindexes an institution not on the map, and reads nothing for a malformed slug", async () => {
    getInstitution.mockResolvedValue(undefined);
    expect((await generateMetadata(params("nobody"))).robots).toEqual(NOINDEX);

    getInstitution.mockClear();
    expect((await generateMetadata(params("Not_A_Slug"))).robots).toEqual(NOINDEX);
    expect(getInstitution).not.toHaveBeenCalled();
  });
});
