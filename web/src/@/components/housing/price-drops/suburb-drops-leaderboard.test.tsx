import { render, screen } from "@testing-library/react";
import type { SuburbPriceDrop } from "~/gen/shorts/v1alpha1/housing_pb";
import { SuburbDropsLeaderboard } from "./suburb-drops-leaderboard";

const row = (over: Partial<SuburbPriceDrop>) =>
  ({
    regionCode: "SUBURB:VIC-3806-BERWICK",
    salCode: "20224",
    salName: "Berwick",
    stateCode: "VIC",
    postcode: "3806",
    droppedListingCount: 12,
    droppedShare: 0.08,
    medianDropPct: 0.04,
    maxDropPct: 0.12,
    medianAsking: 950_000,
    medianSold: 0,
    soldCount: 0,
    ...over,
  }) as SuburbPriceDrop;

// The board's postcode is the crawl region's, which the SAL feed does not carry
// (0 of 15,345 SALs had one on 2026-10-21). Every one of the 15 links on
// /price-drops was /<name>-<postcode>?sal=… and 308-redirected, and for an
// ABS-qualified name the postcode slug 404ed. Each link is the canonical path the
// sitemap lists: the ABS name's slug, with no query and no postcode.
describe("SuburbDropsLeaderboard links", () => {
  it("links each suburb by its canonical path", () => {
    render(
      <SuburbDropsLeaderboard
        suburbs={[
          row({}),
          row({ regionCode: "SUBURB:NSW-2046-ABBOTSFORD", salCode: "10003", salName: "Abbotsford (NSW)", stateCode: "NSW", postcode: "2046" }),
          // One name, two suburbs in one state: the ABS qualifier keeps them apart.
          row({ regionCode: "SUBURB:VIC-3350-ASCOT", salCode: "20073", salName: "Ascot (Ballarat - Vic.)", postcode: "3350" }),
          row({ regionCode: "SUBURB:VIC-3551-ASCOT", salCode: "20074", salName: "Ascot (Greater Bendigo - Vic.)", postcode: "3551" }),
        ]}
      />,
    );
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "/housing/vic/berwick",
      "/housing/nsw/abbotsford-nsw",
      "/housing/vic/ascot-ballarat-vic",
      "/housing/vic/ascot-greater-bendigo-vic",
    ]);
    for (const href of hrefs) {
      expect(href).not.toContain("?");
      expect(href).not.toMatch(/-\d{4}$/);
    }
  });

  it("does not link a suburb the crawl could not match to an ABS suburb", () => {
    render(<SuburbDropsLeaderboard suburbs={[row({ salCode: "", salName: "Brunswick" })]} />);
    expect(screen.getByText("brunswick").closest("a")).toBeNull();
  });
});
