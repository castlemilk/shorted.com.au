import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  FundHolding,
  GetInstitutionResponse,
  OwnershipInstitution,
  SubstantialHolding,
  SubstantialNotice,
} from "~/gen/shorts/v1alpha1/ownership_pb";

import InstitutionPage from "./page";

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
