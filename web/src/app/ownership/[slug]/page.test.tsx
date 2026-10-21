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
  // 946 KB. The top of each table stays in the HTML, crawlable; the rest is
  // the island's data until a reader asks for it.
  it("draws the largest 25 stakes and holdings and the newest 25 notices, and holds the rest", async () => {
    getInstitution.mockResolvedValue(response({ positions: 88, fundHoldings: 100, notices: 100 }));
    render(await InstitutionPage(params("vanguard")));

    const stakes = screen.getByRole("table", { name: "Vanguard's current substantial holdings" });
    const files = screen.getByRole("table", { name: "Vanguard's largest disclosed ASX holdings" });
    const notices = screen.getByRole("table", { name: "Vanguard's substantial holding notices" });
    expect(bodyRows(stakes)).toHaveLength(25);
    expect(bodyRows(files)).toHaveLength(25);
    expect(bodyRows(notices)).toHaveLength(25);
    // The top holdings' stock links are in the page, largest first.
    expect(within(stakes).getAllByRole("link", { name: /^P\d\d$/ }).map((a) => a.getAttribute("href"))).toEqual(
      Array.from({ length: 25 }, (_, i) => `/shorts/P${String(i).padStart(2, "0")}/company`),
    );

    fireEvent.click(screen.getByRole("button", { name: "Show all 88 substantial holdings" }));
    fireEvent.click(screen.getByRole("button", { name: "Show all 100 holdings" }));
    fireEvent.click(screen.getByRole("button", { name: "Show all 100 notices" }));
    expect(bodyRows(stakes)).toHaveLength(88);
    expect(bodyRows(files)).toHaveLength(100);
    expect(bodyRows(notices)).toHaveLength(100);
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

  it("noindexes an institution not on the map, and reads nothing for a malformed slug", async () => {
    getInstitution.mockResolvedValue(undefined);
    expect((await generateMetadata(params("nobody"))).robots).toEqual(NOINDEX);

    getInstitution.mockClear();
    expect((await generateMetadata(params("Not_A_Slug"))).robots).toEqual(NOINDEX);
    expect(getInstitution).not.toHaveBeenCalled();
  });
});
