import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "postcss";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import Info from "~/@/components/ui/info";
import { Timeline, TimelineEvent } from "~/@/components/news/mdx/timeline";
import { PullQuote } from "~/@/components/news/mdx/pull-quote";
import { Figure } from "~/@/components/news/mdx/figure";
import { GraphCompare, GraphSlope } from "../article-figures";

describe("article component boundaries", () => {
  it("keeps production prose spacing outside legacy callouts, timelines and quotes", () => {
    const { container } = render(
      <div className="article-prose">
        <h4>Native section</h4>
        <p>Native paragraph</p>
        <Info title="Refresh point"><p>Compact <strong>callout content</strong>.</p></Info>
        <Timeline><TimelineEvent date="2026-08-20" label="Results released" /></Timeline>
        <PullQuote><p>A carefully sourced quote.</p></PullQuote>
        <Figure src="https://shorted.com.au/editorial-example.webp" caption="An editorial illustration" />
      </div>,
    );
    // Use the actual production selectors, rather than reimplementing their
    // exclusions in the test. Root ol/blockquote elements must be excluded too.
    const spacingSelectors: string[] = [];
    parse(readFileSync(resolve(__dirname, "../../../../styles/globals.css"), "utf8"))
      .walkRules((rule) => {
        if (rule.selector.startsWith(".article-prose") && rule.nodes.some((node) =>
          node.type === "decl" && (node.prop === "margin-block" || node.prop === "padding-left"),
        )) spacingSelectors.push(rule.selector);
      });
    expect(spacingSelectors.length).toBeGreaterThan(0);
    const matchesProseSpacing = (element: Element) => spacingSelectors.some((selector) => element.matches(selector));
    expect(matchesProseSpacing(screen.getByRole("heading", { name: "Native section" }))).toBe(true);
    expect(matchesProseSpacing(screen.getByText("Native paragraph"))).toBe(true);
    const calloutTitle = screen.getByRole("heading", { name: "Refresh point" });
    const calloutParagraph = screen.getByText("callout content").closest("p")!;
    const timeline = screen.getByRole("list");
    const event = screen.getByRole("listitem");
    const quote = container.querySelector("blockquote")!;
    const quoteParagraph = screen.getByText("A carefully sourced quote.");
    for (const element of [calloutTitle, calloutParagraph, timeline, event, quote, quoteParagraph]) {
      expect(matchesProseSpacing(element)).toBe(false);
    }
    expect(screen.getByRole("img", { name: "An editorial illustration" }).closest("figure"))
      .toHaveAttribute("data-article-figure");
  });

  it.each<[string, ReactElement]>([
    ["Before and after table", <GraphSlope key="slope" fromLabel="Before" toLabel="After" items='[{"label":"ASX","from":100,"to":125}]' />],
    ["Comparison table", <GraphCompare key="compare" columns='["Growth","Value"]' rows='[{"label":"Momentum","values":[true,false]}]' />],
  ])("makes %s keyboard reachable without losing table semantics", (name, component) => {
    render(component);
    const region = screen.getByRole("region", { name });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveClass("overflow-x-auto", "focus-visible:outline");
    region.focus();
    expect(region).toHaveFocus();
    expect(region).toContainElement(screen.getByRole("table"));
    expect(screen.getAllByRole("columnheader").length).toBeGreaterThan(1);
    expect(screen.getByRole("rowheader")).toBeInTheDocument();
  });

  it("uses each figure title to label its scroll region", () => {
    render(<GraphCompare title="Strategy comparison" columns='["Growth"]' rows='[{"label":"Momentum","values":[true]}]' />);
    expect(screen.getByRole("region", { name: "Strategy comparison" })).toHaveAttribute("tabindex", "0");
  });
});
