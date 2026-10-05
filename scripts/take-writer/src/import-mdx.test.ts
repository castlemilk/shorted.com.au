import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertValidSlug, findContentBySlug, importMdx, parseTakeMdx, validateImportedTake } from "./import-mdx";

const pg = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }));
vi.mock("pg", () => ({ Client: vi.fn(() => pg) }));

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

  it("decodes escaped headline punctuation and only reads top-level fields", () => {
    const src = VALID.replace('headline: "A headline"', 'headline: "Telix says \\"Fast Track\\""\n  headline: "Nested text"');
    expect(parseTakeMdx(src).frontmatter.headline).toBe('Telix says "Fast Track"');
  });
});

const CITATION = { refId: "ref-1", url: "https://www.asic.gov.au/report", source: "ASIC", headline: "Dated position report", date: "2026-09-28", type: "report" };
function newsroomArticle(citations: unknown = [CITATION], body = '<StatGroup>\n<Stat label="Short interest" value="15.17%" cite="ref-1" />\n</StatGroup>\n\nPosition baseline [ref-1].\n\n<ShortInterestChart code="DRO" window="3m" />') {
  return `---\nslug: "a-slug"\nheadline: "A headline"\nstockCode: "DRO"\nbodyFormat: "mdx"\ncitations: ${JSON.stringify(citations)}\n---\n\n${body}\n`;
}

describe("grounded newsroom imports", () => {
  it("accepts the actual newsroom components and preserves source IDs/URLs", async () => {
    const parsed = parseTakeMdx(newsroomArticle());
    expect(parsed.frontmatter.citations).toEqual([CITATION]);
    await expect(validateImportedTake(parsed)).resolves.toBeUndefined();
  });

  it.each([
    ["duplicate references", [CITATION, CITATION]],
    ["malformed reference", [{ ...CITATION, refId: "bad-id" }]],
    ["executable URL", [{ ...CITATION, url: "javascript:alert(1)" }]],
    ["missing source fields", [{ refId: "ref-1" }]],
  ])("rejects %s before import", (_case, citations) => {
    expect(() => parseTakeMdx(newsroomArticle(citations))).toThrow();
  });

  it("fails loudly on unsupported multiline citation frontmatter", () => {
    const src = newsroomArticle().replace(`citations: ${JSON.stringify([CITATION])}`, 'citations:\n  - refId: ref-1');
    expect(() => parseTakeMdx(src)).toThrow(/JSON array on one line/);
  });

  it.each([
    ["uncited stat", '<Stat label="Short" value="15%" cite="ref-2" />'],
    ["uncited prose", 'Position [ref-2].'],
    ["wrong stock", '<ShortInterestChart code="TLX" window="3m" />'],
    ["invalid chart window", '<ShortInterestChart code="DRO" window="5y" />'],
    ["script", '<script>alert(1)</script>'],
    ["mixed legacy components", '<CitationPill id="1" />\n<Stat label="Short" value="15%" />'],
  ])("rejects %s through the shared gate", async (_case, body) => {
    await expect(validateImportedTake(parseTakeMdx(newsroomArticle([CITATION], body)))).rejects.toThrow();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    pg.query.mockResolvedValue({ rows: [{ slug: "a-slug", published_at: null }] });
  });

  it("persists the citation JSON alongside the draft without publishing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grounded-import-"));
    const file = join(dir, "article.mdx");
    writeFileSync(file, newsroomArticle());
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@127.0.0.1:65535/test");
    try {
      await importMdx({ file });
      expect(pg.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pg.query.mock.calls[0]!;
      expect(sql).toContain("citations");
      expect(sql).not.toMatch(/SET\s+published_at/i);
      expect(JSON.parse(params[11])).toEqual([CITATION]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("validates dry runs and rejects unresolved sources before connecting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "invalid-import-"));
    const file = join(dir, "article.mdx");
    writeFileSync(file, newsroomArticle([CITATION], "Position [ref-2]."));
    await expect(importMdx({ file, dryRun: true })).rejects.toThrow(/missing/);
    expect(pg.connect).not.toHaveBeenCalled();
  });
});

describe("assertValidSlug", () => {
  it("accepts lowercase kebab-case", () => {
    expect(() => assertValidSlug("us-bond-rout-australia-banks-property-shorts")).not.toThrow();
    expect(() => assertValidSlug("q3-2026")).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["uppercase", "US-bond"],
    ["path traversal", "../etc/passwd"],
    ["a flag", "--dir=/"],
    ["whitespace", "a slug"],
    ["leading hyphen", "-a"],
    ["double hyphen", "a--b"],
    ["too long", "a".repeat(121)],
  ])("rejects %s", (_label, slug) => {
    expect(() => assertValidSlug(slug)).toThrow(/invalid slug/);
  });
});

describe("findContentBySlug", () => {
  function dirWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "content-"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  it("matches on the frontmatter slug, not the file name", () => {
    const dir = dirWith({ "renamed-file.mdx": VALID, "other.mdx": VALID.replace("a-slug", "b-slug") });
    const { file, parsed } = findContentBySlug(dir, "a-slug");
    expect(file).toBe(join(dir, "renamed-file.mdx"));
    expect(parsed.frontmatter.headline).toBe("A headline");
  });

  it("skips a broken sibling instead of failing the publish", () => {
    const dir = dirWith({ "good.mdx": VALID, "broken.mdx": "no frontmatter" });
    expect(findContentBySlug(dir, "a-slug").file).toBe(join(dir, "good.mdx"));
  });

  it("says the article is not merged when nothing matches", () => {
    const dir = dirWith({ "good.mdx": VALID });
    expect(() => findContentBySlug(dir, "missing-slug")).toThrow(/merged to main/);
  });

  it("refuses a slug claimed by two files", () => {
    const dir = dirWith({ "one.mdx": VALID, "two.mdx": VALID });
    expect(() => findContentBySlug(dir, "a-slug")).toThrow(/claimed by 2 files/);
  });

  it("validates the slug before touching the filesystem", () => {
    expect(() => findContentBySlug("/nonexistent", "../x")).toThrow(/invalid slug/);
  });
});
