import { render, screen, within } from "@testing-library/react";

import HousingRankingsIndexPage from "./page";
import { ALL_STATES, STATE_NAMES } from "~/@/lib/housing/states";
import { HOUSING_RANKINGS } from "~/@/lib/housing-rankings/registry";

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
}));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
  ItemListStructuredData: () => null,
}));

describe("HousingRankingsIndexPage", () => {
  it("groups all five rankings under each published state, and omits unpriced states", () => {
    render(<HousingRankingsIndexPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Australian Suburb House Price Rankings",
      }),
    ).toBeInTheDocument();

    const published = ALL_STATES.filter((code) =>
      Object.values(HOUSING_RANKINGS).some((r) => r.stateCode === code),
    );
    expect(published).toEqual(["NSW", "VIC", "SA"]);

    for (const stateCode of ALL_STATES.filter((c) => !published.includes(c))) {
      expect(
        screen.queryByRole("region", { name: `${STATE_NAMES[stateCode]!} rankings` }),
      ).toBeNull();
    }

    for (const stateCode of published) {
      const stateName = STATE_NAMES[stateCode]!;
      const section = within(
        screen.getByRole("region", { name: `${stateName} rankings` }),
      );
      expect(
        section.getByRole("heading", { name: stateName }),
      ).toBeInTheDocument();
      const expected = Object.values(HOUSING_RANKINGS).filter(
        (ranking) => ranking.stateCode === stateCode,
      );
      expect(section.getAllByRole("link")).toHaveLength(6);
      for (const ranking of expected) {
        expect(section.getByRole("link", { name: ranking.h1 })).toHaveAttribute(
          "href",
          `/housing/rankings/${ranking.slug}`,
        );
      }
    }
  });
});
