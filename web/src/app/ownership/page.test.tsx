import { render, screen, within } from "@testing-library/react";
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
  });

  it.each([
    ["the read failed", undefined],
    ["the first collection has not run", overview()],
  ])("says the data is not available yet when %s, and draws no empty tables", async (_, data) => {
    getOwnershipOverview.mockResolvedValue(data);
    render(await OwnershipPage());

    expect(screen.getByRole("heading", { level: 1, name: "Who owns the ASX" })).toBeInTheDocument();
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
    expect(screen.getByText(/Notices read to/)).toHaveTextContent("Notices read to 2026-10-16");
    expect(screen.queryByText(/Ownership data is not available yet/)).toBeNull();
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });
});

// The hub had no og:image (SEO review F09): its own openGraph replaced the
// root layout's, and the segment had no card. The card is now the segment's
// opengraph-image.tsx (its own test), which an explicit `images` would shadow.
// Its own `twitter` replaces the root's wholesale, and it carried no `site`.
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

    const notices = container.querySelector("section[aria-labelledby='notices']") as HTMLElement;
    expect(within(notices).getByRole("link", { name: "All notices →" })).toHaveAttribute(
      "href",
      "/ownership/notices",
    );
  });
});
