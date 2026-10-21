/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import "@testing-library/jest-dom";
import { render } from "@testing-library/react";

jest.mock("next/dynamic", () => () => () => null);

import { RoadmapTree } from "../roadmap-tree";
import { entitlementMeta, roadmapFeatures } from "../roadmap-data";

describe("RoadmapTree", () => {
  // The wheel zooms over the canvas, which fills the screen, so the list
  // beneath it is reached by this link (its target is pinned in page.test).
  it("links to the feature list", () => {
    const { getByRole } = render(<RoadmapTree />);
    expect(getByRole("link", { name: "Read every feature as a list" })).toHaveAttribute(
      "href",
      "#roadmap-list",
    );
  });

  /**
   * Each node's native SVG tooltip. Its <title> had two children (the text and
   * the tier suffix), and the app router's React renders a <title> with more
   * than one child empty on the server: all 31 were `<title></title>` in the
   * /roadmap HTML of 2026-10-21. React DOM writes one text node per child, so
   * a title with more than one is the defect.
   */
  it("gives each node's <title> a single text child", () => {
    const { container } = render(<RoadmapTree />);
    const titles = Array.from(container.querySelectorAll("svg title"));
    const features = roadmapFeatures();
    expect(titles).toHaveLength(features.length);

    for (const feature of features) {
      const title = container.querySelector(`g[data-node-id="${feature.id}"] > title`);
      expect(title?.childNodes).toHaveLength(1);
      const tier =
        feature.entitlement && feature.entitlement !== "free"
          ? ` (${entitlementMeta[feature.entitlement].label})`
          : "";
      expect(title?.textContent).toBe(
        `${feature.description ? `${feature.name}: ${feature.description}` : feature.name}${tier}`,
      );
    }
  });
});
