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

import { BLOG_MDX_FIGURES, BLOG_MDX_ITEM_MARKERS, blogMdxComponents } from "../mdx-components";
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

  it("keeps the child-item markers on mdxcn's naming contract", () => {
    // Parents match children by `graphItem` / `displayName`, not identity
    // (graph-frame `typeName`). A renamed marker would silently drop rows.
    for (const name of BLOG_MDX_ITEM_MARKERS) {
      const marker = blogMdxComponents[name] as { graphItem?: string; displayName?: string };
      expect(marker.graphItem).toBe(name);
      expect(marker.displayName).toBe(name);
    }
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

  it("lets a parent read the map's local markers as children", () => {
    // The whole point of the local markers: the lazily loaded parent must
    // still find <Stat> rows written in a post.
    const { Stat } = blogMdxComponents;
    render(
      <GraphStat title="Australia, March quarter 2026">
        <Stat value="$1.11M" label="mean dwelling price" hint="+10.3% over the year" accent />
        <Stat value="177.7%" label="household debt to income" />
      </GraphStat>,
    );
    expect(screen.getByText("$1.11M")).toBeInTheDocument();
    expect(screen.getByText("mean dwelling price")).toBeInTheDocument();
    expect(screen.getByText("+10.3% over the year")).toBeInTheDocument();
    expect(screen.getByText("177.7%")).toBeInTheDocument();
  });
});
