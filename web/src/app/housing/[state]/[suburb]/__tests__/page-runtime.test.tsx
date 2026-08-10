/// <reference types="jest" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("suburb profile route caching contract", () => {
  const source = readFileSync(resolve(__dirname, "../page.tsx"), "utf8");

  it("opts the dynamic segment into on-demand ISR", async () => {
    jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
    jest.mock("@connectrpc/connect-web", () => ({ createConnectTransport: jest.fn(() => ({})) }));

    const PageModule = await import("../page");

    expect(PageModule.dynamic).toBeUndefined();
    expect(PageModule.revalidate).toBe(86400);
    expect(PageModule.generateStaticParams).toBeDefined();
    expect(PageModule.generateStaticParams()).toEqual([]);
  });

  it("opts the dynamic OG segment into on-demand ISR", async () => {
    jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
    jest.mock("@connectrpc/connect-web", () => ({ createConnectTransport: jest.fn(() => ({})) }));

    const OgModule = await import("../opengraph-image");

    expect(OgModule.revalidate).toBe(86400);
    expect(OgModule.generateStaticParams).toBeDefined();
    expect(OgModule.generateStaticParams()).toEqual([]);
  });

  it("keeps the sal query parameter out of the server render path", () => {
    expect(source).not.toContain("searchParams");
    expect(source).not.toMatch(/\.sal\b/);
  });

  it("does not collapse backend failures into not-found responses", () => {
    expect(source).not.toContain(".catch(() => null)");
    expect(source).toContain("NotFoundError");
    expect(source).toContain("throw new Error(`Unable to load suburb profile");
  });

  it("redirects legacy or mismatched paths to the profile-derived canonical URL", () => {
    expect(source).toContain("const canonicalSlug = suburbSlug(profile.summary.salName, profile.summary.postcode)");
    expect(source).toContain("permanentRedirect(`/housing/${stateSlug(profileState)}/${canonicalSlug}`)");
  });
});
