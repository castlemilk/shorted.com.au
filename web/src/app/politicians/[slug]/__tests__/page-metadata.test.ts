/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";

/**
 * The profile's robots key. Next 14.2 merges metadata with `for (key in
 * source)`, so an own `robots: undefined` replaces the root layout's robots
 * (and its googleBot max-image-preview / max-snippet directives) with nothing:
 * the 363 sitemapped profiles emitted no robots meta at all (2026-10-21).
 * Indexable means no key; a thin profile carries the noindex.
 */

jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("~/app/actions/getPoliticians", () => ({ getPolitician: jest.fn() }));

import { getPolitician } from "~/app/actions/getPoliticians";
import { generateMetadata } from "../page";

const mockGetPolitician = getPolitician as jest.Mock;

function politician(counts: { declaredListedCount: number; declaredPropertyCount: number }) {
  return {
    politician: {
      slug: "anthony-albanese",
      displayName: "Anthony Albanese",
      chamber: "house",
      division: "Grayndler",
      stateCode: "NSW",
      ...counts,
    },
  };
}

const params = Promise.resolve({ slug: "anthony-albanese" });

describe("politician profile metadata", () => {
  it("sets no robots key on a profile with register entries", async () => {
    mockGetPolitician.mockResolvedValue(
      politician({ declaredListedCount: 0, declaredPropertyCount: 2 }),
    );
    const meta = await generateMetadata({ params });
    expect(Object.keys(meta)).not.toContain("robots");
    expect(meta.alternates?.canonical).toBe("https://shorted.com.au/politicians/anthony-albanese");
  });

  it("noindexes a profile with nothing declared, and still follows its links", async () => {
    mockGetPolitician.mockResolvedValue(
      politician({ declaredListedCount: 0, declaredPropertyCount: 0 }),
    );
    const meta = await generateMetadata({ params });
    expect(meta.robots).toEqual({ index: false, follow: true });
  });
});
