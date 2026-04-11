import { render, screen } from "@testing-library/react";
import { CommunityOverviewTeaser } from "../community-overview-teaser";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("CommunityOverviewTeaser", () => {
  it("renders a populated teaser with an open community CTA", () => {
    render(
      <CommunityOverviewTeaser
        stockCode="BHP"
        summary={{
          headline: "The capex debate is tightening",
          subheadline: "6 threads and 14 pulse updates live now",
          ctaLabel: "Open community",
          threadCount: 6,
          pulseCount: 14,
          latestActivityAt: new Date("2026-04-11T08:00:00Z"),
        }}
      />,
    );

    expect(screen.getByText("Live on BHP")).toBeInTheDocument();
    expect(
      screen.getByText("The capex debate is tightening"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /open community/i }),
    ).toBeInTheDocument();
  });

  it("renders the compact empty teaser state", () => {
    render(
      <CommunityOverviewTeaser
        stockCode="BHP"
        summary={{
          headline: "Be the first to discuss BHP",
          subheadline:
            "Start the research thread, post a catalyst, or add the first pulse update.",
          ctaLabel: "Open community",
          threadCount: 0,
          pulseCount: 0,
        }}
      />,
    );

    expect(
      screen.getByText(/be the first to discuss bhp/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/start the research thread/i)).toBeInTheDocument();
  });
});
