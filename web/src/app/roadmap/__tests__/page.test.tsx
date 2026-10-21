/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * /roadmap served 100 visible words (2026-10-21): the page was "use client"
 * whole, and a feature's description appeared only in the tree's hover
 * tooltip, so no description was in the HTML or the RSC payload. The page now
 * server-renders every feature beneath the tree, from the tree's own data.
 *
 * The tree is stubbed out here, so everything asserted comes from the server
 * list alone.
 */

jest.mock("../roadmap-tree", () => ({ RoadmapTree: () => null }));

import RoadmapPage from "../page";
import {
  ROADMAP_STATUSES,
  ROADMAP_STATUS_LABEL,
  entitlementMeta,
  roadmapData,
  roadmapFeatures,
  type Feature,
} from "../roadmap-data";

function serverDocument(): Document {
  const html = renderToStaticMarkup(<RoadmapPage />);
  return new DOMParser().parseFromString(html, "text/html");
}

/** Every node of the tree but its root. */
function treeNodes(node: Feature = roadmapData): Feature[] {
  return (node.children ?? []).flatMap((child) => [child, ...treeNodes(child)]);
}

describe("/roadmap server markup", () => {
  const doc = serverDocument();
  const text = doc.body.textContent ?? "";

  it("carries every feature's name and description", () => {
    const nodes = treeNodes();
    expect(nodes.length).toBeGreaterThan(30);
    for (const node of nodes) {
      expect(text).toContain(node.name);
      if (node.description) expect(text).toContain(node.description);
    }
  });

  it("groups each feature under its status, with its access tier", () => {
    for (const status of ROADMAP_STATUSES) {
      const group = doc.querySelector(`section[aria-labelledby="roadmap-status-${status}"]`);
      const expected = roadmapFeatures().filter((feature) => feature.status === status);
      expect(group).not.toBeNull();
      expect(group?.querySelector("h3")?.textContent).toBe(
        `${ROADMAP_STATUS_LABEL[status]} (${expected.length})`,
      );

      const items = Array.from(group?.querySelectorAll("li") ?? []);
      expect(items).toHaveLength(expected.length);
      expected.forEach((feature, index) => {
        const item = items[index]?.textContent ?? "";
        expect(item).toContain(feature.name);
        if (feature.entitlement) {
          expect(item).toContain(entitlementMeta[feature.entitlement].label);
        }
      });
    }
  });

  it("is the target of the tree's jump link", () => {
    expect(doc.getElementById("roadmap-list")?.tagName).toBe("SECTION");
  });

  it("lists the tree's features in its own order, each once", () => {
    const listed = roadmapFeatures().map((feature) => feature.id);
    expect(listed).toEqual(treeNodes().map((node) => node.id));
    expect(new Set(listed).size).toBe(listed.length);
  });
});
