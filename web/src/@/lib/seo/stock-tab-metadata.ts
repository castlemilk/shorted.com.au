import type { Metadata } from "next";
import { siteConfig } from "~/@/config/site";
import { formatCompanyName } from "~/@/lib/company-name";
import { isStockIndexable } from "~/@/lib/seo/stock-indexability";
import { stockTabHref, type StockTabId } from "~/@/lib/stocks/stock-tabs";
import { getStock } from "~/app/actions/getStock";

export interface StockTabMetadataInput {
  /** Upper-cased by the caller (upper-cased again here, defensively). */
  code: string;
  tab: StockTabId;
  /** Receives the cleaned company name; returns the title WITHOUT "| Shorted". */
  title: (company: string) => string;
  description: (company: string) => string;
  keywords?: string[];
  /** Extra reason to noindex (Strategy: not in universe; Community: always). */
  forceNoindex?: boolean;
  /**
   * Extra reason to noindex that needs the stock record (Short interest: ASIC
   * reports no short position, so the tab is one sentence). Called ONLY when
   * the stock read resolved. A stock that could not be read fails open, as the
   * isStockIndexable gate does, so a getStock outage can never noindex a tab: a
   * `forceNoindex` computed from "no short position" before the read would.
   */
  noindexWhen?: (stock: { percentageShorted: number }) => boolean;
}

const NOINDEX = {
  index: false,
  follow: true,
  googleBot: { index: false, follow: true },
} as const;

/**
 * The stock's social card, the same object on every tab. A page that sets
 * `openGraph` replaces the segment's file-based opengraph-image, so each tab
 * names the card itself, exactly as the Overview does. `p` is a
 * content-addressed version: it moves with the short percentage, so the card
 * refreshes when the data does and is served from cache otherwise.
 */
export function stockOgImage(code: string, percentShorted?: number | null) {
  const version =
    percentShorted != null && percentShorted > 0
      ? percentShorted.toFixed(2)
      : "default";
  return {
    url: `${siteConfig.url}/shorts/${code}/opengraph-image?p=${version}`,
    width: 1200,
    height: 630,
    alt: `${code} short position — ${siteConfig.name}`,
  };
}

/**
 * Metadata for one stock tab. The robots gate is the stock page's own
 * (isStockIndexable) so a thin, noindexed stock never leaks an indexable tab;
 * a transient read fails OPEN, exactly as /news does. The cleaned company
 * name feeds the title; the raw ASIC string would shout.
 */
export async function stockTabMetadata(
  input: StockTabMetadataInput,
): Promise<Metadata> {
  const code = input.code.toUpperCase();
  let company = code;
  let percentShorted: number | undefined;
  let noindex = input.forceNoindex === true;
  try {
    const stock = await getStock(code);
    if (stock) {
      company = formatCompanyName(stock.name ?? "", code) || code;
      percentShorted = stock.percentageShorted;
      if (
        !isStockIndexable({
          code,
          name: stock.name,
          industry: stock.industry,
          percentShorted: stock.percentageShorted,
        })
      ) {
        noindex = true;
      }
      if (input.noindexWhen?.(stock)) noindex = true;
    }
  } catch {
    // fail open — keep default robots
  }
  const url = `${siteConfig.url}${stockTabHref(code, input.tab)}`;
  const title = input.title(company);
  const description = input.description(company);
  const ogImage = stockOgImage(code, percentShorted);
  return {
    title,
    description,
    keywords: input.keywords,
    // The key is OMITTED when the tab is indexable, never set to undefined:
    // Next 14.2 merges metadata with `for (key in source)`, so an own `robots`
    // key holding undefined resolves to null and replaces the root layout's
    // robots (index/follow plus the googleBot max-image-preview, max-snippet
    // and max-video-preview directives). Absent, the tab inherits them.
    ...(noindex ? { robots: NOINDEX } : {}),
    alternates: {
      canonical: url,
      languages: { "en-AU": url, en: url, "x-default": url },
    },
    openGraph: {
      title: `${title} | ${siteConfig.name}`,
      description,
      url,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
      images: [ogImage],
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title: `${title} | ${siteConfig.name}`,
      description,
      images: [ogImage],
    },
  };
}
