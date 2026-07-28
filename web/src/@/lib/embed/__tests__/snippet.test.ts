import { buildEmbedSnippet, embedNoun, type EmbedTarget } from "../snippet";

const ALL_TARGETS: EmbedTarget[] = [
  { kind: "chart", code: "BHP" },
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
});
