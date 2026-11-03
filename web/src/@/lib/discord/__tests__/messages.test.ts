import { ButtonStyle, ComponentType, MessageFlags, type Button } from "../api";
import { activityCustomId, chartCustomId, parseCustomId } from "../custom-id";
import {
  EMBED_COLOR,
  buildChartMessage,
  buildHelpMessage,
  buildSearchMessage,
  buildCopiedChartMessage,
  buildTopMessage,
  chartCardUrl,
  copiedFigures,
  escapeMarkdown,
  formatChange,
  openOnShortedUrl,
  acceptPricesThrough,
  postedAnchor,
  toAutocompleteChoices,
  type StockSummary,
} from "../messages";

// The global setup stubs this module down to `cn`; the figures need the real
// formatNumber.
jest.mock("@/lib/utils", () => jest.requireActual("@/lib/utils"));

// 19 Oct 2026, 23:30 UTC: already 20 Oct in Sydney.
const NOW = new Date("2026-10-19T23:30:00Z");

/** A PNG's signature is enough to follow a card through the message. */
const CARD = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const BHP: StockSummary = {
  code: "BHP",
  name: "BHP Group",
  industry: "Materials",
  shortPct: 0.8123,
  reportedShorts: 41_200_000,
  sharesOnIssue: 5_070_000_000,
  daysToCover: 2.04,
  marketCap: 230_100_000_000,
  change30d: -0.314,
  asOf: new Date("2026-10-14T00:00:00Z"),
};

const chart = (over: Partial<Parameters<typeof buildChartMessage>[0]> = {}) =>
  buildChartMessage({
    summary: BHP,
    state: { code: "BHP", view: "short", period: "1y" },
    activity: false,
    now: NOW,
    ...over,
  });

function buttons(message: ReturnType<typeof chart>): Button[] {
  return (message.components ?? []).flatMap((row) =>
    row.components.filter((c): c is Button => c.type === ComponentType.BUTTON),
  );
}

describe("formatChange", () => {
  it.each([
    [0.62, "▲ +0.62 pp"],
    [-0.314, "▼ \u22120.31 pp"],
    [0.004, "\u2013 0.00 pp"],
    [-0.004, "\u2013 0.00 pp"],
    [0, "\u2013 0.00 pp"],
  ])("prints %d as the stock header does: %s", (change, text) => {
    expect(formatChange(change)).toBe(text);
  });
});

describe("chartCardUrl", () => {
  it("draws the chart card for the state, keyed by the day in Sydney", () => {
    const url = new URL(
      chartCardUrl({ code: "BHP", view: "combined", period: "6m" }, NOW),
    );
    expect(url.origin + url.pathname).toBe(
      "https://shorted.com.au/chart/BHP/image",
    );
    expect(url.searchParams.get("view")).toBe("combined");
    expect(url.searchParams.get("period")).toBe("6m");
    expect(url.searchParams.get("v")).toBe("2026-10-20");
  });

  it("omits the defaults, as the share links do", () => {
    const url = new URL(
      chartCardUrl({ code: "BHP", view: "short", period: "1y" }, NOW),
    );
    expect(url.searchParams.has("view")).toBe(false);
    expect(url.searchParams.has("period")).toBe(false);
  });
});

describe("buildChartMessage", () => {
  it("leads with the short interest and its 30-day change, to two decimals", () => {
    const [embed] = chart().embeds!;
    expect(embed!.title).toBe("BHP · BHP Group");
    expect(embed!.url).toBe("https://shorted.com.au/shorts/BHP");
    expect(embed!.description).toBe(
      "**0.81%** of shares reported short · ▼ \u22120.31 pp in 30 days",
    );
    expect(embed!.color).toBe(EMBED_COLOR);
    expect(embed!.image!.url).toContain("/chart/BHP/image");
  });

  it("lists only the figures it has", () => {
    const [embed] = chart().embeds!;
    expect(embed!.fields!.map((f) => [f.name, f.value])).toEqual([
      ["Reported short", "41.2M shares"],
      ["Shares on issue", "5.1B"],
      ["Days to cover", "2.0"],
      ["Market cap", "$230.1B"],
      ["Industry", "Materials"],
    ]);

    const [bare] = chart({
      summary: { code: "XYZ" },
      state: { code: "XYZ", view: "short", period: "1y" },
    }).embeds!;
    expect(bare!.title).toBe("XYZ");
    expect(bare!.fields).toEqual([]);
    expect(bare!.description).toBe("No short position in the latest ASIC data");
    expect(JSON.stringify(bare)).not.toMatch(/undefined|NaN|null/);
  });

  it("dates the short positions in the footer, except on the price view", () => {
    expect(chart().embeds![0]!.footer!.text).toBe(
      "Source: ASIC short position reports, short positions as of 14 Oct 2026 · shorted.com.au",
    );
    expect(
      chart({ state: { code: "BHP", view: "price", period: "1y" } }).embeds![0]!
        .footer!.text,
    ).toBe("Source: end-of-day ASX prices · shorted.com.au");
  });

  it("offers a row of periods and a row of views, the chart on screen highlighted", () => {
    const message = chart({
      state: { code: "BHP", view: "price", period: "3m" },
    });
    const [periods, views] = message.components!;
    expect(periods!.components.map((c) => (c as Button).label)).toEqual([
      "1M",
      "3M",
      "6M",
      "1Y",
      "Max",
    ]);
    expect(views!.components.map((c) => (c as Button).label)).toEqual([
      "Short interest",
      "Price",
      "Combined",
      "Open on Shorted",
    ]);
    const active = buttons(message)
      .filter((b) => b.style === ButtonStyle.PRIMARY)
      .map((b) => b.label);
    expect(active).toEqual(["3M", "Price"]);
  });

  it("points each control at the chart it draws", () => {
    const message = chart({
      state: { code: "BHP", view: "price", period: "3m" },
    });
    const byLabel = Object.fromEntries(
      buttons(message).map((b) => [b.label, b]),
    );
    expect(parseCustomId(byLabel["Max"]!.custom_id)).toEqual({
      kind: "chart",
      state: { code: "BHP", view: "price", period: "max" },
    });
    expect(parseCustomId(byLabel["Combined"]!.custom_id)).toEqual({
      kind: "chart",
      state: { code: "BHP", view: "combined", period: "3m" },
    });
    // Sideways on a phone held upright: Discord's in-app browser keeps to
    // portrait, so the page turns the chart instead.
    expect(byLabel["Open on Shorted"]).toMatchObject({
      style: ButtonStyle.LINK,
      url: "https://shorted.com.au/chart/BHP?view=price&period=3m&landscape=1",
    });
  });

  it("keeps within Discord's component rules", () => {
    for (const activity of [false, true]) {
      const message = chart({ activity });
      expect(message.components!.length).toBeLessThanOrEqual(5);
      for (const row of message.components!) {
        expect(row.components.length).toBeLessThanOrEqual(5);
      }
      const ids = buttons(message)
        .map((b) => b.custom_id)
        .filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("offers the Activity only when it is enabled", () => {
    expect(buttons(chart()).some((b) => b.label === "Interactive")).toBe(false);
    const interactive = buttons(chart({ activity: true })).find(
      (b) => b.label === "Interactive",
    );
    expect(parseCustomId(interactive!.custom_id)).toEqual({
      kind: "activity",
      state: { code: "BHP", view: "short", period: "1y" },
    });
  });

  it("uploads the card when it has one, and points at its URL when not", () => {
    const card = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const attached = chart({
      state: { code: "BHP", view: "combined", period: "6m" },
      card,
    });
    expect(attached.embeds![0]!.image!.url).toBe(
      "attachment://BHP-combined-6m.png",
    );
    expect(attached.files).toEqual([
      {
        name: "BHP-combined-6m.png",
        data: card,
        contentType: "image/png",
        description: "BHP share price and short interest chart, past 6 months",
      },
    ]);

    const linked = chart({ card: null });
    expect(linked.files).toBeUndefined();
    expect(linked.embeds![0]!.image!.url).toContain("/chart/BHP/image");
  });

  it("never pings anyone", () => {
    expect(chart().allowed_mentions).toEqual({ parse: [] });
  });
});

describe("buildTopMessage", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    code: `S${String(i).padStart(2, "0")}`,
    name: `Stock_${i} *Holdings*`,
    shortPct: 20 - i * 0.5,
  }));

  it("ranks the stocks with links, escaping markdown in the names", () => {
    const [embed] = buildTopMessage(rows.slice(0, 3)).embeds!;
    expect(embed!.title).toBe("The 3 most shorted ASX stocks");
    expect(embed!.description!.split("\n")[0]).toBe(
      "` 1` [**S00**](https://shorted.com.au/shorts/S00) Stock\\_0 \\*Holdings\\* · **20.00%**",
    );
  });

  it("offers a menu to chart any of them, within Discord's limits", () => {
    const message = buildTopMessage(rows);
    const [menu] = message.components![0]!.components;
    expect(menu!.type).toBe(ComponentType.STRING_SELECT);
    expect((menu as { options: unknown[] }).options).toHaveLength(25);
    expect(message.embeds![0]!.description!.length).toBeLessThanOrEqual(4096);
  });

  it("says so, privately, when the table is unavailable", () => {
    const message = buildTopMessage([]);
    expect(message.flags).toBe(MessageFlags.EPHEMERAL);
    expect(message.embeds).toBeUndefined();
  });
});

describe("buildSearchMessage", () => {
  it("lists matches with a menu to chart one", () => {
    const message = buildSearchMessage("lith", [
      { code: "PLS", name: "Pilbara Minerals", shortPct: 12.345 },
      { code: "LTR", name: "Liontown Resources" },
    ]);
    const [embed] = message.embeds!;
    expect(embed!.title).toBe("Stocks matching “lith”");
    expect(embed!.description).toBe(
      [
        "[**PLS**](https://shorted.com.au/shorts/PLS) Pilbara Minerals · **12.35%**",
        "[**LTR**](https://shorted.com.au/shorts/LTR) Liontown Resources",
      ].join("\n"),
    );
    expect(message.components![0]!.components[0]!.type).toBe(
      ComponentType.STRING_SELECT,
    );
  });

  it("answers no match privately", () => {
    const message = buildSearchMessage("@everyone zzz", []);
    expect(message.flags).toBe(MessageFlags.EPHEMERAL);
    expect(message.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("buildHelpMessage", () => {
  it("is private, and mentions the Activity only when it is on", () => {
    expect(buildHelpMessage({ activity: false }).flags).toBe(
      MessageFlags.EPHEMERAL,
    );
    expect(
      buildHelpMessage({ activity: false }).embeds![0]!.description,
    ).not.toContain("Interactive");
    expect(
      buildHelpMessage({ activity: true }).embeds![0]!.description,
    ).toContain("Interactive");
  });
});

describe("toAutocompleteChoices", () => {
  it("names each choice by code, company and short interest, inside 100 characters", () => {
    const choices = toAutocompleteChoices([
      { code: "BHP", name: "BHP Group", shortPct: 0.81 },
      { code: "LONG", name: "A".repeat(200) },
    ]);
    expect(choices[0]).toEqual({
      name: "BHP · BHP Group · 0.81% short",
      value: "BHP",
    });
    expect(choices[1]!.name.length).toBe(100);
    expect(choices[1]!.value).toBe("LONG");
  });
});

describe("escapeMarkdown", () => {
  it("escapes Discord's formatting characters", () => {
    expect(escapeMarkdown("A*B_C~D`E|F>G[H](I)")).toBe(
      "A\\*B\\_C\\~D\\`E\\|F\\>G\\[H\\]\\(I\\)",
    );
  });
});

describe("charts kept as posted", () => {
  const ANCHOR = {
    day: "2026-11-04",
    shorts: "2026-10-29",
    prices: "2026-11-03",
  };
  const anchored = {
    code: "BHP",
    view: "short",
    period: "3m",
    anchor: ANCHOR,
  } as const;
  const live = { code: "BHP", view: "short", period: "3m" } as const;

  it("footer names the posting day and the report, and the price view names only the day", () => {
    expect(chart({ state: anchored }).embeds![0]!.footer!.text).toBe(
      "Source: ASIC short position reports, short positions as of 29 Oct 2026 · As posted 4 Nov 2026 · shorted.com.au",
    );
    expect(
      chart({
        state: { ...anchored, view: "price" },
      }).embeds![0]!.footer!.text,
    ).toBe(
      "Source: end-of-day ASX prices · As posted 4 Nov 2026 · shorted.com.au",
    );
  });

  it("keeps the figures and the footer the same for the same view, posted or redrawn", () => {
    const posted = chart({ state: anchored, summary: { ...BHP, asOf: null } });
    const redrawn = buildCopiedChartMessage({
      figures: copiedFigures(posted.embeds![0])!,
      state: anchored,
      activity: false,
      now: NOW,
      card: null,
    });
    expect(redrawn.embeds![0]!.title).toBe(posted.embeds![0]!.title);
    expect(redrawn.embeds![0]!.description).toBe(
      posted.embeds![0]!.description,
    );
    expect(redrawn.embeds![0]!.fields).toEqual(posted.embeds![0]!.fields);
    expect(redrawn.embeds![0]!.footer).toEqual(posted.embeds![0]!.footer);
  });

  it("puts the anchor in every button id and in the share link, and names the period by its end date", () => {
    const message = chart({ state: anchored, activity: true });
    const ids = message.components!.flatMap((row) =>
      row.components.flatMap((c) => (c.custom_id ? [c.custom_id] : [])),
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(parseCustomId(id)).toMatchObject({ state: { anchor: ANCHOR } });
    }
    expect(ids).toContain(
      chartCustomId("view", { ...anchored, view: "price" }),
    );
    expect(ids).toContain(activityCustomId(anchored));
    const open = new URL(openOnShortedUrl(anchored));
    expect(open.searchParams.get("asof")).toBe("2026-11-04");
    expect(open.searchParams.get("shorts")).toBe("2026-10-29");
    expect(open.searchParams.get("landscape")).toBe("1");
    expect(message.files).toBeUndefined();
    expect(chart({ state: anchored, card: CARD }).embeds![0]!.image!.url).toBe(
      "attachment://BHP-short-3m.png",
    );
    expect(chart({ state: anchored, card: CARD }).files![0]!.description).toBe(
      "BHP short interest chart, 3 months to 4 Nov 2026",
    );
  });

  it("points the card's URL at the anchored state, keyed by its posting day, not today", () => {
    const url = new URL(chartCardUrl(anchored, NOW));
    expect(url.searchParams.get("asof")).toBe("2026-11-04");
    expect(url.searchParams.get("shorts")).toBe("2026-10-29");
    expect(url.searchParams.get("prices")).toBe("2026-11-03");
    // NOW is 20 Oct in Sydney: a pinned card does not move with the day.
    expect(url.searchParams.get("v")).toBe("2026-11-04");
    // A live card is still keyed by today.
    expect(new URL(chartCardUrl(live, NOW)).searchParams.get("v")).toBe(
      "2026-10-20",
    );
  });

  it("dates a posting by Sydney's calendar day, and never after it", () => {
    // 19 Oct 23:30 UTC is 20 Oct in Sydney; a report dated 20 Oct is that day.
    expect(
      postedAnchor({ asOf: new Date("2026-10-19T14:00:00Z") }, NOW),
    ).toEqual({
      day: "2026-10-20",
      shorts: "2026-10-20",
      prices: "2026-10-20",
    });
    expect(
      postedAnchor({ asOf: new Date("2026-10-14T00:00:00Z") }, NOW),
    ).toEqual({
      day: "2026-10-20",
      shorts: "2026-10-14",
      prices: "2026-10-20",
    });
  });

  it("is no anchor at all without the report date, so the chart is live", () => {
    expect(postedAnchor({ asOf: null }, NOW)).toBeNull();
    expect(postedAnchor({}, NOW)).toBeNull();
  });
});

describe("acceptPricesThrough", () => {
  it("keeps a real day on or before the posting day", () => {
    expect(acceptPricesThrough("2026-11-03", "2026-11-04")).toBe("2026-11-03");
    expect(acceptPricesThrough("2026-11-04", "2026-11-04")).toBe("2026-11-04");
  });

  it.each([
    ["after the day", "2026-11-05"],
    ["not a date", "2026-11-3"],
    ["an impossible date", "2026-02-30"],
    ["text", "<script>"],
    ["empty", ""],
    ["missing", null],
  ])("refuses %s", (_label, value) => {
    expect(acceptPricesThrough(value, "2026-11-04")).toBeUndefined();
  });

  it("refuses everything for a live chart, which has no day to check against", () => {
    expect(acceptPricesThrough("2026-11-03", undefined)).toBeUndefined();
  });
});

describe("copiedFigures", () => {
  it("keeps the title, description and fields of a well-formed embed", () => {
    expect(
      copiedFigures({
        title: "BHP · BHP Group",
        description: "**0.81%** of shares",
        fields: [{ name: "Industry", value: "Materials", inline: true }],
      }),
    ).toEqual({
      title: "BHP · BHP Group",
      description: "**0.81%** of shares",
      fields: [{ name: "Industry", value: "Materials", inline: true }],
    });
  });

  it("keeps only the parts with the right types, cut to Discord's limits", () => {
    const figures = copiedFigures({
      title: "x".repeat(400),
      description: 7,
      fields: [
        { name: "Good", value: "1" },
        { name: 3, value: "bad name" },
        { name: "Empty", value: "" },
        null,
        { name: "Long", value: "y".repeat(2000), inline: "yes" },
      ],
    });
    expect(figures!.title).toHaveLength(256);
    expect(figures!.description).toBeUndefined();
    expect(figures!.fields).toEqual([
      { name: "Good", value: "1", inline: true },
      { name: "Long", value: expect.stringMatching(/…$/), inline: true },
    ]);
    expect(figures!.fields[1]!.value).toHaveLength(1024);
  });

  it("is null without a usable title", () => {
    expect(copiedFigures(undefined)).toBeNull();
    expect(copiedFigures("embed")).toBeNull();
    expect(copiedFigures({ title: "  " })).toBeNull();
    expect(copiedFigures({ description: "no title" })).toBeNull();
  });
});

describe("buildHelpMessage on charts kept as posted", () => {
  it("says a chart keeps its window and figures, and that a server can change it", () => {
    const text = buildHelpMessage({ activity: false }).embeds![0]!.description!;
    expect(text).toContain("keeps the window and figures it was posted with");
    expect(text).toContain("`/settings`");
    expect(text).not.toContain("Pressing the highlighted one again");
    // No em or en dashes in user-facing copy.
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
