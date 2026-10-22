import { render } from "@testing-library/react";

import BattlegroundsPage, * as segment from "./page";

const getBattlegrounds = jest.fn();
const getAvailableDates = jest.fn();
const bailOnEmptyRender = jest.fn();

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () =>
    function BattlegroundsClient() {
      return null;
    },
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/getBattlegrounds", () => ({
  getBattlegrounds: (...args: unknown[]) => getBattlegrounds(...args),
}));
jest.mock("~/app/actions/market/getMarketByDate", () => ({
  getAvailableDates: (...args: unknown[]) => getAvailableDates(...args),
}));

const SQUEEZE_ROW = {
  stockCode: "DRO",
  companyName: "DroneShield Limited",
  industry: "Capital Goods",
  logoUrl: "",
  shortPct: 9.4,
  shortPctChange4w: 1.2,
  latestPrice: 3.1,
  priceChange1m: 12,
  daysToCover: 2.5,
  squeezeScore: 61.2,
  divergenceScore: 30,
  marketCap: 2.7e9,
};

/** Every JSON-LD block the page rendered, parsed. */
function jsonLd(container: HTMLElement): Array<Record<string, unknown>> {
  return Array.from(
    container.querySelectorAll('script[type="application/ld+json"]'),
  ).map((node) => JSON.parse(node.textContent ?? "{}") as Record<string, unknown>);
}

describe("/battlegrounds", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getBattlegrounds.mockResolvedValue({ stocks: [SQUEEZE_ROW], totalCount: 1 });
    getAvailableDates.mockResolvedValue({ dates: ["2026-10-15"] });
  });

  // No revalidate export made the route static with no lifetime: regenerated
  // only when purged, and (with the untagged read) never successfully.
  it("is ISR with an hourly lifetime, not static or per request", () => {
    expect(segment.revalidate).toBe(3600);
    expect("dynamic" in segment).toBe(false);
  });

  it("dates the Dataset by the ASIC report the scores come from, not the render clock", async () => {
    const { container } = render(await BattlegroundsPage());

    const dataset = jsonLd(container).find((block) => block["@type"] === "Dataset");
    expect(dataset?.dateModified).toBe("2026-10-15");
    expect(getAvailableDates).toHaveBeenCalledWith(1);
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("renders the rows it read as the crawlable ItemList", async () => {
    const { container } = render(await BattlegroundsPage());

    const itemList = jsonLd(container).find((block) => block["@type"] === "ItemList");
    expect(JSON.stringify(itemList)).toContain("/shorts/DRO");
  });

  it("keeps a failed read's shell in the route cache for a minute, not the hour", async () => {
    getBattlegrounds.mockResolvedValue(undefined);
    getAvailableDates.mockRejectedValue(new Error("unavailable"));

    render(await BattlegroundsPage());

    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });
});
