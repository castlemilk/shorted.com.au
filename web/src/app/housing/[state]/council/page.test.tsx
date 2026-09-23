import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";

import StateCouncilsPage, { generateMetadata, generateStaticParams } from "./page";

const listCouncils = jest.fn();
const bailOnEmptyRender = jest.fn();
const notFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

jest.mock("next/navigation", () => ({ notFound: () => notFound() }));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({ Breadcrumbs: () => null }));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({ BreadcrumbListSchema: () => null }));
jest.mock("~/app/actions/config", () => ({ bailOnEmptyRender: () => bailOnEmptyRender() }));
jest.mock("~/app/actions/getHousing", () => ({ listCouncils: (...args: unknown[]) => listCouncils(...args) }));

const params = (state: string) => ({ params: Promise.resolve({ state }) });

beforeEach(() => {
  jest.clearAllMocks();
  listCouncils.mockResolvedValue({
    councils: [
      {
        lgaCode: "11570", slug: "canterbury-bankstown", displayName: "Canterbury-Bankstown", kind: "council",
        population: 389_687, erpYear: 2025, popGrowthPct: 1.05, densityPerSqkm: 3536, councilHouseMedian: 1_400_000,
        councilHouseMedianPeriod: "2023-24", fagPerResident: 35.3, fagYear: "2025-26", approvalsPer1000: 4.3,
        approvalsThrough: "2026-07", seifaIrsadDecile: 3, bushfireSharePct: 5.2,
      },
      { lgaCode: "19399", slug: "unincorporated-nsw", displayName: "Unincorporated NSW", kind: "unincorporated", population: 975, erpYear: 2025, councilHouseMedianPeriod: "", fagYear: "", approvalsThrough: "" },
    ],
  });
});

describe("state council index", () => {
  it("does not read search params in the ISR server page", () => {
    expect(readFileSync(resolve(__dirname, "page.tsx"), "utf8")).not.toContain("searchParams");
  });

  it("lists every council, linked, with dated headers and blanks for missing facts", async () => {
    render(await StateCouncilsPage(params("nsw")));
    expect(listCouncils).toHaveBeenCalledWith("NSW");
    expect(screen.getByRole("columnheader", { name: "Population (2025)" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "House median (2023-24)" })).toBeInTheDocument();
    const cb = screen.getByRole("link", { name: "Canterbury-Bankstown" });
    expect(cb).toHaveAttribute("href", "/housing/nsw/council/canterbury-bankstown");
    const unincorporated = screen.getByRole("link", { name: "Unincorporated NSW" }).closest("tr")!;
    expect(within(unincorporated).getByText("unincorporated")).toBeInTheDocument();
    expect(unincorporated).not.toHaveTextContent("$");
    expect(unincorporated).toHaveTextContent("– / –");
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("bails out of ISR when the list comes back empty, and 404s an unknown state", async () => {
    listCouncils.mockResolvedValueOnce(undefined);
    render(await StateCouncilsPage(params("vic")));
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    await expect(StateCouncilsPage(params("atlantis"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("explains the ACT and keeps a canonical URL", async () => {
    render(await StateCouncilsPage(params("act")));
    expect(screen.getByText(/ACT has no local councils/)).toBeInTheDocument();
    const meta = await generateMetadata(params("act"));
    expect(meta.alternates?.canonical).toBe("https://shorted.com.au/housing/act/council");
  });

  it("prebuilds all eight states", () => {
    expect(generateStaticParams()).toHaveLength(8);
  });
});
