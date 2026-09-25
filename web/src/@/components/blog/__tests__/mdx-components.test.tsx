import { render, screen } from "@testing-library/react";

// motion's useReducedMotion reads matchMedia, which jsdom does not implement.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: jest.fn(), removeListener: jest.fn(),
      addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn(),
    }),
  });
});

jest.mock("~/@/components/housing/housing-charts", () => ({ HousingSeriesChart: () => null }));
jest.mock("~/@/components/ui/register-email-client", () => () => null);

import { BLOG_MDX_FIGURES, blogMdxComponents } from "../mdx-components";
import { GraphRank } from "@/registry/default/graph-rank/graph-rank";
import { GraphStat } from "@/registry/default/graph-stat/graph-stat";

describe("blog MDX component map", () => {
  it("exposes every figure name a post may use", () => {
    for (const name of BLOG_MDX_FIGURES) {
      expect(blogMdxComponents).toHaveProperty(name);
    }
    // The page's own <h1> lives in the route; a post's h1 demotes to h2.
    const { container } = render(blogMdxComponents.h1({ children: "Title" }));
    expect(container.querySelector("h2")).toHaveTextContent("Title");
    expect(container.querySelector("h1")).toBeNull();
  });

  it("renders a vendored figure from data-form items", () => {
    render(
      <GraphRank
        title="Median house price, year to March 2026"
        max={30}
        items={[
          { label: "Darwin", value: 25, display: "+25.0%" },
          { label: "Melbourne", value: 1.8, display: "+1.8%" },
        ]}
      />,
    );
    expect(screen.getByText(/Median house price, year to March 2026/)).toBeInTheDocument();
    expect(screen.getByText("Darwin")).toBeInTheDocument();
    expect(screen.getByText("+25.0%")).toBeInTheDocument();
    expect(screen.getByText("Melbourne")).toBeInTheDocument();
  });

  it("reads the markdown-list form a post writes inside a figure", () => {
    // What MDX hands the parent after the server pass: plain host <ul>/<li>
    // (the map's ul/li overrides render to hosts). First token is the value,
    // bold marks the accent row, " — " separates a hint. This is the only
    // authoring form that survives the server/client boundary — see
    // mdxcn-figures.tsx.
    render(
      <GraphStat title="30 days to 24 September 2026, 500-suburb panel">
        <ul>
          <li><strong>10.5%</strong> of listings cut their price</li>
          <li>4.3% median cut — average 5.3%</li>
          <li>$110M asking price removed</li>
        </ul>
      </GraphStat>,
    );
    expect(screen.getByText("10.5%")).toBeInTheDocument();
    expect(screen.getByText("of listings cut their price")).toBeInTheDocument();
    expect(screen.getByText("4.3%")).toBeInTheDocument();
    expect(screen.getByText("average 5.3%")).toBeInTheDocument();
    expect(screen.getByText("$110M")).toBeInTheDocument();

    render(
      <GraphRank title="Share of listings discounted, past 30 days">
        <ul>
          <li>29.7% Fawkner</li>
          <li>20.5% Altona Meadows</li>
        </ul>
      </GraphRank>,
    );
    expect(screen.getByText("Fawkner")).toBeInTheDocument();
    expect(screen.getByText("29.7%")).toBeInTheDocument();
    expect(screen.getByText("Altona Meadows")).toBeInTheDocument();
  });
});
