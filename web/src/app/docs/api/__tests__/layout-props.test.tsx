/**
 * The docs layout hands its client components only what they render.
 *
 * ApiHeader and ApiSidebar are client components, so whatever the layout
 * passes them is serialized into the RSC payload of every /docs/api page. It
 * passed the parsed spec: every endpoint's resolved schemas and examples,
 * twice. Measured 2026-10-21 (SEO review, F07): each docs page was 1.85 to
 * 1.96 MB, 1.77 to 1.84 MB of it RSC payload.
 */
import { render } from "@testing-library/react";

import {
  toApiNavEndpoint,
  toApiSearchEndpoint,
} from "~/@/components/docs/api-nav";
import type { ParsedEndpoint } from "~/lib/openapi/types";

const headerProps = jest.fn();
const sidebarProps = jest.fn();

jest.mock("~/@/components/docs/api-header", () => ({
  ApiHeader: (props: unknown) => {
    headerProps(props);
    return null;
  },
}));
jest.mock("~/@/components/docs/api-sidebar", () => ({
  ApiSidebar: (props: unknown) => {
    sidebarProps(props);
    return null;
  },
}));

import ApiDocsLayout from "../layout";

const NAV_KEYS = ["id", "method", "path", "summary"];
const SEARCH_KEYS = [...NAV_KEYS, "description"].sort();

const fullEndpoint: ParsedEndpoint = {
  id: "post--shorts.v1alpha1.stockservice-getstock",
  method: "POST",
  path: "/shorts.v1alpha1.StockService/GetStock",
  summary: "GetStock",
  description: "Provides an overview of a specific stock based on PRODUCT_CODE.",
  operationId: "StockService_GetStock",
  tags: ["shorts.v1alpha1.StockService"],
  parameters: [{ name: "Connect-Protocol-Version", in: "header", schema: {} }],
  requestBody: { content: { "application/json": { schema: { type: "object" } } } },
  responses: { "200": { description: "Success" } },
};

describe("API docs navigation props", () => {
  it("keeps an endpoint's schemas and examples out of the slim shapes", () => {
    expect(toApiNavEndpoint(fullEndpoint)).toEqual({
      id: fullEndpoint.id,
      method: "POST",
      path: fullEndpoint.path,
      summary: "GetStock",
    });
    expect(Object.keys(toApiSearchEndpoint(fullEndpoint)).sort()).toEqual(
      SEARCH_KEYS,
    );
  });

  it("passes the header and sidebar slim lists of every endpoint in the spec", async () => {
    render(await ApiDocsLayout({ children: null }));

    const { endpoints } = headerProps.mock.calls[0]![0] as {
      endpoints: Record<string, unknown>[];
    };
    const { groups } = sidebarProps.mock.calls[0]![0] as {
      groups: { title: string; endpoints: Record<string, unknown>[] }[];
    };

    expect(endpoints.length).toBeGreaterThan(80);
    for (const endpoint of endpoints) {
      expect(Object.keys(endpoint).sort()).toEqual(SEARCH_KEYS);
    }
    const grouped = groups.flatMap((group) => {
      expect(Object.keys(group)).toEqual(["title", "endpoints"]);
      return group.endpoints;
    });
    expect(grouped).toHaveLength(endpoints.length);
    for (const endpoint of grouped) {
      expect(Object.keys(endpoint).sort()).toEqual([...NAV_KEYS].sort());
    }

    // The full objects serialized to 1.5 MB here; these are what every docs
    // page now carries.
    expect(JSON.stringify({ endpoints, groups }).length).toBeLessThan(60_000);
  });
});
