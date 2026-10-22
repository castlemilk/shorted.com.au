/// <reference types="jest" />
import { beforeEach, describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react";

/**
 * A take's snippet and title. Every probed take's meta, Open Graph, Twitter
 * and NewsArticle description opened with raw Markdown ("[Boss Energy]
 * (/shorts/BOE) was…"), titles ran 96-115 characters ("<headline> — Shorted
 * Take | Shorted"), and NewsArticle.about was a Corporation with no name
 * (2026-10-21, seo-review finding 6).
 */

jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
jest.mock("~/app/actions/getEditorialTake", () => ({ getEditorialTakeOrNotFound: jest.fn() }));
jest.mock("~/app/actions/getStock", () => ({ getStock: jest.fn() }));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
  BreadcrumbStructuredData: () => null,
}));
jest.mock("~/@/components/seo/llm-meta", () => ({ LLMMeta: () => null }));
jest.mock("~/@/components/news/article-header", () => ({ ArticleHeader: () => null }));
jest.mock("~/@/components/news/editorial-markdown", () => ({ EditorialMarkdown: () => null }));
jest.mock("~/@/components/news/take-related", () => ({ TakeRelated: () => null }));
jest.mock("~/@/components/news/take-body", () => ({ TakeBody: () => null }));
jest.mock("~/@/components/news/mdx-take-body", () => ({ MdxTakeBody: () => null }));

import { getEditorialTakeOrNotFound } from "~/app/actions/getEditorialTake";
import { getStock } from "~/app/actions/getStock";
import { NotFoundError } from "~/app/actions/withRetry";
import ShortedTakePage, { generateMetadata } from "../page";

const mockTake = getEditorialTakeOrNotFound as jest.Mock;
const mockStock = getStock as jest.Mock;

const BOE_HEADLINE = "Boss Energy's short position rebuilt from 8.46% to 13.58% in five weeks";
// The published take's opening, as body_md carries it.
const BOE_BODY = [
  "[Boss Energy](/shorts/BOE) was **13.58%** shorted on **30 September**, 56,391,194 of 415,198,998 shares in ASIC's daily aggregate file. Among ordinary shares in that file, only [DroneShield](/shorts/DRO) at 15.07% sits higher. [ref-1] Shorted's four-week change is the largest in the sector.",
  "The position has made more than a round trip. It was 11.96% on **1 July** [ref-2].",
].join("\n\n");

function take(overrides: Record<string, unknown> = {}) {
  return {
    slug: "boe-shorts-rebuild-to-13-6pc-new-chair-honeymoon-plan",
    headline: BOE_HEADLINE,
    stockCode: "BOE",
    bodyMd: BOE_BODY,
    bodyFormat: "mdx",
    publishedAt: { seconds: BigInt(Date.UTC(2026, 9, 6) / 1000) },
    citations: [],
    layoutImages: [],
    inlineImages: [],
    sourceUrl: "",
    ...overrides,
  };
}

const params = Promise.resolve({ slug: "boe-shorts-rebuild-to-13-6pc-new-chair-honeymoon-plan" });

async function newsArticle(): Promise<Record<string, unknown>> {
  const { container } = render(await ShortedTakePage({ params }));
  const found = Array.from(container.querySelectorAll('script[type="application/ld+json"]'))
    .map((script) => JSON.parse(script.innerHTML) as Record<string, unknown>)
    .find((json) => json["@type"] === "NewsArticle");
  if (!found) throw new Error("the take renders no NewsArticle");
  return found;
}

describe("news take metadata", () => {
  beforeEach(() => {
    mockTake.mockReset();
    mockStock.mockReset();
    mockTake.mockResolvedValue({ take: take() });
    mockStock.mockResolvedValue({ name: "BOSS ENERGY LTD ORDINARY" });
  });

  it("describes the take with its links' text, not their Markdown", async () => {
    const meta = await generateMetadata({ params });
    const description = String(meta.description);
    expect(description).toMatch(/^Boss Energy was 13\.58% shorted on 30 September, 56,391,194/);
    for (const raw of ["](", "**", "[ref-"]) expect(description).not.toContain(raw);
    // Truncated at a word boundary, after the links are gone.
    expect(description).toMatch(/ only…$/);
    expect(description.length).toBeLessThanOrEqual(156);
    expect(meta.openGraph?.description).toBe(description);
    expect(meta.twitter?.description).toBe(description);
  });

  it("closes the gap a removed citation marker leaves", async () => {
    const bodyMd =
      "Only [DroneShield](/shorts/DRO) at 15.07% sits higher [ref-1]. It was 11.96% on **1 July**. [ref-2]";
    mockTake.mockResolvedValue({ take: take({ bodyMd }) });
    const meta = await generateMetadata({ params });
    expect(meta.description).toBe("Only DroneShield at 15.07% sits higher. It was 11.96% on 1 July.");
  });

  it("titles the take by its headline alone, without the brand", async () => {
    const meta = await generateMetadata({ params });
    expect(meta.title).toEqual({ absolute: BOE_HEADLINE });
    expect(meta.openGraph?.title).toBe(BOE_HEADLINE);
  });

  // Each of takeTitle's limits from both sides: a headline is cut only past
  // 80 characters, and then only to a first clause of 30 to 70 characters.
  // The case names are counted from the fixtures, so they cannot drift.
  function headlineCase(clause: string, separator: string, rest: string, cut: boolean) {
    const headline = `${clause}${separator}${rest}`;
    return {
      headline,
      title: cut ? clause : headline,
      length: headline.length,
      clauseLength: clause.length,
      outcome: cut ? "cut to its first clause" : "kept whole",
    };
  }

  it.each([
    headlineCase("Boss Energy's short position rebuilt to 13.58%", "; ", "the price fell 12% in five weeks", false),
    headlineCase("Boss Energy shorts reach 13.6%", " – ", "the price fell 9% while the new chair settled in", true),
    headlineCase("Boss Energy shorts hit 13.58%", "; ", "the price fell 12.5% while the new chair settled in", false),
    headlineCase(
      "The Lottery Corporation's short position doubled to 8.63% in six weeks",
      " — ",
      "and the bears added more",
      true,
    ),
    headlineCase(
      "The Lottery Corporation's short position doubled to 8.6% in eight weeks",
      "; ",
      "the bears added more",
      false,
    ),
  ])(
    "a headline of $length characters, first clause $clauseLength: $outcome",
    async ({ headline, title }) => {
      mockTake.mockResolvedValue({ take: take({ headline }) });
      const meta = await generateMetadata({ params });
      expect(meta.title).toEqual({ absolute: title });
      expect(meta.openGraph?.title).toBe(headline);
    },
  );

  it("cuts a long headline to its first clause", async () => {
    const headline =
      "EOS short position more than doubled to 10.15% in a quarter; the price rose 25% in a month";
    mockTake.mockResolvedValue({ take: take({ headline }) });
    const meta = await generateMetadata({ params });
    expect(meta.title).toEqual({
      absolute: "EOS short position more than doubled to 10.15% in a quarter",
    });
    // The social cards keep it whole.
    expect(meta.openGraph?.title).toBe(headline);
  });

  it("keeps a long headline with no clause break whole", async () => {
    const headline =
      "Short sellers are building against Australia's banks as the US bond rout crosses the Pacific";
    mockTake.mockResolvedValue({ take: take({ headline }) });
    const meta = await generateMetadata({ params });
    expect(meta.title).toEqual({ absolute: headline });
  });

  it("skips an MDX component block and strips component tags", async () => {
    const bodyMd = [
      "<StatGroup>",
      '<Stat label="Short interest" value="13.58%" context="Position date 30 September 2026; 56,391,194 of 415,198,998 shares" cite="ref-1" />',
      "</StatGroup>",
      "",
      "<PullQuote>A reported position is a count, not a motive.</PullQuote> The rest follows.",
    ].join("\n");
    mockTake.mockResolvedValue({ take: take({ bodyMd }) });
    const meta = await generateMetadata({ params });
    expect(meta.description).toBe("A reported position is a count, not a motive. The rest follows.");
  });

  it("names the company the NewsArticle is about, with the same clean description", async () => {
    const json = await newsArticle();
    expect(json.about).toEqual({
      "@type": "Corporation",
      name: "Boss Energy",
      tickerSymbol: "BOE",
      sameAs: "https://www.asx.com.au/markets/company/BOE",
    });
    expect(String(json.description)).toMatch(/^Boss Energy was 13\.58% shorted/);
  });

  it("names it by its code when the stock read fails", async () => {
    mockStock.mockResolvedValue(undefined);
    const json = await newsArticle();
    expect((json.about as { name?: string }).name).toBe("BOE");
  });
});

// The page is on-demand ISR, and ISR caches whatever a regeneration renders:
// a 404 and a noindex "Take not found" title for a failed read would replace a
// live take for 600 s. A failed read (undefined from
// getEditorialTakeOrNotFound) must FAIL the render, which keeps the last good
// page; only the API's NotFound is a 404.
describe("news take when the read fails", () => {
  beforeEach(() => {
    mockTake.mockReset();
    mockStock.mockReset();
    mockStock.mockResolvedValue({ name: "BOSS ENERGY LTD ORDINARY" });
  });

  it("fails the metadata and the render instead of answering 404", async () => {
    mockTake.mockResolvedValue(undefined);

    await expect(generateMetadata({ params })).rejects.toThrow(/transiently unavailable/);
    await expect(ShortedTakePage({ params })).rejects.toThrow(/transiently unavailable/);
  });

  it("answers a slug the API does not know with a noindexed 404", async () => {
    mockTake.mockRejectedValue(new NotFoundError("editorial take not found"));

    expect(await generateMetadata({ params })).toEqual({
      title: "Take not found",
      robots: { index: false, follow: false },
    });
    await expect(ShortedTakePage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("lets any other error through untouched", async () => {
    const outage = new Error("socket hang up");
    mockTake.mockRejectedValue(outage);

    await expect(ShortedTakePage({ params })).rejects.toBe(outage);
  });
});
