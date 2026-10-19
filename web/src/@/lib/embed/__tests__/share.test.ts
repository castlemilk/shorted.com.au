import { buildEmbedSnippet, type EmbedTarget } from "../snippet";
import {
  SHARE_CHANNEL_IDS,
  buildShareKit,
  isShareChannelId,
  type ShareChannelId,
} from "../share";

const WBT: EmbedTarget = {
  kind: "chart",
  code: "wbt",
  view: "combined",
  period: "1m",
};

const ALL_TARGETS: EmbedTarget[] = [
  { kind: "chart", code: "BHP" },
  WBT,
  { kind: "top-shorts", limit: 20 },
  { kind: "treemap", period: "3m" },
  { kind: "basket", basket: "banks" },
];

function channel(target: EmbedTarget, id: ShareChannelId) {
  const c = buildShareKit(target).channels.find((ch) => ch.id === id);
  if (!c) throw new Error(`no ${id} channel`);
  return c;
}

describe("buildShareKit", () => {
  it("shares a chart as its share page, with the chart as the card", () => {
    const kit = buildShareKit(WBT);
    expect(kit.url).toBe(
      "https://shorted.com.au/chart/WBT?view=combined&period=1m",
    );
    expect(kit.headline).toBe("WBT share price and short interest, past month");
    expect(kit.imageUrl).toBe(
      "https://shorted.com.au/chart/WBT/image?view=combined&period=1m",
    );
    expect(kit.imageFileName).toBe("WBT-combined-1m.png");
  });

  it("shares the other widgets as the page they came from, which has its own card", () => {
    expect(buildShareKit({ kind: "top-shorts" })).toMatchObject({
      url: "https://shorted.com.au/top",
      headline: "Most shorted ASX stocks",
      imageUrl: null,
    });
    expect(buildShareKit({ kind: "basket" }).url).toBe(
      "https://shorted.com.au/statistics",
    );
  });

  it("offers every channel, in order, for every widget", () => {
    for (const target of ALL_TARGETS) {
      expect(buildShareKit(target).channels.map((c) => c.id)).toEqual(
        SHARE_CHANNEL_IDS,
      );
    }
  });

  it("puts the link in every chat and social channel's copy", () => {
    for (const target of ALL_TARGETS) {
      const kit = buildShareKit(target);
      for (const c of kit.channels) {
        if (c.id === "website") continue;
        expect(c.text).toContain(kit.url);
      }
    }
  });

  it("never sends HTML to a chat app (the reported Discord paste)", () => {
    for (const id of ["discord", "slack", "x", "linkedin"] as const) {
      expect(channel(WBT, id).text).not.toMatch(/<\/?[a-z][^>]*>/i);
    }
  });

  it("never wraps a Discord link in angle brackets, which hides its preview", () => {
    const { text } = channel(WBT, "discord");
    expect(text).toBe(
      "**WBT share price and short interest, past month**\nhttps://shorted.com.au/chart/WBT?view=combined&period=1m",
    );
    expect(text).not.toContain("<https://");
  });

  it("writes the ticker as ASX:CODE where $CODE would read as a US cashtag", () => {
    expect(channel(WBT, "x").text).toMatch(/^ASX:WBT /);
    expect(channel(WBT, "x").text).not.toContain("$WBT");
    expect(channel(WBT, "linkedin").text).toMatch(/^ASX:WBT /);
  });

  it("prefills each network's own composer", () => {
    const x = new URL(channel(WBT, "x").intent!.href);
    expect(`${x.origin}${x.pathname}`).toBe("https://x.com/intent/tweet");
    expect(x.searchParams.get("url")).toBe(buildShareKit(WBT).url);
    expect(x.searchParams.get("via")).toBe("shorted___");
    expect(x.searchParams.get("text")).toContain("ASX:WBT");

    const li = new URL(channel(WBT, "linkedin").intent!.href);
    expect(li.hostname).toBe("www.linkedin.com");
    expect(li.searchParams.get("url")).toBe(buildShareKit(WBT).url);

    const reddit = new URL(channel(WBT, "reddit").intent!.href);
    expect(reddit.hostname).toBe("www.reddit.com");
    expect(reddit.searchParams.get("url")).toBe(buildShareKit(WBT).url);
    expect(reddit.searchParams.get("title")).toBe(
      "ASX:WBT share price and short interest, past month",
    );
  });

  it("keeps an X post inside 280 characters (a link counts as 23)", () => {
    for (const target of ALL_TARGETS) {
      const text = new URL(channel(target, "x").intent!.href).searchParams.get(
        "text",
      )!;
      // text + space + t.co link + " via @shorted___"
      expect(text.length + 1 + 23 + 16).toBeLessThanOrEqual(280);
    }
  });

  it("embeds the chart image in Markdown, linked to the live chart", () => {
    const md = channel(WBT, "markdown").text;
    expect(md).toContain(
      "[![WBT share price and short interest chart](https://shorted.com.au/chart/WBT/image?view=combined&period=1m)](https://shorted.com.au/chart/WBT?view=combined&period=1m)",
    );
    expect(md).toContain("[Shorted.com.au](https://shorted.com.au)");
    // No image for a widget without one.
    expect(channel({ kind: "top-shorts" }, "markdown").text).not.toContain(
      "![",
    );
  });

  it("keeps the website channel as the crawlable embed snippet, unchanged", () => {
    for (const target of ALL_TARGETS) {
      expect(channel(target, "website").text).toBe(
        buildEmbedSnippet(target).html,
      );
    }
  });
});

describe("isShareChannelId", () => {
  it("narrows stored values", () => {
    expect(isShareChannelId("discord")).toBe(true);
    expect(isShareChannelId("website")).toBe(true);
    expect(isShareChannelId("myspace")).toBe(false);
    expect(isShareChannelId(null)).toBe(false);
  });
});
