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

  // The profile body used to sit behind a single dynamic({ssr:false}) wrapper, so
  // every suburb URL in the sitemap served a grey skeleton: no <h1>, no price, no
  // demographics in the HTML. Measured on a production build before the fix:
  // 0 <h1>, 0 price figures, 70,785 bytes. After: 1 <h1>, 8 price figures.
  //
  // These pin the two halves of that fix. They are string assertions on purpose —
  // the failure mode is an import edit, and it is silent at runtime.
  describe("the profile body is server rendered", () => {
    const profile = readFileSync(
      resolve(__dirname, "../../../../../@/components/housing/suburb-profile.tsx"),
      "utf8",
    );

    it("renders the profile directly rather than through an ssr:false loader", () => {
      expect(source).toContain('from "@/components/housing/suburb-profile"');
      expect(source).not.toContain("suburb-profile-loader");
      // The server already holds the decoded profile; passing it as a prop is what
      // lets the body render on the server instead of being re-fetched on the client.
      expect(source).toContain("profile={profile}");
      expect(source).not.toContain("initialProfileJson");
    });

    it("keeps suburb-profile.tsx itself a server component", () => {
      expect(profile).not.toMatch(/^"use client"/m);
      // Any React hook drags the whole body back into the client bundle.
      expect(profile).not.toMatch(/\buse(State|Effect|Memo|Query|Router|SearchParams)\s*\(/);
    });

    it("keeps connect-web off the suburb SSR path", () => {
      // This is the specific import that throws "Element type is invalid" during
      // SSR. Client actions must be reached only through an ssr:false island.
      expect(profile).not.toContain("actions/client/getHousingClient");
      expect(profile).not.toContain("@connectrpc/connect");
    });

    it("routes every connect-web island through an ssr:false loader", () => {
      for (const loader of [
        "./housing-charts",
        "./suburb-locator-map-loader",
        "./suburb-nearby-rail-loader",
        "./suburb-recent-price-drops-loader",
      ]) {
        expect(profile).toContain(`from "${loader}"`);
      }
      // Importing the island directly would put it back on the SSR path.
      for (const direct of [
        './suburb-nearby-rail"',
        './suburb-recent-price-drops"',
        './suburb-locator-map"',
        './housing-series-chart"',
      ]) {
        expect(profile).not.toContain(`from "${direct}`);
      }
    });
  });
});
