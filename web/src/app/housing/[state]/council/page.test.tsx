import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";

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
const indexMapProps = jest.fn();
jest.mock("~/@/components/housing/council/council-client", () => ({
  CouncilIndexMap: (props: unknown) => {
    indexMapProps(props);
    return <div data-testid="council-index-map" />;
  },
}));

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
    expect(within(unincorporated).getAllByText("–")).toHaveLength(2); // flood, bushfire: no source
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("embeds the council choropleth, fed the same rows as plain JSON", async () => {
    render(await StateCouncilsPage(params("nsw")));
    expect(screen.getByTestId("council-index-map")).toBeInTheDocument();
    const props = indexMapProps.mock.calls[0]![0] as { stateCode: string; councils: Array<Record<string, unknown>> };
    expect(props.stateCode).toBe("NSW");
    expect(props.councils.map((c) => c.lgaCode)).toEqual(["11570", "19399"]);
    // Serializable across the RSC boundary: no protobuf $typeName, no functions.
    expect(JSON.parse(JSON.stringify(props.councils))).toEqual(props.councils.map((c) =>
      Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined))));
    expect(props.councils[0]).not.toHaveProperty("$typeName");
  });

  it("sorts by any column, with missing facts last in both directions", async () => {
    render(await StateCouncilsPage(params("nsw")));
    const names = () => screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0]!.textContent);
    expect(names()[0]).toMatch(/Canterbury-Bankstown/); // population desc by default
    const growth = screen.getByRole("button", { name: "Growth" });
    fireEvent.click(growth); // desc
    expect(names()[0]).toMatch(/Canterbury-Bankstown/);
    fireEvent.click(growth); // asc: the council with no growth figure still sorts last
    expect(names()[0]).toMatch(/Canterbury-Bankstown/);
    expect(screen.getByRole("columnheader", { name: "Growth" })).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(screen.getByRole("button", { name: "Council" })); // name asc
    expect(names()[0]).toMatch(/Canterbury-Bankstown/);
    fireEvent.click(screen.getByRole("button", { name: "Council" })); // name desc
    expect(names()[0]).toMatch(/Unincorporated NSW/);
  });

  it("bails out of ISR when the list comes back empty, and 404s an unknown state", async () => {
    listCouncils.mockResolvedValueOnce(undefined);
    render(await StateCouncilsPage(params("vic")));
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    await expect(StateCouncilsPage(params("atlantis"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("explains the ACT, with no council map to point at, and keeps a canonical URL", async () => {
    render(await StateCouncilsPage(params("act")));
    expect(screen.getByText(/ACT has no local councils/)).toBeInTheDocument();
    expect(screen.queryByTestId("council-index-map")).toBeNull();
    for (const link of screen.getAllByRole("link")) expect(link.getAttribute("href")).not.toContain("level=council");
    const meta = await generateMetadata(params("act"));
    expect(meta.alternates?.canonical).toBe("https://shorted.com.au/housing/act/council");
  });

  it("prebuilds all eight states", () => {
    expect(generateStaticParams()).toHaveLength(8);
  });
});
