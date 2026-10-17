import { render, screen } from "@testing-library/react";

jest.mock("~/@/components/housing/housing-charts", () => ({ HousingSeriesChart: () => null }));
jest.mock("~/@/components/ui/register-email-client", () => () => null);

import { BLOG_MDX_FIGURES, blogMdxComponents } from "../mdx-components";
import { articleFigureComponents } from "~/@/components/mdx/article-figures";

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

  it("uses the site's shared server figures", () => {
    for (const [name, component] of Object.entries(articleFigureComponents)) {
      expect(blogMdxComponents[name as keyof typeof articleFigureComponents]).toBe(component);
    }
  });

  it("keeps Markdown tables semantic inside a focusable scroll region", () => {
    const Table = blogMdxComponents.table;
    render(
      <Table className="comparison" aria-label="Comparison data" data-source="article">
        <caption>Market comparison</caption>
        <thead><tr><th scope="col">Market</th></tr></thead>
        <tbody><tr><td>ASX</td></tr></tbody>
      </Table>,
    );
    const region = screen.getByRole("region", { name: "Article table" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveClass("overflow-x-auto", "max-w-full", "min-w-0");
    const table = screen.getByRole("table", { name: "Comparison data" });
    expect(region).toContainElement(table);
    expect(table).toHaveClass("w-full", "comparison");
    expect(table).toHaveAttribute("data-source", "article");
    expect(screen.getByRole("columnheader", { name: "Market" })).toHaveAttribute("scope", "col");
    expect(screen.getByRole("cell", { name: "ASX" })).toBeInTheDocument();
  });

  it("renders literal JSON data through the blog map", () => {
    const { GraphRank } = blogMdxComponents;
    render(
      <GraphRank
        title="Median house price, year to March 2026"
        max="30"
        items={JSON.stringify([
          { label: "Darwin", value: 25, display: "+25.0%" },
          { label: "Melbourne", value: 1.8, display: "+1.8%" },
        ])}
      />,
    );
    expect(screen.getByText(/Median house price, year to March 2026/)).toBeInTheDocument();
    expect(screen.getByText("Darwin")).toBeInTheDocument();
    expect(screen.getByText("+25.0%")).toBeInTheDocument();
    expect(screen.getByText("Melbourne")).toBeInTheDocument();
  });

  it("reads the markdown-list form a post writes inside a figure", () => {
    const { GraphStat, GraphRank } = blogMdxComponents;
    // Legacy Markdown stays readable without relying on child-name parsing.
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
    expect(screen.getByText(/4.3% median cut/)).toBeInTheDocument();
    expect(screen.getByText(/average 5.3%/)).toBeInTheDocument();
    expect(screen.getByText(/\$110M asking price removed/)).toBeInTheDocument();

    render(
      <GraphRank title="Share of listings discounted, past 30 days">
        <ul>
          <li>29.7% Fawkner</li>
          <li>20.5% Altona Meadows</li>
        </ul>
      </GraphRank>,
    );
    expect(screen.getByText("29.7% Fawkner")).toBeInTheDocument();
    expect(screen.getByText("20.5% Altona Meadows")).toBeInTheDocument();
  });
});
