import {
  groupMarketMovesByDate,
  sydneyDate,
  toMarketMoveView,
  toMarketMoveViews,
  type MarketMoveLike,
} from "../view";
import {
  MINUS,
  formatMarketDate,
  formatMoveChange,
  formatMovePrice,
  formatObservedAt,
  formatVolumeRatio,
} from "../format";

function move(overrides: Partial<MarketMoveLike> = {}): MarketMoveLike {
  return {
    moveKey: "2026-11-07:bhp:iron-ore",
    kind: "stock",
    stockCode: "BHP",
    companyName: "BHP Group",
    indexCode: "",
    sector: "",
    relatedCodes: ["RIO", "FMG"],
    direction: "up",
    changePct: 4.2,
    hasChangePct: true,
    price: 45.1,
    hasPrice: true,
    volumeRatio: 2.1,
    hasVolumeRatio: true,
    headline: "BHP jumps as iron ore rallies",
    summary:
      "Iron ore futures rose 6% overnight.\n\nMiners led the market higher.",
    sources: [
      {
        title: "Iron ore rallies",
        url: "https://example.com/iron",
        publisher: "Example",
      },
    ],
    tags: ["iron-ore"],
    significance: 4,
    observedAt: "2026-11-07T03:05:00Z",
    marketDate: "2026-11-07",
    revision: 1,
    publishedAt: "2026-11-07T03:06:00Z",
    updatedAt: "2026-11-07T03:06:00Z",
    model: "claude-opus-5-5",
    ...overrides,
  };
}

describe("toMarketMoveView", () => {
  it("maps a full move to plain data", () => {
    const view = toMarketMoveView(move());
    expect(view).toMatchObject({
      moveKey: "2026-11-07:bhp:iron-ore",
      kind: "stock",
      stockCode: "BHP",
      companyName: "BHP Group",
      indexCode: null,
      sector: null,
      relatedCodes: ["RIO", "FMG"],
      direction: "up",
      changePct: 4.2,
      price: 45.1,
      volumeRatio: 2.1,
      significance: 4,
      marketDate: "2026-11-07",
      model: "claude-opus-5-5",
    });
    // Plain data only: it survives a JSON round trip unchanged.
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it("keeps a figure the poster did not give as null, never 0", () => {
    const view = toMarketMoveView(
      move({
        hasChangePct: false,
        changePct: 0,
        hasPrice: false,
        price: 0,
        hasVolumeRatio: false,
        volumeRatio: 0,
      }),
    );
    expect(view?.changePct).toBeNull();
    expect(view?.price).toBeNull();
    expect(view?.volumeRatio).toBeNull();
  });

  it("keeps a real zero change when the poster gave it", () => {
    expect(
      toMarketMoveView(
        move({ direction: "flat", changePct: 0, hasChangePct: true }),
      )?.changePct,
    ).toBe(0);
  });

  it("leaves out a move it cannot draw faithfully", () => {
    expect(toMarketMoveView(move({ kind: "crypto" }))).toBeNull();
    expect(toMarketMoveView(move({ direction: "sideways" }))).toBeNull();
    expect(toMarketMoveView(move({ headline: "  " }))).toBeNull();
    expect(toMarketMoveView(move({ observedAt: "yesterday" }))).toBeNull();
    expect(toMarketMoveView(move({ stockCode: "" }))).toBeNull();
  });

  it("keeps only http(s) sources with a title", () => {
    const view = toMarketMoveView(
      move({
        sources: [
          { title: "Good", url: "https://example.com/a", publisher: "" },
          { title: "Script", url: "javascript:alert(1)", publisher: "" },
          { title: "", url: "https://example.com/b", publisher: "" },
        ],
      }),
    );
    expect(view?.sources).toEqual([
      { title: "Good", url: "https://example.com/a", publisher: null },
    ]);
  });

  it("names only the subject its kind has", () => {
    const view = toMarketMoveView(
      move({
        kind: "index",
        stockCode: "",
        companyName: "",
        indexCode: "xjo",
        relatedCodes: ["BHP"],
      }),
    );
    expect(view).toMatchObject({
      kind: "index",
      stockCode: null,
      companyName: null,
      indexCode: "XJO",
      relatedCodes: ["BHP"],
    });
  });

  it("drops the move's own code and repeats from related codes", () => {
    expect(
      toMarketMoveView(move({ relatedCodes: ["BHP", "RIO", "rio"] }))
        ?.relatedCodes,
    ).toEqual(["RIO"]);
  });

  it("dates a move by Sydney when the API sent no market date", () => {
    // 14:30 UTC on 7 November is 01:30 on the 8th in Sydney (AEDT).
    expect(
      toMarketMoveView(
        move({ marketDate: "", observedAt: "2026-11-07T14:30:00Z" }),
      )?.marketDate,
    ).toBe("2026-11-08");
    expect(sydneyDate("2026-11-07T14:30:00Z")).toBe("2026-11-08");
  });

  it("maps a list, leaving out what cannot be drawn", () => {
    expect(toMarketMoveViews([move(), move({ kind: "nope" })])).toHaveLength(1);
  });
});

describe("groupMarketMovesByDate", () => {
  it("groups by market date, newest date first, each in feed order", () => {
    const views = toMarketMoveViews([
      move({ moveKey: "b", marketDate: "2026-11-07" }),
      move({ moveKey: "a", marketDate: "2026-11-07" }),
      move({ moveKey: "c", marketDate: "2026-11-06" }),
      move({ moveKey: "d", marketDate: "2026-11-09" }),
    ]);
    const groups = groupMarketMovesByDate(views);
    expect(groups.map((g) => g.marketDate)).toEqual([
      "2026-11-09",
      "2026-11-07",
      "2026-11-06",
    ]);
    expect(groups[1]!.moves.map((m) => m.moveKey)).toEqual(["b", "a"]);
  });
});

describe("format", () => {
  it("signs a change, with U+2212 for a fall and no sign for zero", () => {
    expect(formatMoveChange(4.2)).toBe("+4.20%");
    expect(formatMoveChange(-3.1)).toBe(`${MINUS}3.10%`);
    expect(formatMoveChange(-3.1)).not.toContain("-");
    expect(formatMoveChange(0.004)).toBe("0.00%");
    expect(formatMoveChange(-0.004)).toBe("0.00%");
  });

  it("prints a stock price in dollars and an index level as a number", () => {
    expect(formatMovePrice({ kind: "stock", price: 45.1 })).toBe("$45.10");
    expect(formatMovePrice({ kind: "stock", price: 0.045 })).toBe("$0.045");
    expect(formatMovePrice({ kind: "index", price: 8512.34 })).toBe("8,512.3");
    expect(formatMovePrice({ kind: "stock", price: null })).toBeNull();
  });

  it("prints a volume ratio, or nothing without one", () => {
    expect(formatVolumeRatio(2.14)).toBe("2.1× usual volume");
    expect(formatVolumeRatio(null)).toBeNull();
  });

  // en-AU short months are CLDR's: "Nov", but "July" and "June" in full.
  it("states the observation time in Sydney with its zone", () => {
    expect(formatObservedAt("2026-11-07T03:05:00Z")).toBe(
      "Observed 2:05 pm AEDT, Sat 7 Nov",
    );
    expect(formatObservedAt("2026-07-07T03:05:00Z")).toBe(
      "Observed 1:05 pm AEST, Tue 7 July",
    );
    expect(formatObservedAt("not a time")).toBe("");
  });

  it("names a market date in words", () => {
    expect(formatMarketDate("2026-11-07")).toBe("Saturday 7 November 2026");
  });
});
