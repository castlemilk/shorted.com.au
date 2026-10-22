/**
 * Each endpoint page's samples target the host that serves it.
 *
 * The generated spec gives /api/search/stocks and /feed.xml a path-level
 * `servers` entry, "Production (web app, not the API host)":
 * https://shorted.com.au. The page used to build every sample (cURL, the
 * client snippets and Try it) against the document's servers[0], the API host,
 * where neither path exists.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

jest.mock("~/@/components/docs/endpoint-content", () => ({
  EndpointContent: () => null,
}));
jest.mock("~/@/components/docs/code-panel", () => ({
  CodePanel: ({ baseUrl }: { baseUrl?: string }) => <i data-base-url={baseUrl} />,
}));

import EndpointPage from "../[endpoint]/page";

async function baseUrlsOf(endpoint: string): Promise<string[]> {
  const element = await EndpointPage({ params: { endpoint } });
  const html = renderToStaticMarkup(element as React.ReactElement);
  return [...html.matchAll(/data-base-url="([^"]*)"/g)].map((m) => m[1]!);
}

describe("endpoint page base URL", () => {
  it("sends the web-app endpoints' samples to the web host", async () => {
    // Desktop and mobile panels both render.
    expect(await baseUrlsOf("get--feed.xml")).toEqual([
      "https://shorted.com.au",
      "https://shorted.com.au",
    ]);
    expect(await baseUrlsOf("get--api-search-stocks")).toEqual([
      "https://shorted.com.au",
      "https://shorted.com.au",
    ]);
  });

  it("keeps the API host for every Connect endpoint", async () => {
    expect(
      await baseUrlsOf("post--shorts.v1alpha1.ownershipservice-getinstitution"),
    ).toEqual(["https://api.shorted.com.au", "https://api.shorted.com.au"]);
  });
});
