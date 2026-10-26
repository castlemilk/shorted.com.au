/**
 * The /docs/api cluster names itself.
 *
 * Measured on 2026-10-21 (SEO review, F07): /docs/api served the homepage's
 * title and description with no canonical; the 87 endpoint pages and 6 client
 * guides had no canonical and titles that repeated the brand ("GetInstitution
 * | Shorted API Documentation | Shorted"). These pin the rendered metadata.
 */
import type { Metadata } from "next";

import { siteConfig } from "~/@/config/site";
import { parseOpenAPISpec } from "~/lib/openapi/parser";

jest.mock("~/@/components/docs/api-access-section", () => ({
  ApiAccessSection: () => null,
}));
jest.mock("~/@/components/docs/endpoint-content", () => ({
  EndpointContent: () => null,
}));
jest.mock("~/@/components/docs/code-panel", () => ({
  CodePanel: () => null,
}));

import { metadata as indexMetadata } from "../page";
import { generateMetadata as endpointMetadata } from "../[endpoint]/page";
import { generateMetadata as guideMetadata } from "../clients/[language]/page";

/** The title as the root layout's "%s | Shorted" template renders it. */
function rendered(meta: Metadata): string {
  if (typeof meta.title !== "string") throw new Error("expected a plain title");
  return `${meta.title} | ${siteConfig.name}`;
}

const occurrences = (text: string, word: string) => text.split(word).length - 1;

function expectOwnPage(meta: Metadata, url: string) {
  expect(rendered(meta)).not.toBe(siteConfig.fullTitle);
  expect(occurrences(rendered(meta), siteConfig.name)).toBe(1);
  expect(meta.description).toBeTruthy();
  expect(meta.description).not.toBe(siteConfig.description);
  expect(meta.alternates?.canonical).toBe(url);
  expect(meta.openGraph?.url).toBe(url);
  expect(meta.openGraph?.title).toBe(meta.title);
}

const GET_INSTITUTION = "post--shorts.v1alpha1.ownershipservice-getinstitution";

describe("/docs/api metadata", () => {
  it("gives the index its own title, description and canonical", () => {
    expectOwnPage(indexMetadata, `${siteConfig.url}/docs/api`);
    expect(rendered(indexMetadata).length).toBeLessThanOrEqual(65);
  });

  it("titles an endpoint by its method and service, under its own canonical", async () => {
    const meta = await endpointMetadata({ params: { endpoint: GET_INSTITUTION } });

    expectOwnPage(meta, `${siteConfig.url}/docs/api/${GET_INSTITUTION}`);
    expect(rendered(meta)).toBe("GetInstitution — Ownership API | Shorted");
    // The proto comment's line break is gone from the snippet.
    expect(meta.description).toBe(
      "One institution: its current substantial holdings, its notices, its funds and what its holdings files hold.",
    );
  });

  it("keeps every endpoint title unique, brand-free and short", async () => {
    const { endpoints } = await parseOpenAPISpec();
    expect(endpoints.length).toBeGreaterThan(80);

    const titles: string[] = [];
    for (const endpoint of endpoints) {
      const meta = await endpointMetadata({ params: { endpoint: endpoint.id } });
      titles.push(rendered(meta));
      expect(occurrences(rendered(meta), siteConfig.name)).toBe(1);
      expect(rendered(meta).length).toBeLessThanOrEqual(75);
      expect((meta.description as string).length).toBeLessThanOrEqual(160);
    }
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("titles a client guide without repeating the brand, under its own canonical", async () => {
    const meta = await guideMetadata({
      params: Promise.resolve({ language: "python" }),
    });

    expectOwnPage(meta, `${siteConfig.url}/docs/api/clients/python`);
    expect(rendered(meta)).toBe(
      "Python Client Guide — ASX Short Data API | Shorted",
    );
  });
});
