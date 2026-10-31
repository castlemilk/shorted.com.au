import { ButtonStyle, ComponentType, MessageFlags, type Button } from "../api";
import { parseCustomId } from "../custom-id";
import {
  EMBED_COLOR,
  buildChartMessage,
  buildHelpMessage,
  buildSearchMessage,
  buildTopMessage,
  chartCardUrl,
  escapeMarkdown,
  formatChange,
  toAutocompleteChoices,
  type StockSummary,
} from "../messages";

// The global setup stubs this module down to `cn`; the figures need the real
// formatNumber.
jest.mock("@/lib/utils", () => jest.requireActual("@/lib/utils"));

// 19 Oct 2026, 23:30 UTC: already 20 Oct in Sydney.
const NOW = new Date("2026-10-19T23:30:00Z");

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
