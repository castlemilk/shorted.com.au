import { render, screen } from "@testing-library/react";
import type { GetOwnershipOverviewResponse } from "~/gen/shorts/v1alpha1/ownership_pb";

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
    expect(screen.getByText(/Notices to/)).toHaveTextContent("Notices to 2026-10-16.");
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
