import { buildEmbedSnippet, embedNoun, type EmbedTarget } from "../snippet";

const ALL_TARGETS: EmbedTarget[] = [
  { kind: "chart", code: "BHP" },
  { kind: "chart", code: "BHP", view: "price", period: "3m" },
  { kind: "chart", code: "BHP", view: "combined" },
  { kind: "top-shorts" },
  { kind: "treemap" },
  { kind: "basket" },
];

describe("buildEmbedSnippet", () => {
  it("puts a crawlable deep link and brand link in the HOST page markup", () => {
    // The whole point: /embed/* is noindex + robots-disallowed, so a link
    // inside the iframe is worth nothing. Both links must be in the snippet.
    for (const target of ALL_TARGETS) {
      const s = buildEmbedSnippet(target);
      expect(s.html).toContain(`<a href="${s.deepLink}">${s.deepLinkAnchor}</a>`);
      expect(s.html).toContain(`<a href="https://shorted.com.au">Shorted.com.au</a>`);
      expect(s.html).toContain("<figcaption");
    }
  });

  it("uses absolute URLs everywhere (the snippet runs on someone else's domain)", () => {
    for (const target of ALL_TARGETS) {
      const s = buildEmbedSnippet(target);
      expect(s.iframeSrc.startsWith("https://shorted.com.au/embed/")).toBe(true);
      expect(s.deepLink.startsWith("https://shorted.com.au/")).toBe(true);
      // no root-relative hrefs/srcs, which would resolve against the host site
      expect(s.html).not.toMatch(/(?:href|src)="\/(?!\/)/);
    }
  });

  it("lazy-loads the iframe so it cannot wreck the host page's LCP", () => {
    for (const target of ALL_TARGETS) {
      expect(buildEmbedSnippet(target).html).toContain('loading="lazy"');
    }
  });

  it("gives each widget keyword-rich anchor text pointing at its own page", () => {
    expect(buildEmbedSnippet({ kind: "chart", code: "BHP" })).toMatchObject({
      deepLink: "https://shorted.com.au/shorts/BHP",
      deepLinkAnchor: "BHP short interest",
    });
    expect(buildEmbedSnippet({ kind: "top-shorts" })).toMatchObject({
      deepLink: "https://shorted.com.au/top",
      deepLinkAnchor: "most shorted ASX stocks",
    });
    expect(buildEmbedSnippet({ kind: "treemap" })).toMatchObject({
      deepLink: "https://shorted.com.au/industry-intelligence",
      deepLinkAnchor: "ASX short positions by industry",
    });
    expect(buildEmbedSnippet({ kind: "basket" })).toMatchObject({
      deepLink: "https://shorted.com.au/statistics",
      deepLinkAnchor: "ASX short selling statistics",
    });
  });

  it("upper-cases and encodes the ticker", () => {
    const s = buildEmbedSnippet({ kind: "chart", code: " bhp " });
    expect(s.iframeSrc).toBe("https://shorted.com.au/embed/chart?code=BHP");
    expect(s.deepLink).toBe("https://shorted.com.au/shorts/BHP");
    expect(s.title).toBe("BHP short interest — Shorted.com.au");
  });

  it("omits optional params rather than emitting undefined", () => {
    expect(buildEmbedSnippet({ kind: "top-shorts" }).iframeSrc).toBe(
      "https://shorted.com.au/embed/top-shorts",
    );
    expect(buildEmbedSnippet({ kind: "top-shorts", limit: 25 }).iframeSrc).toBe(
      "https://shorted.com.au/embed/top-shorts?limit=25",
    );
    expect(buildEmbedSnippet({ kind: "treemap", period: "6m" }).iframeSrc).toBe(
      "https://shorted.com.au/embed/treemap?period=6m",
    );
    for (const target of ALL_TARGETS) {
      expect(buildEmbedSnippet(target).iframeSrc).not.toContain("undefined");
    }
  });

  it("names each widget for the dialog copy", () => {
    expect(embedNoun({ kind: "chart", code: "BHP" })).toBe("chart");
    expect(embedNoun({ kind: "top-shorts" })).toBe("table");
    expect(embedNoun({ kind: "treemap" })).toBe("heatmap");
  });

  it("names each chart view by its subject, deep-linking to the stock page", () => {
    expect(buildEmbedSnippet({ kind: "chart", code: "BHP", view: "short" })).toMatchObject({
      title: "BHP short interest — Shorted.com.au",
      deepLinkAnchor: "BHP short interest",
      deepLink: "https://shorted.com.au/shorts/BHP",
      height: 480,
    });
    expect(buildEmbedSnippet({ kind: "chart", code: "BHP", view: "price" })).toMatchObject({
      title: "BHP share price — Shorted.com.au",
      deepLinkAnchor: "BHP share price",
      deepLink: "https://shorted.com.au/shorts/BHP",
      height: 480,
    });
    expect(buildEmbedSnippet({ kind: "chart", code: "BHP", view: "combined" })).toMatchObject({
      title: "BHP share price and short interest — Shorted.com.au",
      deepLinkAnchor: "BHP share price and short interest",
      deepLink: "https://shorted.com.au/shorts/BHP",
      height: 520,
    });
  });

  it("carries view and period in the iframe URL", () => {
    expect(
      buildEmbedSnippet({ kind: "chart", code: "BHP", view: "combined", period: "1y" }).iframeSrc,
    ).toBe("https://shorted.com.au/embed/chart?code=BHP&view=combined");
    expect(
      buildEmbedSnippet({ kind: "chart", code: "BHP", view: "price", period: "3m" }).iframeSrc,
    ).toBe("https://shorted.com.au/embed/chart?code=BHP&view=price&period=3m");
    expect(
      buildEmbedSnippet({ kind: "chart", code: "BHP", view: "short", period: "max" }).iframeSrc,
    ).toBe("https://shorted.com.au/embed/chart?code=BHP&period=max");
  });

  it("keeps every pre-existing chart snippet byte-identical (backwards compatible)", () => {
    // Snippets copied before views existed are pasted on other people's pages;
    // the short/1y defaults must build exactly what `{ code }` alone always did.
    const legacyHtml = [
      `<figure style="margin:0">`,
      `  <iframe src="https://shorted.com.au/embed/chart?code=BHP" width="100%" height="480" loading="lazy" frameborder="0" title="BHP short interest — Shorted.com.au"></iframe>`,
      `  <figcaption style="font:14px/1.4 system-ui,sans-serif;margin-top:8px">`,
      `    <a href="https://shorted.com.au/shorts/BHP">BHP short interest</a> — data from <a href="https://shorted.com.au">Shorted.com.au</a>, sourced from ASIC short position reports`,
      `  </figcaption>`,
      `</figure>`,
    ].join("\n");
    expect(buildEmbedSnippet({ kind: "chart", code: "BHP" }).html).toBe(legacyHtml);
    expect(
      buildEmbedSnippet({ kind: "chart", code: "BHP", view: "short", period: "1y" }).html,
    ).toBe(legacyHtml);
  });

  it("credits the data source each view actually draws", () => {
    expect(buildEmbedSnippet({ kind: "chart", code: "BHP", view: "price" }).html).toContain(
      "sourced from end-of-day ASX prices",
    );
    expect(buildEmbedSnippet({ kind: "chart", code: "BHP", view: "combined" }).html).toContain(
      "sourced from ASIC short position reports and end-of-day ASX prices",
    );
    expect(buildEmbedSnippet({ kind: "top-shorts" }).html).toContain(
      "sourced from ASIC short position reports",
    );
  });

  it("calls every chart view a chart", () => {
    for (const view of ["short", "price", "combined"] as const) {
      expect(embedNoun({ kind: "chart", code: "BHP", view })).toBe("chart");
    }
  });
});
