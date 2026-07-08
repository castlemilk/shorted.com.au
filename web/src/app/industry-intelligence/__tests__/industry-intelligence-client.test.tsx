import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { IndustryIntelligenceClient } from "../industry-intelligence-client";
import type { IndustryIntelligenceStory } from "~/@/lib/industry-intelligence";

function story(
  slug: string,
  name: string,
  code: string,
): IndustryIntelligenceStory {
  return {
    industry: {
      name,
      slug,
      stockCount: 1,
      avgShortPercent: 8.5,
      totalShortPercent: 8.5,
      topStock: { code, name: code, shortPercent: 8.5 },
    },
    topShortedStocks: [
      {
        rank: 1,
        code,
        name: `${code} Limited`,
        detail: `${name} company`,
        shortPercent: 8.5,
        change: 0.4,
        status: "elevated",
        href: `/shorts/${code}`,
      },
    ],
    shortSignals: {
      averageShortPercent: 8.5,
      highlyShortedCount: 0,
      risingCount: 1,
      source: { name: "ASIC", asAt: "2026-07-08", cadence: "Daily, T+4" },
    },
    alerts: {
      previewEnabled: true,
      cadences: ["Daily", "Weekly"],
    },
  };
}

describe("IndustryIntelligenceClient", () => {
  it("keeps users moving when industry data is unavailable", () => {
    render(<IndustryIntelligenceClient stories={[]} />);

    expect(
      screen.getByRole("heading", { name: "Industry Intelligence" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Industry data is syncing/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View top shorts" }),
    ).toHaveAttribute("href", "/top");
    expect(
      screen.getByRole("link", { name: "Browse industries" }),
    ).toHaveAttribute("href", "/industry");
    expect(screen.getByRole("link", { name: "Find a stock" })).toHaveAttribute(
      "href",
      "/stocks",
    );
  });

  it("updates the top-stocks panel when a different industry is selected", () => {
    render(
      <IndustryIntelligenceClient
        stories={[
          story("materials", "Materials", "MIN"),
          story("health-care", "Health Care", "CSL"),
        ]}
      />,
    );

    expect(
      within(screen.getByTestId("industry-top-stocks-panel")).getByRole(
        "link",
        {
          name: /MIN.*MIN Limited/,
        },
      ),
    ).toHaveAttribute("href", "/shorts/MIN");

    fireEvent.click(screen.getByRole("button", { name: /Health Care/ }));

    const panel = within(screen.getByTestId("industry-top-stocks-panel"));
    expect(
      panel.getByRole("link", { name: /CSL.*CSL Limited/ }),
    ).toHaveAttribute("href", "/shorts/CSL");
    expect(
      panel.queryByRole("link", { name: /MIN.*MIN Limited/ }),
    ).not.toBeInTheDocument();
  });
});
