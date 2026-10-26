/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";

/**
 * The suburb profile's robots key. Next 14.2 merges metadata with `for (key in
 * source)`, so an own `robots: undefined` replaces the root layout's robots
 * (and its googleBot max-image-preview / max-snippet directives) with nothing:
 * the 5,323 sitemapped suburbs emitted no robots meta at all (2026-10-21).
 * Indexable means no key; a thin suburb carries the noindex.
 */

jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("~/app/actions/getHousing", () => ({
  getSuburbProfile: jest.fn(),
  resolveSuburbSalCode: jest.fn(),
}));
jest.mock("~/app/actions/getHousingStateIndex", () => ({
  getStateSuburbIndex: jest.fn(async () => []),
}));
// The committed ABS boundaries are read from disk; the geo.* tags are not
// what this test is about.
jest.mock("~/@/lib/housing/suburb-geometry.server", () => ({
  getSuburbGeometry: jest.fn(() => null),
}));

import { getSuburbProfile, resolveSuburbSalCode } from "~/app/actions/getHousing";
import { generateMetadata } from "~/app/housing/[state]/[suburb]/page";

const mockProfile = getSuburbProfile as jest.Mock;
const mockResolve = resolveSuburbSalCode as jest.Mock;

const params = Promise.resolve({ state: "vic", suburb: "altona-north" });

describe("suburb profile metadata", () => {
  it("sets no robots key on a priced suburb", async () => {
    mockResolve.mockResolvedValue("20012");
    mockProfile.mockResolvedValue({
      summary: { salCode: "20012", salName: "ALTONA NORTH", postcode: "3025", latestMedianPrice: 960_000 },
      demographics: { population: 13_000 },
    });
    const meta = await generateMetadata({ params });
    expect(Object.keys(meta)).not.toContain("robots");
    expect(meta.title).toContain("Altona North");
  });

  it("noindexes a suburb with no price and too few residents, and still follows its links", async () => {
    mockResolve.mockResolvedValue("20012");
    mockProfile.mockResolvedValue({
      summary: { salCode: "20012", salName: "ALTONA NORTH", postcode: "3025", latestMedianPrice: 0 },
      demographics: { population: 3 },
    });
    const meta = await generateMetadata({ params });
    expect(meta.robots).toEqual({ index: false, follow: true });
  });
});
