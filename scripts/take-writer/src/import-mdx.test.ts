import { describe, expect, it } from "vitest";
import { parseTakeMdx } from "./import-mdx";

const VALID = `---
slug: "a-slug"
headline: "A headline"
standfirst: "A standfirst"
byline: "Ben Ebsworth"
stockCode: "DRO"
tier: "deep_dive"
bodyFormat: "mdx"
ogImageUrl: "/assets/news/a-slug/cover.png"
---

Body paragraph with **bold** and a [link](/shorts/DRO).

| a | b |
|---|---|
| 1 | 2 |
`;

describe("parseTakeMdx", () => {
  it("parses the frontmatter contract", () => {
    const { frontmatter, wordCount } = parseTakeMdx(VALID);
    expect(frontmatter.slug).toBe("a-slug");
    expect(frontmatter.headline).toBe("A headline");
    expect(frontmatter.stockCode).toBe("DRO");
    expect(frontmatter.tier).toBe("deep_dive");
    expect(frontmatter.bodyFormat).toBe("mdx");
    expect(wordCount).toBeGreaterThan(5);
  });

  it("strips the surrounding quotes but keeps inner punctuation", () => {
    const src = VALID.replace('headline: "A headline"', 'headline: "DroneShield: 2.21% to 14.98%"');
    expect(parseTakeMdx(src).frontmatter.headline).toBe("DroneShield: 2.21% to 14.98%");
  });

  it("allows a market-wide article with no stock code", () => {
    // Housing and macro pieces legitimately have none, and stock_code is
    // nullable in editorial_takes.
    const src = VALID.replace('stockCode: "DRO"\n', "");
    expect(parseTakeMdx(src).frontmatter.stockCode).toBeUndefined();
  });

  it("rejects a file with no frontmatter", () => {
    expect(() => parseTakeMdx("just a body")).toThrow(/frontmatter/);
  });

  it("requires slug and headline", () => {
    expect(() => parseTakeMdx(VALID.replace('slug: "a-slug"\n', ""))).toThrow(/slug/);
    expect(() => parseTakeMdx(VALID.replace('headline: "A headline"\n', ""))).toThrow(/headline/);
  });

  it("rejects an empty body", () => {
    expect(() => parseTakeMdx('---\nslug: "s"\nheadline: "h"\n---\n\n')).toThrow(/body is empty/);
  });

  // --- the one that matters -------------------------------------------------

  it("rejects components the /news renderer cannot render", () => {
    // This is the whole reason the check exists: an unknown component renders
    // as NOTHING, silently. <Info> and <RegisterEmail> are blog-template
    // components, and three articles were originally written with them.
    const withInfo = VALID.replace("Body paragraph", '<Info title="x">y</Info>\n\nBody paragraph');
    expect(() => parseTakeMdx(withInfo)).toThrow(/Info/);

    const withCta = VALID.replace("Body paragraph", "<RegisterEmail />\n\nBody paragraph");
    expect(() => parseTakeMdx(withCta)).toThrow(/RegisterEmail/);
  });

  it("permits the citation components the renderer does map", () => {
    const withCite = VALID.replace("Body paragraph", '<CitationPill id="1" />\n\nBody paragraph');
    expect(() => parseTakeMdx(withCite)).not.toThrow();
  });

  it("does not mistake lowercase HTML tags for components", () => {
    const withHtml = VALID.replace("Body paragraph", "<sup>1</sup>\n\nBody paragraph");
    expect(() => parseTakeMdx(withHtml)).not.toThrow();
  });
});
