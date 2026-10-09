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
    robots: noindex ? NOINDEX : undefined,
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
